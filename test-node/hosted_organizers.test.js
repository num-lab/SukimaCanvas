const test = require("node:test");
const assert = require("node:assert/strict");

const { closeServer } = require("./test_helpers.js");
const {
  STRONG_PASSWORD,
  MAX_FORM_BODY_BYTES,
  createHostedServer,
  requestWithCookies,
  formValue,
  signUpAndLogin,
} = require("./helpers/hosted_http.js");

const OPERATOR_EMAIL = "operator@example.com";

/**
 * The double-submit CSRF token equals the cookie value, so decision and status
 * pages that render no form can still be posted to in tests.
 *
 * @param {{csrfCookie: string}} jar
 * @returns {string}
 */
function csrfToken(jar) {
  return jar.csrfCookie.split("=")[1] || "";
}

/**
 * @param {import("http").Server} app
 * @param {{sessionCookie: string, csrfCookie: string}} jar
 * @param {{[key: string]: string}} [fields]
 * @returns {Promise<{statusCode: number, headers: import("http").IncomingHttpHeaders, body: string, setCookie: string[]}>}
 */
async function submitApplication(app, jar, fields = {}) {
  return requestWithCookies(app, "/organizer/apply?lang=en", {
    method: "POST",
    cookie: `${jar.sessionCookie}; ${jar.csrfCookie}`,
    body: new URLSearchParams({
      _csrf: csrfToken(jar),
      organizerName: "Aurora Collective",
      contactName: "Mika Rin",
      contactEmail: "contact@example.com",
      description: "Monthly community drawing jams.",
      ...fields,
    }).toString(),
  });
}

/**
 * Signs up an operator and an applicant, then submits one application. Returns
 * both cookie jars and the application id parsed from the operator queue.
 *
 * @param {import("http").Server} app
 * @param {string} outboxDir
 */
async function seedPendingApplication(app, outboxDir) {
  const operator = await signUpAndLogin(
    app,
    outboxDir,
    OPERATOR_EMAIL,
    STRONG_PASSWORD,
  );
  const applicant = await signUpAndLogin(
    app,
    outboxDir,
    `applicant-${Date.now()}@example.com`,
    STRONG_PASSWORD,
  );
  const submitted = await submitApplication(app, applicant);
  assert.equal(submitted.statusCode, 303);

  const queue = await requestWithCookies(app, "/operator?lang=en", {
    cookie: `${operator.sessionCookie}; ${operator.csrfCookie}`,
  });
  assert.equal(queue.statusCode, 200);
  const match = /href="operator\/applications\/([^"]+)"/.exec(queue.body);
  assert.ok(match, "operator queue must link to the pending application");
  const applicationId = match[1];
  assert.ok(applicationId, "operator queue must expose an application id");
  return { operator, applicant, applicationId };
}

/**
 * @param {import("http").Server} app
 * @param {{sessionCookie: string, csrfCookie: string}} operator
 * @param {string} applicationId
 */
async function operatorDetail(app, operator, applicationId) {
  return requestWithCookies(
    app,
    `/operator/applications/${applicationId}?lang=en`,
    {
      cookie: `${operator.sessionCookie}; ${operator.csrfCookie}`,
    },
  );
}

test("a verified account submits an organizer application and sees its status", async () => {
  const { app, outboxDir } = await createHostedServer();
  try {
    const applicant = await signUpAndLogin(
      app,
      outboxDir,
      `apply-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );
    const form = await requestWithCookies(app, "/organizer/apply?lang=en", {
      cookie: `${applicant.sessionCookie}; ${applicant.csrfCookie}`,
    });
    assert.equal(form.statusCode, 200);
    assert.match(form.body, /Apply to organize events/);
    assert.match(form.body, /name="organizerName"/);

    const submitted = await submitApplication(app, applicant);
    assert.equal(submitted.statusCode, 303);
    assert.equal(submitted.headers.location, "/organizer/apply?submitted=1");

    const status = await requestWithCookies(
      app,
      "/organizer/apply?submitted=1&lang=en",
      { cookie: `${applicant.sessionCookie}; ${applicant.csrfCookie}` },
    );
    assert.equal(status.statusCode, 200);
    assert.match(status.body, /under review/i);
    // A pending application shows status only; the form is withdrawn.
    assert.doesNotMatch(status.body, /name="organizerName"/);
  } finally {
    await closeServer(app);
  }
});

test("duplicate submissions never create a conflicting application", async () => {
  const { app, outboxDir } = await createHostedServer();
  try {
    const applicant = await signUpAndLogin(
      app,
      outboxDir,
      `dup-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );
    assert.equal((await submitApplication(app, applicant)).statusCode, 303);
    const second = await submitApplication(app, applicant);
    assert.equal(second.statusCode, 409);
    assert.match(second.body, /already have an application under review/);
  } finally {
    await closeServer(app);
  }
});

