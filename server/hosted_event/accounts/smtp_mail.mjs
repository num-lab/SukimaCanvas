import nodemailer from "nodemailer";

import observability from "../../observability/index.mjs";
import { isValidNormalizedEmail, normalizeEmail } from "./emails.mjs";

const { logger } = observability;

/** @import { ServerConfig } from "../../../types/server-runtime.d.ts" */

/**
 * SMTP mail delivery for account and lifecycle notices.
 *
 * The adapter speaks ordinary authenticated SMTP over implicit TLS, so the
 * mail vendor is a configuration choice rather than a code change. The
 * defaults are Cloudflare Email Service's submission endpoint
 * (`smtp.mx.cloudflare.net:465`, username `api_token`, password a Cloudflare
 * API token carrying Email Sending: Edit), and any other provider works by
 * pointing the host, port, and credentials elsewhere. That portability is the
 * reason this is SMTP rather than a vendor REST API: the first release
 * operates in mainland China, where the sending vendor is the component most
 * likely to be replaced.
 *
 * Delivery is one connection per message. The service sends a handful of
 * messages per event, the notice queue already serializes and retries them,
 * and a per-message connection cannot rot or leak a descriptor between
 * events.
 *
 * Failures throw. The notification service treats that as a retryable
 * delivery attempt: the notice stays queued with backoff and appears on the
 * operator console with its recipient and last error, so a vendor outage is
 * observable rather than lost mail. Nothing this adapter throws or logs
 * carries the credential.
 */

/** Cloudflare Email Service submission endpoint. */
const DEFAULT_SMTP_HOST = "smtp.mx.cloudflare.net";
/** Implicit TLS. Cloudflare does not offer STARTTLS on 587 or relay on 25. */
const DEFAULT_SMTP_PORT = 465;
/** Cloudflare authenticates the API token under this literal username. */
const DEFAULT_SMTP_USER = "api_token";
/** Cloudflare advertises a 5 MiB SIZE limit; refuse locally rather than earn a 552. */
const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
/** A blocked network must fail into the retry queue, not stall the drain pass. */
const CONNECTION_TIMEOUT_MS = 15_000;
const GREETING_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 60_000;
/** Hosts for which an unencrypted connection cannot leak the credential off-box. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Reduces a transport failure to a message that names the SMTP outcome and
 * nothing else. Vendor errors carry the server's own reply, which is safe and
 * is what an operator needs; the credential lives only in the transport
 * options and must never reach a log line or the operator console.
 *
 * @param {unknown} error
 * @returns {{code: string, detail: string}}
 */
function describeTransportFailure(error) {
  const failure =
    /** @type {{responseCode?: unknown, code?: unknown, response?: unknown, message?: unknown}} */ (
      error || {}
    );
  const responseCode =
    typeof failure.responseCode === "number"
      ? String(failure.responseCode)
      : typeof failure.code === "string"
        ? failure.code
        : "unknown";
  const response =
    typeof failure.response === "string" && failure.response !== ""
      ? failure.response
      : typeof failure.message === "string"
        ? failure.message
        : "";
  return { code: responseCode, detail: response };
}

/**
 * @param {ServerConfig} config
 * @returns {{host: string, port: number, secure: boolean, user: string, password: string, from: string, fromName: string}}
 */
