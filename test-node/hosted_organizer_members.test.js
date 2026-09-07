const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  createFileOrganizerStore,
} = require("../server/hosted_event/organizers/store.mjs");

/**
 * @returns {Promise<string>}
 */
async function createDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "wbo-hosted-members-"));
}

/**
 * Creates an approved organizer owned by "owner-1" and returns its id.
 *
 * @param {ReturnType<typeof createFileOrganizerStore>} store
 * @param {string} [ownerAccountId]
 * @returns {Promise<string>}
 */
async function setupOrganizer(store, ownerAccountId = "owner-1") {
  const submitted = await store.submitApplication({
    accountId: ownerAccountId,
    organizerName: "Aurora Collective",
    contactName: "Mika Rin",
    contactEmail: "owner@example.com",
    description: "Community jams.",
  });
  assert.ok(submitted.ok);
  const approved = await store.approveApplication({
    applicationId: submitted.application.applicationId,
    operatorAccountId: "operator-1",
  });
  assert.ok(approved.ok);
  return approved.organizerId;
}

test("an owner invites an account and the target accepts to become a member", async () => {
  const store = createFileOrganizerStore({ dataDir: await createDataDir() });
  const organizerId = await setupOrganizer(store);

  const created = await store.createInvitation({
    organizerId,
    email: "Invitee@Example.com",
    role: "admin",
    invitedByAccountId: "owner-1",
  });
  assert.ok(created.ok);
  assert.equal(created.invitation.status, "pending");
  assert.equal(created.invitation.email, "invitee@example.com");

  // The invitee sees the invitation with the organizer name resolved.
  const pending = store.listPendingInvitationsForEmail("invitee@example.com");
  assert.equal(pending.length, 1);
  const [invite] = pending;
  assert.ok(invite);
  assert.equal(invite.organizerName, "Aurora Collective");
  assert.equal(invite.role, "admin");

  const accepted = await store.acceptInvitation({
    invitationId: created.invitation.invitationId,
    accountId: "invitee-1",
    accountEmail: "invitee@example.com",
  });
  assert.ok(accepted.ok);
  assert.equal(store.getMemberRole(organizerId, "invitee-1"), "admin");
  assert.equal(store.listMembers(organizerId).length, 2);
  // The consumed invitation no longer appears as pending anywhere.
  assert.equal(
    store.listPendingInvitationsForEmail("invitee@example.com").length,
    0,
  );
});

test("only the target account can accept an invitation", async () => {
  const store = createFileOrganizerStore({ dataDir: await createDataDir() });
  const organizerId = await setupOrganizer(store);
  const created = await store.createInvitation({
    organizerId,
    email: "invitee@example.com",
    role: "admin",
    invitedByAccountId: "owner-1",
  });
  assert.ok(created.ok);

  const wrongRecipient = await store.acceptInvitation({
    invitationId: created.invitation.invitationId,
    accountId: "stranger-1",
    accountEmail: "stranger@example.com",
  });
  assert.deepEqual(wrongRecipient, { ok: false, reason: "invalid" });
  assert.equal(store.getMemberRole(organizerId, "stranger-1"), null);
});

