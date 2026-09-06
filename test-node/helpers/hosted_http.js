/** Shared helpers for hosted account HTTP integration tests. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const { createConfig } = require("../test_helpers.js");
const { createServerApp } = require("../../server/server.mjs");
const {
  createServerRuntime,
} = require("../../server/runtime/create_runtime.mjs");

const CLIENT_WEBROOT = path.join(__dirname, "..", "..", "client-data");
const STRONG_PASSWORD = "correct horse battery staple";
const MAX_FORM_BODY_BYTES = 32 * 1024;

/**
 * @param {{[key: string]: any}} [overrides]
 * @returns {Promise<{app: import("http").Server, root: string, outboxDir: string, hostedEventModule: any}>}
 */
async function createHostedServer(overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wbo-hosted-accounts-"));
  const historyDir = path.join(root, "history");
  await fs.mkdir(historyDir);
  // Capture the composed hosted module so tests can drive the same durable
  // stores the running server consults (ban flows, membership checks).
  /** @type {{hostedEventModule?: any}} */
  const capturedRuntime = {};
  const app = await createServerApp(
    createConfig({
      HOST: "127.0.0.1",
      PORT: 0,
      HISTORY_DIR: historyDir,
      WEBROOT: CLIENT_WEBROOT,
      HOSTED_MODE: true,
      // Hosted mode fail-closes without a deployment secret: participant
      // identifier derivation requires one, exactly like production.
      AUTH_SECRET_KEY: "hosted-test-secret",
      HOSTED_DATA_DIR: path.join(root, "hosted-data"),
      // Node integration tests drive lifecycle advancement through requests, so
      // the background poker stays off unless a test opts in.
      HOSTED_LIFECYCLE_POLL_MS: 0,
      ...overrides,
    }),
    {
      runtime: (/** @type {any} */ runtimeConfig) => {
        const runtime = createServerRuntime(runtimeConfig);
        capturedRuntime.hostedEventModule = runtime.hostedEventModule;
        return runtime;
      },
      logStarted: false,
      socketsModule: {
        async start() {},
        async shutdown() {},
      },
    },
  );
  return {
    app,
    root,
    outboxDir: path.join(root, "hosted-data", "mail-outbox"),
    hostedEventModule: capturedRuntime.hostedEventModule,
  };
}

/**
 * @param {import("http").Server} app
 * @param {string} requestPath
 * @param {{method?: string, body?: string, headers?: {[key: string]: string}, cookie?: string, binary?: boolean}} [options]
 * @returns {Promise<{statusCode: number, headers: import("http").IncomingHttpHeaders, body: string, setCookie: string[]}>}
 */
function requestWithCookies(app, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const address = app.address();
    if (!address || typeof address === "string") {
      reject(new Error("server is not listening on a TCP port"));
      return;
    }
    const req = http.request(
      {
        host: "127.0.0.1",
        port: address.port,
        path: requestPath,
        method: options.method || "GET",
        agent: false,
        headers: {
          ...(options.body
            ? {
                "content-type": "application/x-www-form-urlencoded",
                "content-length": Buffer.byteLength(options.body),
              }
            : {}),
          ...(options.cookie ? { cookie: options.cookie } : {}),
          ...(options.headers || {}),
        },
      },
      (response) => {
        /** @type {string[]} */
        const chunks = [];
        // Binary bodies (e.g. export PNG downloads) read as latin1 so every
        // byte round-trips through the joined string.
        response.setEncoding(options.binary ? "latin1" : "utf8");
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            statusCode: response.statusCode || 0,
            headers: response.headers,
            body: chunks.join(""),
            setCookie: response.headers["set-cookie"] || [],
          }),
        );
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * @param {string} body
 * @param {string} name
 * @returns {string}
 */
function formValue(body, name) {
  const match = new RegExp(`name="${name}"[^>]*value="([^"]*)"`).exec(body);
  return match ? match[1] || "" : "";
}

/**
 * @param {string[]} setCookie
 * @param {string} name
 * @returns {string}
 */
