const test = require("node:test");
const assert = require("node:assert/strict");

const { closeServer } = require("./test_helpers.js");
const {
  STRONG_PASSWORD,
  createHostedServer,
  requestWithCookies,
  signUpAndLogin,
} = require("./helpers/hosted_http.js");

const OPERATOR_EMAIL = "operator@example.com";

/**
 * @param {{csrfCookie: string}} jar
 * @returns {string}
 */
function csrf(jar) {
  return jar.csrfCookie.split("=")[1] || "";
}

/**
 * @param {{sessionCookie: string, csrfCookie: string}} jar
 * @returns {string}
 */
function jarCookie(jar) {
  return `${jar.sessionCookie}; ${jar.csrfCookie}`;
}

/**
 * Signs up an operator and an owner, then applies for and approves an
 * organizer, returning the cookie jars and the new organizer id.
 *
 * @param {import("http").Server} app
 * @param {string} outboxDir
 */
async function provisionOrganizer(app, outboxDir) {
  const operator = await signUpAndLogin(
    app,
    outboxDir,
    OPERATOR_EMAIL,
    STRONG_PASSWORD,
  );
  const owner = await signUpAndLogin(
    app,
    outboxDir,
    `owner-${Date.now()}@example.com`,
    STRONG_PASSWORD,
  );
  const applied = await requestWithCookies(app, "/organizer/apply?lang=en", {
    method: "POST",
    cookie: jarCookie(owner),
    body: new URLSearchParams({
      _csrf: csrf(owner),
      organizerName: "Aurora Collective",
      contactName: "Mika Rin",
      contactEmail: "contact@example.com",
      description: "Community jams.",
    }).toString(),
  });
  assert.equal(applied.statusCode, 303);

  const queue = await requestWithCookies(app, "/operator?lang=en", {
    cookie: jarCookie(operator),
  });
  const applicationId = /operator\/applications\/([^"]+)"/.exec(
    queue.body,
  )?.[1];
  assert.ok(applicationId);
  const approved = await requestWithCookies(
    app,
    `/operator/applications/${applicationId}/approve`,
    {
      method: "POST",
      cookie: jarCookie(operator),
      body: new URLSearchParams({ _csrf: csrf(operator) }).toString(),
    },
  );
  assert.equal(approved.statusCode, 303);

  const console = await requestWithCookies(app, "/organizer?lang=en", {
    cookie: jarCookie(owner),
  });
  const organizerId = /organizers\/([^"]+)"/.exec(console.body)?.[1];
  assert.ok(organizerId);
  return { operator, owner, organizerId };
}

/**
 * Owner invites an email at a role and returns the invitation id parsed from
 * the invitee's console.
 *
 * @param {import("http").Server} app
 * @param {string} outboxDir
 * @param {{organizerId: string, owner: {sessionCookie: string, csrfCookie: string}}} ctx
 * @param {string} email
 * @param {string} role
 */
async function invite(app, outboxDir, ctx, email, role) {
  const invited = await requestWithCookies(
    app,
    `/organizers/${ctx.organizerId}/invitations`,
    {
      method: "POST",
      cookie: jarCookie(ctx.owner),
      body: new URLSearchParams({
        _csrf: csrf(ctx.owner),
        email,
        role,
      }).toString(),
    },
  );
  assert.equal(invited.statusCode, 303);
  const invitee = await signUpAndLogin(app, outboxDir, email, STRONG_PASSWORD);
  const consolePage = await requestWithCookies(app, "/organizer?lang=en", {
    cookie: jarCookie(invitee),
  });
  const invitationId = /organizer\/invitations\/([^/"]+)\/accept/.exec(
    consolePage.body,
  )?.[1];
  return { invitee, invitationId, consoleBody: consolePage.body };
}

test("an owner invites an account and the target accepts to become a member", async () => {
  const { app, outboxDir } = await createHostedServer({
    HOSTED_OPERATOR_EMAILS: [OPERATOR_EMAIL],
  });
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    const inviteeEmail = `invitee-${Date.now()}@example.com`;
    const { invitee, invitationId, consoleBody } = await invite(
      app,
      outboxDir,
      ctx,
      inviteeEmail,
      "admin",
    );
    assert.ok(invitationId);
    assert.match(consoleBody, /Aurora Collective/);
    assert.match(consoleBody, /Accept/);

    const accepted = await requestWithCookies(
      app,
      `/organizer/invitations/${invitationId}/accept`,
      {
        method: "POST",
        cookie: jarCookie(invitee),
        body: new URLSearchParams({ _csrf: csrf(invitee) }).toString(),
      },
    );
    assert.equal(accepted.statusCode, 303);
    assert.equal(accepted.headers.location, `/organizers/${ctx.organizerId}`);

    // The owner's management page now lists both members.
    const manage = await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}?lang=en`,
      { cookie: jarCookie(ctx.owner) },
    );
    assert.match(
      manage.body,
      new RegExp(inviteeEmail.replace(/[.@]/g, "\\$&")),
    );
    assert.match(manage.body, /Invitation accepted/);
    // The activity log shows the platform-created record without disclosing the
    // operator's personal email.
    assert.match(manage.body, /Organizer created/);
    assert.match(manage.body, /Platform operator/);
    assert.equal(manage.body.includes(OPERATOR_EMAIL), false);
  } finally {
    await closeServer(app);
  }
});

test("only the target account can accept an invitation", async () => {
  const { app, outboxDir } = await createHostedServer({
    HOSTED_OPERATOR_EMAILS: [OPERATOR_EMAIL],
  });
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    const { invitationId } = await invite(
      app,
      outboxDir,
      ctx,
      `target-${Date.now()}@example.com`,
      "admin",
    );
    assert.ok(invitationId);

    // A different signed-in account cannot accept, and gets a generic failure.
    const stranger = await signUpAndLogin(
      app,
      outboxDir,
      `stranger-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );
    const strangerConsole = await requestWithCookies(
      app,
      "/organizer?lang=en",
      {
        cookie: jarCookie(stranger),
      },
    );
    // The stranger's console never reveals the other account's invitation.
    assert.doesNotMatch(strangerConsole.body, /Aurora Collective/);
    const stolen = await requestWithCookies(
      app,
      `/organizer/invitations/${invitationId}/accept`,
      {
        method: "POST",
        cookie: jarCookie(stranger),
        body: new URLSearchParams({ _csrf: csrf(stranger) }).toString(),
      },
    );
    assert.equal(stolen.statusCode, 409);
    assert.match(stolen.body, /no longer available/);
  } finally {
    await closeServer(app);
  }
});

test("revoked and used invitations cannot establish membership", async () => {
  const { app, outboxDir } = await createHostedServer({
    HOSTED_OPERATOR_EMAILS: [OPERATOR_EMAIL],
  });
  try {
    const ctx = await provisionOrganizer(app, outboxDir);

    // Revoked: the owner revokes before the target accepts.
    const revokeTarget = `revoke-${Date.now()}@example.com`;
    const revoked = await invite(app, outboxDir, ctx, revokeTarget, "admin");
    assert.ok(revoked.invitationId);
    const manage = await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}?lang=en`,
      { cookie: jarCookie(ctx.owner) },
    );
    const revokeId = /invitations\/([^/"]+)\/revoke/.exec(manage.body)?.[1];
    assert.equal(revokeId, revoked.invitationId);
    const revokeResponse = await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}/invitations/${revokeId}/revoke`,
      {
        method: "POST",
        cookie: jarCookie(ctx.owner),
        body: new URLSearchParams({ _csrf: csrf(ctx.owner) }).toString(),
      },
    );
    assert.equal(revokeResponse.statusCode, 303);
    const afterRevoke = await requestWithCookies(
      app,
      `/organizer/invitations/${revoked.invitationId}/accept`,
      {
        method: "POST",
        cookie: jarCookie(revoked.invitee),
        body: new URLSearchParams({ _csrf: csrf(revoked.invitee) }).toString(),
      },
    );
    assert.equal(afterRevoke.statusCode, 409);

    // Used: accepting twice only works once.
    const usedTarget = `used-${Date.now()}@example.com`;
    const used = await invite(app, outboxDir, ctx, usedTarget, "admin");
    assert.ok(used.invitationId);
    const first = await requestWithCookies(
      app,
      `/organizer/invitations/${used.invitationId}/accept`,
      {
        method: "POST",
        cookie: jarCookie(used.invitee),
        body: new URLSearchParams({ _csrf: csrf(used.invitee) }).toString(),
      },
    );
    assert.equal(first.statusCode, 303);
    const second = await requestWithCookies(
      app,
      `/organizer/invitations/${used.invitationId}/accept`,
      {
        method: "POST",
        cookie: jarCookie(used.invitee),
        body: new URLSearchParams({ _csrf: csrf(used.invitee) }).toString(),
      },
    );
    assert.equal(second.statusCode, 409);
  } finally {
    await closeServer(app);
  }
});