test("invalid, revoked, declined, and used invitations cannot establish membership", async () => {
  const store = createFileOrganizerStore({ dataDir: await createDataDir() });
  const organizerId = await setupOrganizer(store);
  /** @param {string} email */
  const invite = async (email) => {
    const created = await store.createInvitation({
      organizerId,
      email,
      role: "admin",
      invitedByAccountId: "owner-1",
    });
    assert.ok(created.ok);
    return created.invitation.invitationId;
  };

  // Unknown id.
  assert.deepEqual(
    await store.acceptInvitation({
      invitationId: "nope",
      accountId: "a",
      accountEmail: "a@example.com",
    }),
    { ok: false, reason: "invalid" },
  );

  // Revoked.
  const revokedId = await invite("revoked@example.com");
  await store.revokeInvitation({
    invitationId: revokedId,
    actorAccountId: "owner-1",
  });
  assert.deepEqual(
    await store.acceptInvitation({
      invitationId: revokedId,
      accountId: "r",
      accountEmail: "revoked@example.com",
    }),
    { ok: false, reason: "invalid" },
  );

  // Declined.
  const declinedId = await invite("declined@example.com");
  await store.declineInvitation({
    invitationId: declinedId,
    accountId: "d",
    accountEmail: "declined@example.com",
  });
  assert.deepEqual(
    await store.acceptInvitation({
      invitationId: declinedId,
      accountId: "d",
      accountEmail: "declined@example.com",
    }),
    { ok: false, reason: "invalid" },
  );

  // Used (single-use).
  const usedId = await invite("used@example.com");
  assert.ok(
    (
      await store.acceptInvitation({
        invitationId: usedId,
        accountId: "u",
        accountEmail: "used@example.com",
      })
    ).ok,
  );
  assert.deepEqual(
    await store.acceptInvitation({
      invitationId: usedId,
      accountId: "u",
      accountEmail: "used@example.com",
    }),
    { ok: false, reason: "invalid" },
  );
});

test("invitations expire after their TTL on server-authoritative time", async () => {
  let now = 1_000;
  const store = createFileOrganizerStore({
    dataDir: await createDataDir(),
    clock: () => now,
    invitationTtlMs: 5_000,
  });
  const organizerId = await setupOrganizer(store);
  const created = await store.createInvitation({
    organizerId,
    email: "invitee@example.com",
    role: "admin",
    invitedByAccountId: "owner-1",
  });
  assert.ok(created.ok);
  now = 6_001; // past the 5s TTL
  assert.equal(
    store.listPendingInvitationsForEmail("invitee@example.com").length,
    0,
  );
  assert.deepEqual(
    await store.acceptInvitation({
      invitationId: created.invitation.invitationId,
      accountId: "invitee-1",
      accountEmail: "invitee@example.com",
    }),
    { ok: false, reason: "invalid" },
  );
});

test("concurrent accepts establish membership exactly once", async () => {
  const store = createFileOrganizerStore({ dataDir: await createDataDir() });
  const organizerId = await setupOrganizer(store);
  const created = await store.createInvitation({
    organizerId,
    email: "invitee@example.com",
    role: "admin",
    invitedByAccountId: "owner-1",
  });
  assert.ok(created.ok);

  const [first, second] = await Promise.all([
    store.acceptInvitation({
      invitationId: created.invitation.invitationId,
      accountId: "invitee-1",
      accountEmail: "invitee@example.com",
    }),
    store.acceptInvitation({
      invitationId: created.invitation.invitationId,
      accountId: "invitee-1",
      accountEmail: "invitee@example.com",
    }),
  ]);
  assert.equal([first, second].filter((r) => r.ok).length, 1);
  assert.equal([first, second].filter((r) => !r.ok).length, 1);
  assert.equal(store.listMembers(organizerId).length, 2);
});

test("duplicate invitations and inviting existing members are refused", async () => {
  const store = createFileOrganizerStore({ dataDir: await createDataDir() });
  const organizerId = await setupOrganizer(store);

  assert.ok(
    (
      await store.createInvitation({
        organizerId,
        email: "invitee@example.com",
        role: "admin",
        invitedByAccountId: "owner-1",
      })
    ).ok,
  );
  const duplicate = await store.createInvitation({
    organizerId,
    email: "invitee@example.com",
    role: "admin",
    invitedByAccountId: "owner-1",
  });
  assert.deepEqual(duplicate, { ok: false, reason: "already_invited" });

  const existingMember = await store.createInvitation({
    organizerId,
    email: "owner@example.com",
    role: "admin",
    invitedByAccountId: "owner-1",
    memberAccountId: "owner-1",
  });
  assert.deepEqual(existingMember, { ok: false, reason: "already_member" });

  const badRole = await store.createInvitation({
    organizerId,
    email: "other@example.com",
    role: /** @type {any} */ ("superuser"),
    invitedByAccountId: "owner-1",
  });
  assert.deepEqual(badRole, { ok: false, reason: "invalid_role" });
});

