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
  return fs.mkdtemp(path.join(os.tmpdir(), "wbo-hosted-organizers-"));
}

/**
 * @param {{organizerName?: string, contactName?: string, contactEmail?: string, description?: string}} [overrides]
 */
function applicationInput(overrides = {}) {
  return {
    accountId: "account-1",
    organizerName: "Aurora Collective",
    contactName: "Mika Rin",
    contactEmail: "contact@example.com",
    description: "Monthly community drawing jams.",
    ...overrides,
  };
}

test("a submitted application is pending and its applicant view hides operator-only fields", async () => {
  const store = createFileOrganizerStore({ dataDir: await createDataDir() });
  const result = await store.submitApplication(applicationInput());
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.application.status === "pending");

  const view = store.getApplicantView("account-1");
  assert.ok(view);
  assert.equal(view.status, "pending");
  assert.equal(view.organizerName, "Aurora Collective");
  // The applicant view must never carry the operator-only note or the
  // deciding operator's identity.
  assert.equal("operatorNote" in view, false);
  assert.equal("decidedByAccountId" in view, false);
});

test("a second submission while one is pending is refused deterministically", async () => {
  const store = createFileOrganizerStore({ dataDir: await createDataDir() });
  assert.equal((await store.submitApplication(applicationInput())).ok, true);
  const second = await store.submitApplication(
    applicationInput({ organizerName: "Second Try" }),
  );
  assert.deepEqual(second, { ok: false, reason: "already_pending" });
  assert.equal(store.listPendingApplications().length, 1);
});

test("approval atomically creates one organizer and one owner role", async () => {
  const store = createFileOrganizerStore({ dataDir: await createDataDir() });
  const submitted = await store.submitApplication(applicationInput());
  assert.ok(submitted.ok);
  const applicationId = submitted.application.applicationId;

  const approved = await store.approveApplication({
    applicationId,
    operatorAccountId: "operator-1",
  });
  assert.ok(approved.ok);
  const organizerId = approved.organizerId;

  const organizer = store.getOrganizerById(organizerId);
  assert.ok(organizer);
  assert.equal(organizer.name, "Aurora Collective");
  const roles = store.listRolesForOrganizer(organizerId);
  assert.equal(roles.length, 1);
  const [ownerRole] = roles;
  assert.ok(ownerRole);
  assert.equal(ownerRole.role, "owner");
  assert.equal(ownerRole.accountId, "account-1");

  const application = store.getApplicationById(applicationId);
  assert.ok(application);
  assert.equal(application.status, "approved");
  assert.equal(application.organizerId, organizerId);
  assert.equal(application.decidedByAccountId, "operator-1");
});

test("concurrent approvals never create a second organizer or role", async () => {
  const store = createFileOrganizerStore({ dataDir: await createDataDir() });
  const submitted = await store.submitApplication(applicationInput());
  assert.ok(submitted.ok);
  const applicationId = submitted.application.applicationId;

  const [first, second] = await Promise.all([
    store.approveApplication({ applicationId, operatorAccountId: "op-a" }),
    store.approveApplication({ applicationId, operatorAccountId: "op-b" }),
  ]);
  const successes = [first, second].filter((r) => r.ok);
  const failures = [first, second].filter((r) => !r.ok);
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  const [failure] = failures;
  assert.ok(
    failure && failure.ok === false && failure.reason === "not_pending",
  );

  const application = store.getApplicationById(applicationId);
  assert.ok(application && application.organizerId);
  assert.equal(store.listRolesForOrganizer(application.organizerId).length, 1);
});

test("an approved owner cannot submit a second application", async () => {
  const store = createFileOrganizerStore({ dataDir: await createDataDir() });
  const submitted = await store.submitApplication(applicationInput());
  assert.ok(submitted.ok);
  await store.approveApplication({
    applicationId: submitted.application.applicationId,
    operatorAccountId: "op",
  });
  const second = await store.submitApplication(
    applicationInput({ organizerName: "A Second Organizer" }),
  );
  assert.deepEqual(second, { ok: false, reason: "already_approved" });
});

