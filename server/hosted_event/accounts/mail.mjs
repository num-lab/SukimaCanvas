import * as fs from "node:fs/promises";
import * as path from "node:path";
import crypto from "node:crypto";

import { isValidNormalizedEmail, normalizeEmail } from "./emails.mjs";
import { createSmtpMailDelivery } from "./smtp_mail.mjs";

/** @import { ServerConfig } from "../../../types/server-runtime.d.ts" */

/**
 * Durable outbox mail delivery.
 *
 * Lifecycle notices such as account verification are written as JSON files
 * into a configured outbox directory for an external sender to drain. This
 * is the default adapter and the fallback for a deployment that has not
 * configured a mail vendor: mail is queued somewhere durable rather than
 * dropped, but nothing here delivers it. A deployment that must actually
 * reach recipients selects the SMTP adapter instead — see
 * `createMailDelivery` below. Messages carry no credentials beyond the
 * single-use link the recipient needs.
 *
 * The notification service passes each message's stable notification id, so
 * a redelivery attempt after a crash rewrites the same file instead of
 * queueing a duplicate.
 *
 * @param {ServerConfig} config
 * @returns {{send: (message: {id?: string, to: string, subject: string, body: string}) => Promise<void>}}
 */
function createOutboxMailDelivery(config) {
  const outboxDir =
    config.HOSTED_MAIL_OUTBOX_DIR ||
    path.join(config.HOSTED_DATA_DIR, "mail-outbox");

  /**
   * @param {{id?: string, to: string, subject: string, body: string}} message
   * @returns {Promise<void>}
   */
  async function send(message) {
    const to = normalizeEmail(message.to);
    if (!isValidNormalizedEmail(to)) {
      throw new Error("outbox mail delivery requires a valid recipient");
    }
    const subject = String(message.subject || "");
    const body = String(message.body || "");
    if (subject === "" || body === "") {
      throw new Error("outbox mail delivery requires a subject and body");
    }
    const id = String(message.id || "")
      .replace(/[^A-Za-z0-9._-]/g, "-")
      .slice(0, 120);
    const fileName = `message-${
      id || `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`
    }.json`;
    await fs.mkdir(outboxDir, { recursive: true });
    await fs.writeFile(
      path.join(outboxDir, fileName),
      JSON.stringify(
        {
          to,
          subject,
          body,
          sentAtMs: Date.now(),
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  return { send };
}

/**
 * Selects the deployment's mail delivery adapter.
 *
 * `outbox` writes JSON files for an external sender to drain and is the
 * default, so a deployment that has not chosen a vendor still queues its mail
 * somewhere durable instead of dropping it. `smtp` hands messages to a real
 * SMTP vendor and fails closed at composition when it is not fully
 * configured — see `smtp_mail.mjs`.
 *
 * Both adapters honor the same contract: resolve on acceptance, throw on
 * failure, and let the notification service own queueing, idempotency, and
 * retry.
 *
 * @param {ServerConfig} config
 * @returns {{send: (message: {id?: string, to: string, subject: string, body: string}) => Promise<void>}}
 */
function createMailDelivery(config) {
  const transport = String(config.HOSTED_MAIL_TRANSPORT || "outbox")
    .trim()
    .toLowerCase();
  if (transport === "smtp") return createSmtpMailDelivery(config);
  if (transport !== "outbox") {
    throw new Error(
      `Unsupported WBO_HOSTED_MAIL_TRANSPORT: ${transport} (expected outbox or smtp)`,
    );
  }
  return createOutboxMailDelivery(config);
}

export { createMailDelivery, createOutboxMailDelivery };
