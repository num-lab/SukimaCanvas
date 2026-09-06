import {
  clearHostedCookie,
  HOSTED_SESSION_COOKIE_NAME,
  readHostedCookie,
  serializeHostedCookie,
} from "../../auth/hosted_cookies.mjs";
import { appendSetCookieHeader } from "../../auth/user_secret_cookie.mjs";
import { BoundaryError, badRequest } from "../../http/boundary_errors.mjs";
import { requestScheme } from "../../http/observation.mjs";
import { publicPath } from "../../http/request_url.mjs";
import observability from "../../observability/index.mjs";
import { resolveRequestClientIpSafe } from "../../socket/policy.mjs";
import {
  createFormSecurity,
  firstHeaderValue,
  readFormBody,
  seeOther,
  translate,
} from "../http_forms.mjs";
import { isValidNormalizedEmail, normalizeEmail } from "./emails.mjs";
import {
  hashPassword,
  verifyDummyPassword,
  verifyPassword,
} from "./passwords.mjs";
import { NOTICE_KINDS } from "../notifications/notices.mjs";

const { logger } = observability;

/** @import { HttpRequest, HttpResponse, HttpRouteContext, ServerConfig } from "../../../types/server-runtime.d.ts" */

/**
 * A hosted page template: the shared Template plus the hosted-only status
 * entry point used by the account flows.
 *
 * @typedef {import("../../http/templating.mjs").Template & {
 *   serveWithStatus: (request: HttpRequest, response: HttpResponse, statusCode: number, extraParams?: object) => {encoding?: unknown},
 * }} HostedTemplate
 */

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

/**
 * HTTP flows for hosted accounts: registration with email verification,
 * login, and logout. All inputs are hostile until validated; every failure is
 * a deterministic rendered response or boundary error, never a crash, and no
 * response, log line, or email ever carries a password, a password hash, or a
 * verification token.
 *
 * @param {{
 *   config: ServerConfig,
 *   store: ReturnType<typeof import("./store.mjs").createFileAccountStore>,
 *   notifications: import("../notifications/service.mjs").NotificationService,
 *   captcha: ReturnType<typeof import("./captcha.mjs").createHostedCaptcha>,
 *   limiter: ReturnType<typeof import("./rate_limits.mjs").createRateLimiter>,
 *   templates: {
 *     register: HostedTemplate,
 *     login: HostedTemplate,
 *     verify: HostedTemplate,
 *     logout: HostedTemplate,
 *     forgot: HostedTemplate,
 *     reset: HostedTemplate,
 *     account: HostedTemplate,
 *   },
 *   clock?: () => number,
 * }} dependencies
 */