function readSmtpSettings(config) {
  const host = String(config.HOSTED_SMTP_HOST || DEFAULT_SMTP_HOST).trim();
  const port = Number(config.HOSTED_SMTP_PORT ?? DEFAULT_SMTP_PORT);
  const secure = config.HOSTED_SMTP_TLS !== false;
  const user = String(config.HOSTED_SMTP_USER || DEFAULT_SMTP_USER).trim();
  const password = String(config.HOSTED_SMTP_PASSWORD || "");
  const from = normalizeEmail(String(config.HOSTED_MAIL_FROM || ""));
  const fromName = String(config.HOSTED_MAIL_FROM_NAME || "").trim();

  // Fail closed at composition. A deployment that cannot send mail cannot
  // verify an account, so booting into a half-working state would strand
  // every registration behind a message that never arrives.
  if (from === "" || !isValidNormalizedEmail(from)) {
    throw new Error(
      "SMTP mail delivery requires a valid WBO_HOSTED_MAIL_FROM address",
    );
  }
  if (password === "") {
    throw new Error(
      "SMTP mail delivery requires WBO_HOSTED_SMTP_PASSWORD (the vendor API token or password)",
    );
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid WBO_HOSTED_SMTP_PORT: ${String(port)}`);
  }
  // Without TLS the credential crosses the wire in the clear. Allow it only
  // where it cannot leave the machine — a local stub in tests — and refuse it
  // for anything routable.
  if (!secure && !LOOPBACK_HOSTS.has(host.toLowerCase())) {
    throw new Error(
      `Refusing unencrypted SMTP to ${host}: WBO_HOSTED_SMTP_TLS may only be disabled for a loopback host`,
    );
  }
  return { host, port, secure, user, password, from, fromName };
}

/**
 * A stable Message-ID derived from the notice's own idempotency id, so a
 * redelivery after a crash presents the same identity to the receiving
 * mailbox instead of reading as a second, unrelated message. Messages without
 * an id fall back to the transport's generated identifier.
 *
 * @param {string | undefined} id
 * @param {string} fromAddress
 * @returns {string | undefined}
 */
function stableMessageId(id, fromAddress) {
  const normalized = String(id || "").replace(/[^A-Za-z0-9._-]/g, "-");
  if (normalized === "") return undefined;
  const domain = fromAddress.slice(fromAddress.lastIndexOf("@") + 1);
  if (domain === "") return undefined;
  return `<${normalized}@${domain}>`;
}

/**
 * @param {ServerConfig} config
 * @param {{createTransport?: typeof nodemailer.createTransport}} [dependencies]
 * @returns {{send: (message: {id?: string, to: string, subject: string, body: string}) => Promise<void>}}
 */
function createSmtpMailDelivery(config, dependencies = {}) {
  const settings = readSmtpSettings(config);
  const createTransport =
    dependencies.createTransport || nodemailer.createTransport;
  const transport = createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: { user: settings.user, pass: settings.password },
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  });

  /**
   * @param {{id?: string, to: string, subject: string, body: string}} message
   * @returns {Promise<void>}
   */
  async function send(message) {
    const to = normalizeEmail(message.to);
    if (!isValidNormalizedEmail(to)) {
      throw new Error("smtp mail delivery requires a valid recipient");
    }
    const subject = String(message.subject || "");
    const body = String(message.body || "");
    if (subject === "" || body === "") {
      throw new Error("smtp mail delivery requires a subject and body");
    }
    // Notices are composed bilingually and can be long; refuse an oversized
    // message here with a deterministic error instead of spending a
    // connection to be told 552 by the vendor.
    const bodyBytes = Buffer.byteLength(body, "utf8");
    if (bodyBytes > MAX_MESSAGE_BYTES) {
      throw new Error(
        `smtp mail delivery refuses a ${bodyBytes} byte body over the ${MAX_MESSAGE_BYTES} byte limit`,
      );
    }

    try {
      await transport.sendMail({
        from: settings.fromName
          ? { name: settings.fromName, address: settings.from }
          : settings.from,
        to,
        subject,
        text: body,
        messageId: stableMessageId(message.id, settings.from),
      });
    } catch (error) {
      const failure = describeTransportFailure(error);
      logger.error("hosted.mail_delivery_failed", {
        transport: "smtp",
        smtp_host: settings.host,
        failure_code: failure.code,
        failure_detail: failure.detail,
      });
      throw new Error(
        `smtp mail delivery failed (${failure.code})${
          failure.detail ? `: ${failure.detail}` : ""
        }`,
      );
    }
  }

  return { send };
}

export {
  createSmtpMailDelivery,
  DEFAULT_SMTP_HOST,
  DEFAULT_SMTP_PORT,
  DEFAULT_SMTP_USER,
  MAX_MESSAGE_BYTES,
};