function cookiePair(setCookie, name) {
  const cookie = setCookie.find((candidate) =>
    candidate.startsWith(`${name}=`),
  );
  assert.ok(cookie, `expected a ${name} cookie`);
  return cookie.split(";")[0] || "";
}

/**
 * @param {string[]} setCookie
 * @param {string} name
 * @returns {string}
 */
function cookieAttributes(setCookie, name) {
  const cookie = setCookie.find((candidate) =>
    candidate.startsWith(`${name}=`),
  );
  assert.ok(cookie, `expected a ${name} cookie`);
  return cookie;
}

/**
 * Completes verification for the account by reading the latest verification
 * email from the outbox dir.
 *
 * @param {import("http").Server} app
 * @param {string} outboxDir
 * @param {string} email
 */
async function verifyAccount(app, outboxDir, email) {
  const files = (await fs.readdir(outboxDir)).sort();
  for (let index = files.length - 1; index >= 0; index -= 1) {
    const message = JSON.parse(
      await fs.readFile(path.join(outboxDir, files[index] || ""), "utf8"),
    );
    if (message.to === email && message.body.includes("/verify?token=")) {
      const match = /https?:\/\/\S+/.exec(message.body);
      assert.ok(match);
      const url = new URL(match[0]);
      const verified = await requestWithCookies(
        app,
        `${url.pathname}${url.search}`,
      );
      assert.equal(verified.statusCode, 303);
      return;
    }
  }
  assert.fail(`no verification email for ${email}`);
}

/**
 * Registers an account through the composed server (age-confirmed, CAPTCHA
 * disabled by default in tests).
 *
 * @param {import("http").Server} app
 * @param {string} email
 * @param {string} password
 */
async function registerAccount(app, email, password) {
  const registerPage = await requestWithCookies(app, "/register?lang=en");
  const csrfCookie = cookiePair(registerPage.setCookie, "hosted-csrf-v1");
  const registered = await requestWithCookies(app, "/register", {
    method: "POST",
    cookie: csrfCookie,
    body: new URLSearchParams({
      _csrf: formValue(registerPage.body, "_csrf"),
      email,
      password,
      ageConfirmation: "1",
    }).toString(),
  });
  assert.equal(registered.statusCode, 200);
}

/**
 * Registers, verifies through the outbox link, and logs in, returning the
 * signed-in cookie jar.
 *
 * @param {import("http").Server} app
 * @param {string} outboxDir
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{sessionCookie: string, csrfCookie: string}>}
 */
async function signUpAndLogin(app, outboxDir, email, password) {
  await registerAccount(app, email, password);
  await verifyAccount(app, outboxDir, email);
  return loginSession(app, email, password);
}

/**
 * Logs a session in with its own cookie jar and returns both cookie pairs.
 *
 * @param {import("http").Server} app
 * @param {string} email
 * @param {string} password
 */
async function loginSession(app, email, password) {
  const loginPage = await requestWithCookies(app, "/login?lang=en");
  const csrfCookie = cookiePair(loginPage.setCookie, "hosted-csrf-v1");
  const loggedIn = await requestWithCookies(app, "/login", {
    method: "POST",
    cookie: csrfCookie,
    body: new URLSearchParams({
      _csrf: formValue(loginPage.body, "_csrf"),
      email,
      password,
    }).toString(),
  });
  assert.equal(loggedIn.statusCode, 303);
  return {
    sessionCookie: cookiePair(loggedIn.setCookie, "hosted-session-v1"),
    csrfCookie: cookiePair(loggedIn.setCookie, "hosted-csrf-v1"),
  };
}

module.exports = {
  CLIENT_WEBROOT,
  STRONG_PASSWORD,
  MAX_FORM_BODY_BYTES,
  createHostedServer,
  requestWithCookies,
  formValue,
  cookiePair,
  cookieAttributes,
  verifyAccount,
  registerAccount,
  signUpAndLogin,
  loginSession,
};