test("hostile and over-limit application input is rejected deterministically", async () => {
  const { app, outboxDir } = await createHostedServer();
  try {
    const applicant = await signUpAndLogin(
      app,
      outboxDir,
      `hostile-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );
    const cookie = `${applicant.sessionCookie}; ${applicant.csrfCookie}`;
    const page = await requestWithCookies(app, "/organizer/apply?lang=en", {
      cookie,
    });
    const csrf = formValue(page.body, "_csrf");
    const base = {
      _csrf: csrf,
      organizerName: "Aurora Collective",
      contactName: "Mika Rin",
      contactEmail: "contact@example.com",
      description: "ok",
    };
    /** @param {{[key: string]: string}} fields */
    const post = (fields) =>
      requestWithCookies(app, "/organizer/apply?lang=en", {
        method: "POST",
        cookie,
        body: new URLSearchParams({ ...base, ...fields }).toString(),
      });

    assert.equal((await post({ organizerName: "" })).statusCode, 400);
    assert.equal(
      (await post({ organizerName: "x".repeat(121) })).statusCode,
      400,
    );
    assert.equal((await post({ contactName: "" })).statusCode, 400);
    assert.equal(
      (await post({ contactEmail: "not-an-email" })).statusCode,
      400,
    );
    assert.equal(
      (await post({ description: "x".repeat(2001) })).statusCode,
      400,
    );

    const missingCsrf = await post({ _csrf: "" });
    assert.equal(missingCsrf.statusCode, 403);

    const wrongContentType = await requestWithCookies(app, "/organizer/apply", {
      method: "POST",
      cookie,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(base),
    });
    assert.equal(wrongContentType.statusCode, 415);

    const oversized = await requestWithCookies(app, "/organizer/apply", {
      method: "POST",
      cookie,
      body: `organizerName=${"x".repeat(MAX_FORM_BODY_BYTES + 1)}`,
    });
    assert.equal(oversized.statusCode, 413);

    // None of the rejected attempts created an application: the form is still
    // shown with no pending status.
    const after = await requestWithCookies(app, "/organizer/apply?lang=en", {
      cookie,
    });
    assert.match(after.body, /name="organizerName"/);
    assert.doesNotMatch(after.body, /under review/i);
  } finally {
    await closeServer(app);
  }
});

test("signed-out visitors are redirected to login", async () => {
  const { app } = await createHostedServer();
  try {
    const apply = await requestWithCookies(app, "/organizer/apply");
    assert.equal(apply.statusCode, 303);
    assert.equal(apply.headers.location, "/login");
    const operator = await requestWithCookies(app, "/operator");
    assert.equal(operator.statusCode, 303);
    assert.equal(operator.headers.location, "/login");
  } finally {
    await closeServer(app);
  }
});

test("only a platform operator can view the queue or decide applications", async () => {
  const { app, outboxDir } = await createHostedServer({
    HOSTED_OPERATOR_EMAILS: [OPERATOR_EMAIL],
  });
  try {
    const { operator, applicant, applicationId } = await seedPendingApplication(
      app,
      outboxDir,
    );

    // A non-operator account is refused the console and the decision endpoints.
    const applicantJar = `${applicant.sessionCookie}; ${applicant.csrfCookie}`;
    const forbiddenQueue = await requestWithCookies(app, "/operator?lang=en", {
      cookie: applicantJar,
    });
    assert.equal(forbiddenQueue.statusCode, 403);
    assert.match(forbiddenQueue.body, /do not have access/);

    const forbiddenApprove = await requestWithCookies(
      app,
      `/operator/applications/${applicationId}/approve`,
      {
        method: "POST",
        cookie: applicantJar,
        body: new URLSearchParams({ _csrf: csrfToken(applicant) }).toString(),
      },
    );
    assert.equal(forbiddenApprove.statusCode, 403);

    // The operator sees the pending application in the queue and its detail.
    const detail = await operatorDetail(app, operator, applicationId);
    assert.equal(detail.statusCode, 200);
    assert.match(detail.body, /Aurora Collective/);
    assert.match(detail.body, /Approve/);
    assert.match(detail.body, /Reject/);

    // The application is still pending: the applicant did not gain owner rights.
    const application = await requestWithCookies(
      app,
      "/organizer/apply?lang=en",
      { cookie: applicantJar },
    );
    assert.match(application.body, /under review/i);
  } finally {
    await closeServer(app);
  }
});

test("approval creates the organizer, grants owner, and is visible to the applicant", async () => {
  const { app, outboxDir } = await createHostedServer({
    HOSTED_OPERATOR_EMAILS: [OPERATOR_EMAIL],
  });
  try {
    const { operator, applicant, applicationId } = await seedPendingApplication(
      app,
      outboxDir,
    );
    const operatorJar = `${operator.sessionCookie}; ${operator.csrfCookie}`;

    const approved = await requestWithCookies(
      app,
      `/operator/applications/${applicationId}/approve`,
      {
        method: "POST",
        cookie: operatorJar,
        body: new URLSearchParams({ _csrf: csrfToken(operator) }).toString(),
      },
    );
    assert.equal(approved.statusCode, 303);
    assert.equal(
      approved.headers.location,
      `/operator/applications/${applicationId}`,
    );

    // The operator detail now shows the approved status and the audit trail
    // with the deciding operator's identity.
    const afterDecision = await operatorDetail(app, operator, applicationId);
    assert.match(afterDecision.body, /Approved/);
    assert.match(afterDecision.body, /Application submitted/);
    assert.match(afterDecision.body, /Application approved/);
    assert.match(
      afterDecision.body,
      new RegExp(OPERATOR_EMAIL.replace(/[.@]/g, "\\$&")),
    );

    // The applicant sees the approval and their new ownership.
    const status = await requestWithCookies(app, "/organizer/apply?lang=en", {
      cookie: `${applicant.sessionCookie}; ${applicant.csrfCookie}`,
    });
    assert.match(status.body, /Approved/);
    assert.match(status.body, /owner of Aurora Collective/);

    // An already-approved owner cannot mint a second organizer with a direct
    // re-submission; the request is refused and the status stays approved.
    const reSubmit = await submitApplication(app, applicant, {
      organizerName: "A Second Organizer",
    });
    assert.equal(reSubmit.statusCode, 409);
    assert.doesNotMatch(reSubmit.body, /under review/i);
    assert.match(reSubmit.body, /Approved/);

    // A second approval of the same application is refused deterministically.
    const reApprove = await requestWithCookies(
      app,
      `/operator/applications/${applicationId}/approve`,
      {
        method: "POST",
        cookie: operatorJar,
        body: new URLSearchParams({ _csrf: csrfToken(operator) }).toString(),
      },
    );
    assert.equal(reApprove.statusCode, 409);
    assert.match(reApprove.body, /already been decided/);
  } finally {
    await closeServer(app);
  }
});

test("rejection shows the applicant a clear status without the operator note", async () => {
  const { app, outboxDir } = await createHostedServer({
    HOSTED_OPERATOR_EMAILS: [OPERATOR_EMAIL],
  });
  try {
    const { operator, applicant, applicationId } = await seedPendingApplication(
      app,
      outboxDir,
    );
    const operatorJar = `${operator.sessionCookie}; ${operator.csrfCookie}`;
    const secretNote = "OPERATOR-ONLY duplicate of an existing organizer";

    const rejected = await requestWithCookies(
      app,
      `/operator/applications/${applicationId}/reject`,
      {
        method: "POST",
        cookie: operatorJar,
        body: new URLSearchParams({
          _csrf: csrfToken(operator),
          note: secretNote,
        }).toString(),
      },
    );
    assert.equal(rejected.statusCode, 303);

    // The applicant sees a clear rejected status but never the operator note.
    const status = await requestWithCookies(app, "/organizer/apply?lang=en", {
      cookie: `${applicant.sessionCookie}; ${applicant.csrfCookie}`,
    });
    assert.match(status.body, /Not approved/);
    assert.equal(status.body.includes(secretNote), false);
    assert.equal(status.body.includes("OPERATOR-ONLY"), false);

    // The operator does see the note and the rejection in the audit trail.
    const afterDecision = await operatorDetail(app, operator, applicationId);
    assert.match(afterDecision.body, new RegExp(secretNote));
    assert.match(afterDecision.body, /Application rejected/);
  } finally {
    await closeServer(app);
  }
});