function createHostedAccountRoutes(dependencies) {
  const { config, store, notifications, captcha, limiter, templates } =
    dependencies;
  const clock = dependencies.clock || (() => Date.now());
  const {
    cookieOptions,
    ensureCsrfToken,
    rotateCsrfToken,
    requestHasValidCsrf,
  } = createFormSecurity(config);

  /**
   * @param {HttpRouteContext} ctx
   * @returns {string}
   */
  function clientIp(ctx) {
    // Falls back to the direct remote address when the configured IP source
    // (for example X-Forwarded-For) is absent on a direct connection.
    return resolveRequestClientIpSafe(config, ctx.request);
  }

  /**
   * Rate-limit definitions per entry kind.
   *
   * @param {"register" | "login" | "forgot" | "reset"} kind
   * @returns {{limit: number, windowMs: number}}
   */
  function attemptLimits(kind) {
    if (kind === "register") {
      return {
        limit: config.HOSTED_REGISTER_ATTEMPTS_LIMIT,
        windowMs: config.HOSTED_REGISTER_ATTEMPTS_WINDOW_MS,
      };
    }
    if (kind === "login") {
      return {
        limit: config.HOSTED_LOGIN_ATTEMPTS_LIMIT,
        windowMs: config.HOSTED_LOGIN_ATTEMPTS_WINDOW_MS,
      };
    }
    // Forgot-password requests and token-gated reset submissions share the
    // recovery numbers but never each other's budget.
    const recovery = {
      limit: config.HOSTED_FORGOT_ATTEMPTS_LIMIT,
      windowMs: config.HOSTED_FORGOT_ATTEMPTS_WINDOW_MS,
    };
    return kind === "forgot" ? recovery : { ...recovery };
  }

  /**
   * @param {"register" | "login" | "forgot"} kind
   * @param {string} clientAddress
   * @param {string} emailKey
   * @returns {boolean}
   */
  function consumeAttemptLimits(kind, clientAddress, emailKey) {
    const { limit, windowMs } = attemptLimits(kind);
    return (
      limiter.consume(kind, `ip:${clientAddress}`, limit, windowMs).allowed &&
      limiter.consume(kind, `email:${emailKey}`, limit, windowMs).allowed
    );
  }

  /**
   * Consumes only the per-IP attempt budget of a kind, for token-gated
   * submissions that carry no email address.
   *
   * @param {"register" | "login" | "forgot" | "reset"} kind
   * @param {string} clientAddress
   * @returns {boolean}
   */
  function consumeIpAttemptLimit(kind, clientAddress) {
    const { limit, windowMs } = attemptLimits(kind);
    return limiter.consume(kind, `ip:${clientAddress}`, limit, windowMs)
      .allowed;
  }

  /**
   * Builds an absolute single-use token link (verification, password reset)
   * from the request's authority; a hostile Host header fails the request.
   *
   * @param {HttpRouteContext} ctx
   * @param {string} path
   * @param {string} rawToken
   * @returns {string}
   */
  function buildTokenUrl(ctx, path, rawToken) {
    const authority =
      firstHeaderValue(ctx.request.headers["x-forwarded-host"]) ||
      firstHeaderValue(ctx.request.headers.host);
    try {
      const url = new URL(
        `${requestScheme(ctx.request)}://${authority || ""}${config.BASE_PATH}${path}`,
      );
      url.searchParams.set("token", rawToken);
      return url.href;
    } catch {
      throw badRequest("invalid_request_host");
    }
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {string} rawSessionId
   * @returns {void}
   */
  function issueSessionCookie(ctx, rawSessionId) {
    appendSetCookieHeader(
      ctx.response,
      serializeHostedCookie(HOSTED_SESSION_COOKIE_NAME, rawSessionId, {
        ...cookieOptions(),
        maxAgeSeconds: Math.max(
          1,
          Math.floor(config.HOSTED_SESSION_MAX_AGE_MS / 1000),
        ),
      }),
    );
  }

  // --- registration -------------------------------------------------------

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void | Promise<void>}
   */
  function serveRegister(ctx) {
    if (ctx.request.method === "POST") return handleRegisterSubmission(ctx);
    if (ctx.request.method === "GET") {
      renderRegisterForm(ctx, 200, {});
      return;
    }
    throw new BoundaryError(405, "method_not_allowed");
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {number} statusCode
   * @param {{errorKey?: string, emailValue?: string, successEmail?: string}} state
   * @returns {void}
   */
  function renderRegisterForm(ctx, statusCode, state) {
    const csrfToken = ensureCsrfToken(ctx);
    templates.register.serveWithStatus(ctx.request, ctx.response, statusCode, {
      // Conditional template sections must receive undefined rather than an
      // empty string: Handlebars renders sections for empty strings.
      hostedRegisterError: state.errorKey
        ? translate(templates.register, ctx, state.errorKey)
        : undefined,
      hostedRegisterEmailValue: state.emailValue || "",
      hostedRegisterSuccessEmail: state.successEmail
        ? translate(templates.register, ctx, "hosted_register_success_body", {
            email: state.successEmail,
          })
        : undefined,
      hostedRegisterLoginLink: translate(
        templates.register,
        ctx,
        "hosted_login_link",
      ),
      hostedCaptchaRequired: captcha.required,
      hostedCaptchaSiteKey: captcha.siteKey,
      hostedCaptchaFieldName: captcha.fieldName,
      csrfToken,
    });
  }

  /**
   * Shared admission gate for registration and login submissions: reads the
   * form body, enforces CSRF, applies the per-IP/per-email attempt limits,
   * and verifies the CAPTCHA contract. Returns the admission result; the
   * caller renders its own failure state through renderSubmissionFailure.
   *
   * @param {HttpRouteContext} ctx
   * @param {"register" | "login" | "forgot"} kind
   * @returns {Promise<{form: URLSearchParams, address: string, email: string} | null>}
   */
  async function admitSubmission(ctx, kind) {
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderSubmissionFailure(ctx, kind, 403, "hosted_error_csrf", {});
      return null;
    }

    const address = clientIp(ctx);
    const email = normalizeEmail(form.get("email"));
    if (!consumeAttemptLimits(kind, address, email || "unparsable-email")) {
      renderSubmissionFailure(ctx, kind, 429, "hosted_error_rate_limited", {});
      return null;
    }

    const captchaVerification = await captcha.verify(
      form.get(captcha.fieldName),
      address,
      firstHeaderValue(ctx.request.headers.host),
    );
    if (captchaVerification.ok === false) {
      renderSubmissionFailure(ctx, kind, 403, "hosted_error_captcha", {});
      return null;
    }
    return { form, address, email };
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {"register" | "login" | "forgot"} kind
   * @param {number} statusCode
   * @param {string} errorKey
   * @param {{emailValue?: string}} state
   * @returns {void}
   */
  function renderSubmissionFailure(ctx, kind, statusCode, errorKey, state) {
    if (kind === "register") {
      renderRegisterForm(ctx, statusCode, {
        errorKey,
        emailValue: state.emailValue,
      });
      return;
    }
    if (kind === "forgot") {
      renderForgotForm(ctx, statusCode, { errorKey });
      return;
    }
    renderLoginForm(ctx, statusCode, {
      errorKey,
      emailValue: state.emailValue,
    });
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function handleRegisterSubmission(ctx) {
    const admission = await admitSubmission(ctx, "register");
    if (!admission) return;
    const { form, email } = admission;

    const password = form.get("password");
    if (!isValidNormalizedEmail(email)) {
      renderRegisterForm(ctx, 400, {
        errorKey: "hosted_register_error_email",
        emailValue: safeEmailEcho(form.get("email")),
      });
      return;
    }
    if (
      typeof password !== "string" ||
      password.length < MIN_PASSWORD_LENGTH ||
      password.length > MAX_PASSWORD_LENGTH
    ) {
      renderRegisterForm(ctx, 400, {
        errorKey: "hosted_register_error_password",
        emailValue: email,
      });
      return;
    }
    if (form.get("ageConfirmation") !== "1") {
      renderRegisterForm(ctx, 400, {
        errorKey: "hosted_register_error_age",
        emailValue: email,
      });
      return;
    }

    const existingAccount = store.getAccountByEmail(email);
    if (existingAccount && existingAccount.verifiedAtMs !== null) {
      renderRegisterForm(ctx, 409, {
        errorKey: "hosted_register_error_email_taken",
        emailValue: email,
      });
      return;
    }

    let account;
    if (existingAccount) {
      // A still-unverified registration is repeated: adopt the latest
      // password and send a fresh single-use link.
      account = existingAccount;
      await store.updateAccountPassword(
        account.accountId,
        await hashPassword(password),
      );
    } else {
      account = await store.createAccount({
        email,
        passwordHash: await hashPassword(password),
      });
    }
    const rawToken = await store.createVerificationToken(account.accountId);
    // The mail goes through the durable notice queue: a mail vendor outage
    // becomes an observable retry, never a failed registration. The composed
    // body carries the single-use link and is stored only in the queue and
    // the vendor delivery path, never in a log.
    await notifications.queueAccountMail({
      kind: NOTICE_KINDS.ACCOUNT_VERIFICATION,
      to: email,
      subject: translate(
        templates.register,
        ctx,
        "hosted_mail_verification_subject",
      ),
      body: translate(
        templates.register,
        ctx,
        "hosted_mail_verification_body",
        { url: buildTokenUrl(ctx, "/verify", rawToken) },
      ),
    });
    logger.info("hosted.account_registered", {
      account_id: account.accountId,
      resent: Boolean(existingAccount),
    });
    renderRegisterForm(ctx, 200, { successEmail: email });
  }

  // --- email verification -------------------------------------------------

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void | Promise<void>}
   */
  function serveVerify(ctx) {
    if (ctx.request.method !== "GET") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    return handleVerification(ctx);
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function handleVerification(ctx) {
    const rawToken = ctx.url.searchParams.get("token") || "";
    const accountId = await store.consumeVerificationToken(rawToken);
    const account = accountId ? store.getAccountById(accountId) : null;
    if (!accountId || !account) {
      // Invalid, already used, and expired tokens are rejected identically.
      templates.verify.serveWithStatus(ctx.request, ctx.response, 403, {
        hostedVerifyInvalid: translate(
          templates.verify,
          ctx,
          "hosted_verify_invalid",
        ),
      });
      return;
    }
    await store.markAccountVerified(accountId, clock());
    logger.info("hosted.account_verified", { account_id: accountId });
    seeOther(ctx, `${publicPath(config, "/login")}?verified=1`);
  }

  // --- login --------------------------------------------------------------

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void | Promise<void>}
   */
  function serveLogin(ctx) {
    if (ctx.request.method === "POST") return handleLoginSubmission(ctx);
    if (ctx.request.method === "GET") {
      renderLoginForm(ctx, 200, {});
      return;
    }
    throw new BoundaryError(405, "method_not_allowed");
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {number} statusCode
   * @param {{errorKey?: string, emailValue?: string}} state
   * @returns {void}
   */
  function renderLoginForm(ctx, statusCode, state) {
    const signedIn = resolveSignedInAccountFromRequest(store, ctx.request);
    const csrfToken = ensureCsrfToken(ctx);
    templates.login.serveWithStatus(ctx.request, ctx.response, statusCode, {
      hostedLoginError: state.errorKey
        ? translate(templates.login, ctx, state.errorKey)
        : undefined,
      hostedLoginEmailValue: state.emailValue || "",
      hostedLoginVerifiedNotice:
        ctx.url.searchParams.get("verified") === "1"
          ? translate(templates.login, ctx, "hosted_login_verified_notice")
          : undefined,
      hostedLoginResetNotice:
        ctx.url.searchParams.get("reset") === "1"
          ? translate(templates.login, ctx, "hosted_login_reset_notice")
          : undefined,
      hostedLoginDeletedNotice:
        ctx.url.searchParams.get("deleted") === "1"
          ? translate(templates.login, ctx, "hosted_account_deleted_notice")
          : undefined,
      hostedLoginSignedInEmail: signedIn ? signedIn.email : undefined,
      hostedLoginSignedInAs: signedIn
        ? translate(templates.login, ctx, "hosted_login_signed_in_as", {
            email: signedIn.email,
          })
        : undefined,
      hostedCaptchaRequired: captcha.required,
      hostedCaptchaSiteKey: captcha.siteKey,
      hostedCaptchaFieldName: captcha.fieldName,
      csrfToken,
    });
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function handleLoginSubmission(ctx) {
    const admission = await admitSubmission(ctx, "login");
    if (!admission) return;
    const { form, address, email } = admission;

    // Unknown emails, wrong passwords, unverified accounts, and disabled
    // accounts all cost the same and produce the same generic failure, so no
    // failure reveals whether an email is registered.
    const account = store.getAccountByEmail(email);
    const password = form.get("password");
    const passwordMatches =
      account !== null && typeof password === "string"
        ? await verifyPassword(password, account.passwordHash)
        : await verifyDummyPassword(
            typeof password === "string" ? password : "",
          );
    const authorized =
      passwordMatches &&
      account !== null &&
      typeof password === "string" &&
      account.verifiedAtMs !== null &&
      account.status === "active";
    if (!authorized) {
      logger.info("hosted.account_login_rejected", {
        "client.address": address,
      });
      renderLoginForm(ctx, 401, {
        errorKey: "hosted_login_invalid",
        emailValue: email,
      });
      return;
    }

    const rawSessionId = await store.createSession(account.accountId);
    issueSessionCookie(ctx, rawSessionId);
    rotateCsrfToken(ctx);
    logger.info("hosted.account_login", { account_id: account.accountId });
    seeOther(ctx, publicPath(config, "/"));
  }

  // --- logout -------------------------------------------------------------

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void | Promise<void>}
   */
  function serveLogout(ctx) {
    if (ctx.request.method === "POST") return handleLogoutSubmission(ctx);
    if (ctx.request.method === "GET") {
      if (!resolveSignedInAccountFromRequest(store, ctx.request)) {
        seeOther(ctx, publicPath(config, "/"));
        return;
      }
      templates.logout.serveWithStatus(ctx.request, ctx.response, 200, {
        csrfToken: ensureCsrfToken(ctx),
      });
      return;
    }
    throw new BoundaryError(405, "method_not_allowed");
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function handleLogoutSubmission(ctx) {
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      templates.logout.serveWithStatus(ctx.request, ctx.response, 403, {
        hostedLogoutError: translate(
          templates.logout,
          ctx,
          "hosted_error_csrf",
        ),
        csrfToken: ensureCsrfToken(ctx),
      });
      return;
    }
    const signedIn = resolveSignedInAccountFromRequest(store, ctx.request);
    const rawSessionId = readHostedCookie(
      ctx.request.headers.cookie,
      HOSTED_SESSION_COOKIE_NAME,
    );
    if (rawSessionId) await store.revokeSession(rawSessionId);
    appendSetCookieHeader(
      ctx.response,
      clearHostedCookie(HOSTED_SESSION_COOKIE_NAME, cookieOptions()),
    );
    rotateCsrfToken(ctx);
    if (signedIn) {
      logger.info("hosted.account_logout", { account_id: signedIn.accountId });
    }
    seeOther(ctx, publicPath(config, "/"));
  }

  // --- forgot password ----------------------------------------------------

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void | Promise<void>}
   */
  function serveForgot(ctx) {
    if (ctx.request.method === "POST") return handleForgotSubmission(ctx);
    if (ctx.request.method === "GET") {
      renderForgotForm(ctx, 200, {});
      return;
    }
    throw new BoundaryError(405, "method_not_allowed");
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {number} statusCode
   * @param {{errorKey?: string, success?: boolean}} state
   * @returns {void}
   */
  function renderForgotForm(ctx, statusCode, state) {
    const csrfToken = ensureCsrfToken(ctx);
    templates.forgot.serveWithStatus(ctx.request, ctx.response, statusCode, {
      hostedForgotError: state.errorKey
        ? translate(templates.forgot, ctx, state.errorKey)
        : undefined,
      hostedForgotSuccess: state.success
        ? translate(templates.forgot, ctx, "hosted_forgot_success")
        : undefined,
      hostedCaptchaRequired: captcha.required,
      hostedCaptchaSiteKey: captcha.siteKey,
      hostedCaptchaFieldName: captcha.fieldName,
      csrfToken,
    });
  }

  /**
   * The response is byte-identical whether or not the submitted address
   * belongs to an existing, verified, active account: reset links are only
   * queued for those, but nothing in the response distinguishes the cases.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function handleForgotSubmission(ctx) {
    const admission = await admitSubmission(ctx, "forgot");
    if (!admission) return;
    const { email } = admission;

    const account = store.getAccountByEmail(email);
    if (
      account &&
      account.verifiedAtMs !== null &&
      account.status === "active"
    ) {
      const rawToken = await store.createPasswordResetToken(account.accountId);
      await notifications.queueAccountMail({
        kind: NOTICE_KINDS.ACCOUNT_PASSWORD_RESET,
        to: account.email,
        subject: translate(templates.forgot, ctx, "hosted_mail_reset_subject"),
        body: translate(templates.forgot, ctx, "hosted_mail_reset_body", {
          url: buildTokenUrl(ctx, "/reset", rawToken),
        }),
      });
      logger.info("hosted.account_reset_requested", {
        account_id: account.accountId,
      });
    }
    renderForgotForm(ctx, 200, { success: true });
  }

  // --- password reset -----------------------------------------------------

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void | Promise<void>}
   */
  function serveReset(ctx) {
    if (ctx.request.method === "POST") return handleResetSubmission(ctx);
    if (ctx.request.method === "GET") return handleResetFormRequest(ctx);
    throw new BoundaryError(405, "method_not_allowed");
  }

  /**
   * Renders the choose-a-new-password form for a currently redeemable token;
   * invalid, used, and expired tokens get the identical rejection page.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function handleResetFormRequest(ctx) {
    const rawToken = ctx.url.searchParams.get("token") || "";
    if (!store.peekPasswordResetToken(rawToken)) {
      renderResetInvalid(ctx);
      return;
    }
    templates.reset.serveWithStatus(ctx.request, ctx.response, 200, {
      hostedResetError: undefined,
      hostedResetToken: rawToken,
      csrfToken: ensureCsrfToken(ctx),
    });
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void}
   */
  function renderResetInvalid(ctx) {
    templates.reset.serveWithStatus(ctx.request, ctx.response, 403, {
      hostedResetInvalid: translate(
        templates.reset,
        ctx,
        "hosted_reset_invalid",
      ),
    });
  }

  /**
   * Redeems the reset token: adopts the new password and revokes every
   * session of the account, including the requester's own if any.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function handleResetSubmission(ctx) {
    const form = await readFormBody(ctx.request);
    const rawToken = form.get("token") || "";
    /**
     * Re-renders the form for a retry; the still-unconsumed token travels
     * back so a failed validation does not kill the link.
     * @param {number} statusCode
     * @param {string} errorKey
     * @returns {void}
     */
    function renderResetRetry(statusCode, errorKey) {
      templates.reset.serveWithStatus(ctx.request, ctx.response, statusCode, {
        hostedResetError: translate(templates.reset, ctx, errorKey),
        hostedResetToken: rawToken,
        csrfToken: ensureCsrfToken(ctx),
      });
    }
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderResetRetry(403, "hosted_error_csrf");
      return;
    }
    if (!consumeIpAttemptLimit("reset", clientIp(ctx))) {
      renderResetRetry(429, "hosted_error_rate_limited");
      return;
    }

    const password = form.get("password");
    if (
      typeof password !== "string" ||
      password.length < MIN_PASSWORD_LENGTH ||
      password.length > MAX_PASSWORD_LENGTH
    ) {
      renderResetRetry(400, "hosted_register_error_password");
      return;
    }

    const accountId = await store.consumePasswordResetToken(rawToken);
    const account = accountId ? store.getAccountById(accountId) : null;
    if (!accountId || !account || account.status !== "active") {
      // Invalid, used, expired, and disabled-account tokens are rejected
      // identically.
      renderResetInvalid(ctx);
      return;
    }
    await store.updateAccountPassword(
      account.accountId,
      await hashPassword(password),
    );
    await store.revokeAccountSessions(account.accountId);
    logger.info("hosted.account_password_reset", {
      account_id: account.accountId,
    });
    seeOther(ctx, `${publicPath(config, "/login")}?reset=1`);
  }

  // --- account: sessions and password change ------------------------------

  /**
   * @param {HttpRouteContext} ctx
   * @returns {{accountId: string, email: string, publicId: string} | null}
   */
  function requireSignedIn(ctx) {
    return resolveSignedInAccountFromRequest(store, ctx.request);
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void}
   */
  function redirectToLogin(ctx) {
    seeOther(ctx, publicPath(config, "/login"));
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {number} statusCode
   * @param {{errorKey?: string, changed?: boolean}} state
   * @returns {Promise<void>}
   */
  async function renderAccountPage(ctx, statusCode, state) {
    const signedIn = requireSignedIn(ctx);
    if (!signedIn) {
      redirectToLogin(ctx);
      return;
    }
    const { language } = templates.account.translationsFor(
      ctx.request,
      ctx.url,
    );
    const sessions = await store.listSessions(signedIn.accountId);
    const otherSessions = sessions.filter(
      (session) => session.publicId !== signedIn.publicId,
    );
    const csrfToken = ensureCsrfToken(ctx);
    templates.account.serveWithStatus(ctx.request, ctx.response, statusCode, {
      hostedAccountEmail: signedIn.email,
      hostedAccountError: state.errorKey
        ? translate(templates.account, ctx, state.errorKey)
        : undefined,
      hostedAccountPasswordChanged: state.changed
        ? translate(templates.account, ctx, "hosted_account_password_changed")
        : undefined,
      hostedAccountSessions: sessions.map((session) => ({
        publicId: session.publicId,
        current: session.publicId === signedIn.publicId,
        createdAtMs: formatTimestamp(language, session.createdAtMs),
        lastActiveAtMs: formatTimestamp(language, session.lastSeenAtMs),
      })),
      hostedAccountHasOtherSessions: otherSessions.length > 0,
      csrfToken,
    });
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void | Promise<void>}
   */
  function serveAccount(ctx) {
    if (ctx.request.method !== "GET") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    if (!requireSignedIn(ctx)) {
      redirectToLogin(ctx);
      return;
    }
    return renderAccountPage(ctx, 200, {});
  }

  /**
   * Authenticated password change: re-proves the current password, adopts
   * the new one, and revokes every other session while keeping the current
   * device signed in.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function handleAccountPasswordSubmission(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const signedIn = requireSignedIn(ctx);
    if (!signedIn) {
      redirectToLogin(ctx);
      return;
    }
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      await renderAccountPage(ctx, 403, { errorKey: "hosted_error_csrf" });
      return;
    }
    const account = store.getAccountById(signedIn.accountId);
    if (!account) {
      redirectToLogin(ctx);
      return;
    }
    const currentPassword = form.get("currentPassword");
    const currentPasswordMatches =
      typeof currentPassword === "string" &&
      (await verifyPassword(currentPassword, account.passwordHash));
    if (!currentPasswordMatches) {
      await renderAccountPage(ctx, 401, {
        errorKey: "hosted_account_error_password",
      });
      return;
    }
    const newPassword = form.get("password");
    if (
      typeof newPassword !== "string" ||
      newPassword.length < MIN_PASSWORD_LENGTH ||
      newPassword.length > MAX_PASSWORD_LENGTH
    ) {
      await renderAccountPage(ctx, 400, {
        errorKey: "hosted_register_error_password",
      });
      return;
    }
    await store.updateAccountPassword(
      account.accountId,
      await hashPassword(newPassword),
    );
    const rawSessionId = readHostedCookie(
      ctx.request.headers.cookie,
      HOSTED_SESSION_COOKIE_NAME,
    );
    if (rawSessionId) {
      await store.revokeOtherSessions(account.accountId, rawSessionId);
    }
    logger.info("hosted.account_password_changed", {
      account_id: account.accountId,
    });
    await renderAccountPage(ctx, 200, { changed: true });
  }

  /**
   * Authenticated account deregistration: re-proves the current password,
   * then irreversibly pseudonymizes the account in the store. Sessions and
   * outstanding tokens are revoked by the store; this handler clears the
   * session cookie, rotates the CSRF token, and lands on the login page with
   * a notice. Public attribution was already an opaque Participant
   * Identifier, so nothing public ever carried the identity being removed.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function handleAccountDeleteSubmission(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const signedIn = requireSignedIn(ctx);
    if (!signedIn) {
      redirectToLogin(ctx);
      return;
    }
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      await renderAccountPage(ctx, 403, { errorKey: "hosted_error_csrf" });
      return;
    }
    const account = store.getAccountById(signedIn.accountId);
    if (!account || account.status !== "active") {
      redirectToLogin(ctx);
      return;
    }
    const currentPassword = form.get("currentPassword");
    const currentPasswordMatches =
      typeof currentPassword === "string" &&
      account.passwordHash !== "" &&
      (await verifyPassword(currentPassword, account.passwordHash));
    if (!currentPasswordMatches) {
      await renderAccountPage(ctx, 401, {
        errorKey: "hosted_account_error_password",
      });
      return;
    }
    const deleted = await store.deleteAccount(account.accountId);
    if (!deleted.ok) {
      // Raced with another deletion or an administrative disable: the
      // account is no longer signed in either way — send to login.
      redirectToLogin(ctx);
      return;
    }
    appendSetCookieHeader(
      ctx.response,
      clearHostedCookie(HOSTED_SESSION_COOKIE_NAME, cookieOptions()),
    );
    rotateCsrfToken(ctx);
    seeOther(ctx, publicPath(config, "/login?deleted=1"));
  }

  /**
   * Revokes one session of the current account by public id. Revoking the
   * current session is allowed and signs this device out.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function handleAccountSessionRevoke(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const signedIn = requireSignedIn(ctx);
    if (!signedIn) {
      redirectToLogin(ctx);
      return;
    }
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      await renderAccountPage(ctx, 403, { errorKey: "hosted_error_csrf" });
      return;
    }
    await store.revokeSessionByPublicId(
      signedIn.accountId,
      String(form.get("publicId") || ""),
    );
    seeOther(ctx, publicPath(config, "/account"));
  }

  /**
   * Revokes every session of the current account except this device's.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function handleAccountSessionsRevokeOthers(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const signedIn = requireSignedIn(ctx);
    if (!signedIn) {
      redirectToLogin(ctx);
      return;
    }
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      await renderAccountPage(ctx, 403, { errorKey: "hosted_error_csrf" });
      return;
    }
    const rawSessionId = readHostedCookie(
      ctx.request.headers.cookie,
      HOSTED_SESSION_COOKIE_NAME,
    );
    if (rawSessionId) {
      await store.revokeOtherSessions(signedIn.accountId, rawSessionId);
    }
    seeOther(ctx, publicPath(config, "/account"));
  }

  return {
    serveRegister,
    serveLogin,
    serveVerify,
    serveLogout,
    serveForgot,
    serveReset,
    serveAccount,
    serveAccountPassword: handleAccountPasswordSubmission,
    serveAccountDelete: handleAccountDeleteSubmission,
    serveAccountSessionRevoke: handleAccountSessionRevoke,
    serveAccountSessionsRevokeOthers: handleAccountSessionsRevokeOthers,
  };
}

/**
 * Renders timestamps for the page language through Intl.
 *
 * @param {string} language
 * @param {number} ms
 * @returns {string}
 */
function formatTimestamp(language, ms) {
  return new Date(ms).toLocaleString(language);
}

/**
 * Synchronous signed-in account resolution for page rendering. Sessions are
 * validated against absolute and idle expiry; disabled or unverified
 * accounts never count as signed in.
 *
 * @param {ReturnType<typeof import("./store.mjs").createFileAccountStore>} store
 * @param {import("http").IncomingMessage} request
 * @returns {{accountId: string, email: string, publicId: string} | null}
 */
function resolveSignedInAccountFromRequest(store, request) {
  const rawSessionId = readHostedCookie(
    request.headers.cookie,
    HOSTED_SESSION_COOKIE_NAME,
  );
  if (!rawSessionId) return null;
  const session = store.peekSession(rawSessionId);
  if (!session) return null;
  const account = store.getAccountById(session.accountId);
  if (
    !account ||
    account.status !== "active" ||
    account.verifiedAtMs === null
  ) {
    return null;
  }
  return {
    accountId: account.accountId,
    email: account.email,
    publicId: session.publicId,
  };
}

/**
 * Echoes a submitted, non-normalizable email back into the form with basic
 * hygiene; final rendering is always Handlebars-escaped.
 *
 * @param {string | null} value
 * @returns {string}
 */
function safeEmailEcho(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 254 ? "" : trimmed;
}

export { createHostedAccountRoutes, resolveSignedInAccountFromRequest };