test("deciding an already-decided application is refused", async () => {
  const store = createFileOrganizerStore({ dataDir: await createDataDir() });
  const submitted = await store.submitApplication(applicationInput());
  assert.ok(submitted.ok);
  const applicationId = submitted.application.applicationId;
  await store.approveApplication({ applicationId, operatorAccountId: "op" });

  assert.deepEqual(
    await store.approveApplication({ applicationId, operatorAccountId: "op" }),
    { ok: false, reason: "not_pending" },
  );
  assert.deepEqual(
    await store.rejectApplication({ applicationId, operatorAccountId: "op" }),
    { ok: false, reason: "not_pending" },
  );
  assert.deepEqual(
    await store.approveApplication({
      applicationId: "does-not-exist",
      operatorAccountId: "op",
    }),
    { ok: false, reason: "not_found" },
  );
});

test("rejection records an operator note that never reaches the applicant view", async () => {
  const store = createFileOrganizerStore({ dataDir: await createDataDir() });
  const submitted = await store.submitApplication(applicationInput());
  assert.ok(submitted.ok);
  const applicationId = submitted.application.applicationId;

  const rejected = await store.rejectApplication({
    applicationId,
    operatorAccountId: "operator-9",
    note: "duplicate of an existing organizer",
  });
  assert.deepEqual(rejected, { ok: true });

  const application = store.getApplicationById(applicationId);
  assert.ok(application);
  assert.equal(application.status, "rejected");
  assert.equal(application.operatorNote, "duplicate of an existing organizer");

  const view = store.getApplicantView("account-1");
  assert.ok(view);
  assert.equal(view.status, "rejected");
  assert.equal(JSON.stringify(view).includes("duplicate of"), false);

  // A rejected applicant may submit a fresh application.
  const reapplied = await store.submitApplication(
    applicationInput({ organizerName: "Aurora Collective v2" }),
  );
  assert.equal(reapplied.ok, true);
});

test("the change audit records submit, approve, and the operator identity", async () => {
  const store = createFileOrganizerStore({ dataDir: await createDataDir() });
  const submitted = await store.submitApplication(applicationInput());
  assert.ok(submitted.ok);
  const applicationId = submitted.application.applicationId;
  await store.approveApplication({
    applicationId,
    operatorAccountId: "operator-7",
  });

  const audit = store.listAuditForApplication(applicationId);
  assert.equal(audit.length, 2);
  const [submittedRecord, approvedRecord] = audit;
  assert.ok(submittedRecord && approvedRecord);
  assert.equal(submittedRecord.action, "organizer_application.submitted");
  assert.equal(submittedRecord.actorKind, "account");
  assert.equal(submittedRecord.actorAccountId, "account-1");
  assert.equal(approvedRecord.action, "organizer_application.approved");
  assert.equal(approvedRecord.actorKind, "operator");
  assert.equal(approvedRecord.actorAccountId, "operator-7");
});

test("state survives a store reload from disk", async () => {
  const dataDir = await createDataDir();
  const store = createFileOrganizerStore({ dataDir });
  const submitted = await store.submitApplication(applicationInput());
  assert.ok(submitted.ok);
  const applicationId = submitted.application.applicationId;
  const approved = await store.approveApplication({
    applicationId,
    operatorAccountId: "operator-1",
  });
  assert.ok(approved.ok);
  await store.flush();

  const reloaded = createFileOrganizerStore({ dataDir });
  const application = reloaded.getApplicationById(applicationId);
  assert.ok(application);
  assert.equal(application.status, "approved");
  assert.ok(reloaded.getOrganizerById(approved.organizerId));
  assert.equal(reloaded.listRolesForOrganizer(approved.organizerId).length, 1);
  assert.equal(reloaded.listAuditForApplication(applicationId).length, 2);
});

test("a controlled clock stamps application and audit times", async () => {
  let now = 1_000;
  const store = createFileOrganizerStore({
    dataDir: await createDataDir(),
    clock: () => now,
  });
  const submitted = await store.submitApplication(applicationInput());
  assert.ok(submitted.ok);
  assert.equal(submitted.application.createdAtMs, 1_000);
  now = 5_000;
  const approved = await store.approveApplication({
    applicationId: submitted.application.applicationId,
    operatorAccountId: "op",
  });
  assert.ok(approved.ok);
  const application = store.getApplicationById(
    submitted.application.applicationId,
  );
  assert.ok(application);
  assert.equal(application.decidedAtMs, 5_000);
});