test("owner role changes respect the last-owner guarantee", async () => {
  const store = createFileOrganizerStore({ dataDir: await createDataDir() });
  const organizerId = await setupOrganizer(store);
  // Add an admin via invitation.
  const created = await store.createInvitation({
    organizerId,
    email: "admin@example.com",
    role: "admin",
    invitedByAccountId: "owner-1",
  });
  assert.ok(created.ok);
  await store.acceptInvitation({
    invitationId: created.invitation.invitationId,
    accountId: "admin-1",
    accountEmail: "admin@example.com",
  });

  // Cannot demote the sole owner.
  assert.deepEqual(
    await store.changeMemberRole({
      organizerId,
      targetAccountId: "owner-1",
      newRole: "admin",
      actorAccountId: "owner-1",
    }),
    { ok: false, reason: "last_owner" },
  );

  // Promote the admin to owner, then the original owner can be demoted.
  assert.ok(
    (
      await store.changeMemberRole({
        organizerId,
        targetAccountId: "admin-1",
        newRole: "owner",
        actorAccountId: "owner-1",
      })
    ).ok,
  );
  assert.ok(
    (
      await store.changeMemberRole({
        organizerId,
        targetAccountId: "owner-1",
        newRole: "admin",
        actorAccountId: "admin-1",
      })
    ).ok,
  );
  assert.equal(store.getMemberRole(organizerId, "owner-1"), "admin");

  // Role changes on a non-member fail.
  assert.deepEqual(
    await store.changeMemberRole({
      organizerId,
      targetAccountId: "ghost",
      newRole: "admin",
      actorAccountId: "admin-1",
    }),
    { ok: false, reason: "not_member" },
  );
});

test("removing a member respects the last-owner guarantee and keeps audit intact", async () => {
  const store = createFileOrganizerStore({ dataDir: await createDataDir() });
  const organizerId = await setupOrganizer(store);
  const created = await store.createInvitation({
    organizerId,
    email: "admin@example.com",
    role: "admin",
    invitedByAccountId: "owner-1",
  });
  assert.ok(created.ok);
  await store.acceptInvitation({
    invitationId: created.invitation.invitationId,
    accountId: "admin-1",
    accountEmail: "admin@example.com",
  });

  // The sole owner cannot be removed.
  assert.deepEqual(
    await store.removeMember({
      organizerId,
      targetAccountId: "owner-1",
      actorAccountId: "owner-1",
    }),
    { ok: false, reason: "last_owner" },
  );

  // The admin can be removed and immediately loses membership.
  assert.ok(
    (
      await store.removeMember({
        organizerId,
        targetAccountId: "admin-1",
        actorAccountId: "owner-1",
      })
    ).ok,
  );
  assert.equal(store.getMemberRole(organizerId, "admin-1"), null);

  // The removed member's historical actions are still attributed to them.
  const audit = store.listAuditForOrganizer(organizerId);
  const accepted = audit.find(
    (r) => r.action === "organizer_invitation.accepted",
  );
  assert.ok(accepted);
  assert.equal(accepted.actorAccountId, "admin-1");
  assert.ok(
    audit.some(
      (r) =>
        r.action === "organizer_member.removed" &&
        r.actorAccountId === "owner-1",
    ),
  );
});

test("membership and invitations survive a store reload", async () => {
  const dataDir = await createDataDir();
  const store = createFileOrganizerStore({ dataDir });
  const organizerId = await setupOrganizer(store);
  const created = await store.createInvitation({
    organizerId,
    email: "invitee@example.com",
    role: "admin",
    invitedByAccountId: "owner-1",
  });
  assert.ok(created.ok);
  await store.acceptInvitation({
    invitationId: created.invitation.invitationId,
    accountId: "invitee-1",
    accountEmail: "invitee@example.com",
  });
  await store.flush();

  const reloaded = createFileOrganizerStore({ dataDir });
  assert.equal(reloaded.getMemberRole(organizerId, "invitee-1"), "admin");
  assert.equal(reloaded.listMembers(organizerId).length, 2);
  const [membership] = reloaded.listOrganizersForAccount("invitee-1");
  assert.ok(membership);
  assert.equal(membership.name, "Aurora Collective");
});