test("admins cannot manage members or send invitations", async () => {
  const { app, outboxDir } = await createHostedServer({
    HOSTED_OPERATOR_EMAILS: [OPERATOR_EMAIL],
  });
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    const adminEmail = `admin-${Date.now()}@example.com`;
    const { invitee: admin, invitationId } = await invite(
      app,
      outboxDir,
      ctx,
      adminEmail,
      "admin",
    );
    assert.ok(invitationId);
    await requestWithCookies(
      app,
      `/organizer/invitations/${invitationId}/accept`,
      {
        method: "POST",
        cookie: jarCookie(admin),
        body: new URLSearchParams({ _csrf: csrf(admin) }).toString(),
      },
    );

    // The admin can view the organizer but sees no owner-only controls.
    const manage = await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}?lang=en`,
      { cookie: jarCookie(admin) },
    );
    assert.equal(manage.statusCode, 200);
    assert.doesNotMatch(manage.body, /Invite a member/);

    // Owner-only actions are refused for the admin.
    const invite403 = await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}/invitations`,
      {
        method: "POST",
        cookie: jarCookie(admin),
        body: new URLSearchParams({
          _csrf: csrf(admin),
          email: `x-${Date.now()}@example.com`,
          role: "admin",
        }).toString(),
      },
    );
    assert.equal(invite403.statusCode, 403);
  } finally {
    await closeServer(app);
  }
});

test("owners manage roles under the last-owner guarantee", async () => {
  const { app, outboxDir } = await createHostedServer({
    HOSTED_OPERATOR_EMAILS: [OPERATOR_EMAIL],
  });
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    const ownerAccountId = /members\/([^/"]+)\/role/.exec(
      (
        await requestWithCookies(
          app,
          `/organizers/${ctx.organizerId}?lang=en`,
          {
            cookie: jarCookie(ctx.owner),
          },
        )
      ).body,
    )?.[1];
    assert.ok(ownerAccountId);

    // The sole owner cannot be demoted.
    const demoteSelf = await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}/members/${ownerAccountId}/role`,
      {
        method: "POST",
        cookie: jarCookie(ctx.owner),
        body: new URLSearchParams({
          _csrf: csrf(ctx.owner),
          role: "admin",
        }).toString(),
      },
    );
    assert.equal(demoteSelf.statusCode, 409);
    assert.match(demoteSelf.body, /at least one owner/);

    // The sole owner cannot be removed either.
    const removeSelf = await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}/members/${ownerAccountId}/remove`,
      {
        method: "POST",
        cookie: jarCookie(ctx.owner),
        body: new URLSearchParams({ _csrf: csrf(ctx.owner) }).toString(),
      },
    );
    assert.equal(removeSelf.statusCode, 409);
  } finally {
    await closeServer(app);
  }
});

test("removing a member revokes console access but keeps their audit trail", async () => {
  const { app, outboxDir } = await createHostedServer({
    HOSTED_OPERATOR_EMAILS: [OPERATOR_EMAIL],
  });
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    const adminEmail = `member-${Date.now()}@example.com`;
    const { invitee: admin, invitationId } = await invite(
      app,
      outboxDir,
      ctx,
      adminEmail,
      "admin",
    );
    assert.ok(invitationId);
    await requestWithCookies(
      app,
      `/organizer/invitations/${invitationId}/accept`,
      {
        method: "POST",
        cookie: jarCookie(admin),
        body: new URLSearchParams({ _csrf: csrf(admin) }).toString(),
      },
    );

    // Before removal the admin can open the management page.
    const before = await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}`,
      { cookie: jarCookie(admin) },
    );
    assert.equal(before.statusCode, 200);

    const manage = await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}?lang=en`,
      { cookie: jarCookie(ctx.owner) },
    );
    // Two members exist; capture every remove-action id. Removing the owner
    // 409s (last owner), removing the admin succeeds.
    const removeIds = [
      ...manage.body.matchAll(/members\/([^/"]+)\/remove/g),
    ].map((m) => m[1]);
    assert.ok(removeIds.length >= 2);

    let removedOk = false;
    for (const id of removeIds) {
      const response = await requestWithCookies(
        app,
        `/organizers/${ctx.organizerId}/members/${id}/remove`,
        {
          method: "POST",
          cookie: jarCookie(ctx.owner),
          body: new URLSearchParams({ _csrf: csrf(ctx.owner) }).toString(),
        },
      );
      if (response.statusCode === 303) removedOk = true;
    }
    assert.ok(removedOk);

    // The removed admin immediately loses console access to the organizer.
    const after = await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}`,
      { cookie: jarCookie(admin) },
    );
    assert.equal(after.statusCode, 404);

    // The owner's activity log still attributes the past acceptance and shows
    // the removal.
    const audit = await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}?lang=en`,
      { cookie: jarCookie(ctx.owner) },
    );
    assert.match(audit.body, /Invitation accepted/);
    assert.match(audit.body, /Member removed/);
  } finally {
    await closeServer(app);
  }
});

test("non-members and signed-out visitors cannot reach an organizer", async () => {
  const { app, outboxDir } = await createHostedServer({
    HOSTED_OPERATOR_EMAILS: [OPERATOR_EMAIL],
  });
  try {
    const ctx = await provisionOrganizer(app, outboxDir);

    const stranger = await signUpAndLogin(
      app,
      outboxDir,
      `outsider-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );
    const asStranger = await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}`,
      { cookie: jarCookie(stranger) },
    );
    assert.equal(asStranger.statusCode, 404);

    const signedOut = await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}`,
    );
    assert.equal(signedOut.statusCode, 303);
    assert.equal(signedOut.headers.location, "/login");
  } finally {
    await closeServer(app);
  }
});
