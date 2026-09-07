/**
 * Event-scoped governance for the Hosted Event Service.
 *
 * This module coordinates the moderation stores behind one contract: the
 * durable Event Ban lives in the membership store (it gates admission), the
 * human-readable trail lives in the moderation log (operator, reason, frozen
 * participant identity), and the identity projection derives event-scoped
 * Participant Identifiers without ever exposing emails or Account ids to the
 * board. Socket effects (evictions, live access refreshes) are applied by the
 * socket layer through the moderation socket-effects registry; this module
 * only decides and records.
 *
 * @param {{
 *   organizerStore: ReturnType<typeof import("../organizers/store.mjs").createFileOrganizerStore>,
 *   membershipStore: ReturnType<typeof import("../memberships/store.mjs").createFileEventMembershipStore>,
 *   moderationStore: ReturnType<typeof import("./store.mjs").createFileModerationStore>,
 *   participantIdentifierFor: (eventId: string, accountId: string) => string,
 * }} dependencies
 */
function createEventModeration(dependencies) {
  const { organizerStore, membershipStore, moderationStore } = dependencies;
  const participantIdentifierFor = dependencies.participantIdentifierFor;

  /**
   * Records a participant report against another online participant of the
   * same event. The reported identity is frozen as observed; the reporter is
   * recorded as the operator. The store clamps display names and keeps the
   * internal Account ids for later resolution.
   *
   * @param {{
   *   eventId: string,
   *   reporterAccountId: string,
   *   reportedAccountId: string,
   *   reportedParticipantId: string,
   *   reportedName: string,
   *   reason?: string,
   * }} input
   * @returns {Promise<void>}
   */
  async function recordEventReport(input) {
    await moderationStore.record({
      eventId: input.eventId,
      action: "report",
      operatorAccountId: input.reporterAccountId,
      targetAccountId: input.reportedAccountId,
      targetParticipantId: input.reportedParticipantId,
      targetName: input.reportedName,
      reason: input.reason || "",
    });
  }

  /**
   * Applies a moderator disposition and records it with the operator and
   * reason. `ban` revokes the target's membership and creates the durable
   * Event Ban that overrides Access Codes, memberships, and future Entry
   * Grants; `unban` lifts it without resurrecting the membership. Warn and
   * kick only record — their real-time delivery is the caller's job.
   *
   * @param {{
   *   eventId: string,
   *   action: "warn" | "kick" | "ban" | "unban",
   *   reason: string,
   *   operatorAccountId: string,
   *   targetAccountId: string,
   *   targetParticipantId: string | null,
   *   targetName: string,
   * }} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "not_banned"}>}
   */
  async function applyModeration(input) {
    if (input.action === "ban") {
      await membershipStore.banEvent({
        eventId: input.eventId,
        accountId: input.targetAccountId,
      });
    } else if (input.action === "unban") {
      const unbanned = await membershipStore.unbanEvent({
        eventId: input.eventId,
        accountId: input.targetAccountId,
      });
      if (unbanned.ok === false) return unbanned;
    }
    await moderationStore.record({
      eventId: input.eventId,
      action: input.action,
      operatorAccountId: input.operatorAccountId,
      targetAccountId: input.targetAccountId,
      targetParticipantId: input.targetParticipantId,
      targetName: input.targetName,
      reason: input.reason,
    });
    return { ok: true };
  }

  /**
   * Records an Entry Lock change with the operator and reason. The organizer
   * store's own audit keeps the administrative trail; this adds the
   * governance-readable record with the reason.
   *
   * @param {{eventId: string, locked: boolean, operatorAccountId: string, reason?: string}} input
   * @returns {Promise<void>}
   */
  async function recordEntryLockChange(input) {
    await moderationStore.record({
      eventId: input.eventId,
      action: input.locked ? "lock" : "unlock",
      operatorAccountId: input.operatorAccountId,
      reason: input.reason || "",
    });
  }

  /**
   * Records a destructive Clear with the operator and reason. The board's
   * mutation ledger remains the technical audit; this makes the Clear visible
   * beside the other governance actions.
   *
   * @param {{eventId: string, operatorAccountId: string, reason: string}} input
   * @returns {Promise<void>}
   */
  async function recordClear(input) {
    await moderationStore.record({
      eventId: input.eventId,
      action: "clear",
      operatorAccountId: input.operatorAccountId,
      reason: input.reason,
    });
  }

  /**
   * The current Event Ban list projected for governance UIs: each banned
   * account's event-scoped Participant Identifier and the display name frozen
   * on its most recent ban record. No emails or Account ids.
   *
   * @param {string} eventId
   * @returns {Promise<{accountId: string, participantId: string, name: string, bannedAtMs: number}[]>}
   */
  async function eventBanSummaries(eventId) {
    const bans = membershipStore.listEventBans(eventId);
    return bans.map((ban) => {
      const banRecord = moderationStore.latestForTarget(
        eventId,
        ban.accountId,
        "ban",
      );
      return {
        accountId: ban.accountId,
        participantId: participantIdentifierFor(eventId, ban.accountId),
        name: banRecord?.targetName || "",
        bannedAtMs: ban.createdAtMs,
      };
    });
  }

  /**
   * Moderation records for the console's governance trail, newest first.
   * Operator Account ids are resolved to emails by the route layer; records
   * themselves stay identity-minimal for the target.
   *
   * @param {string} eventId
   * @param {number} [limit]
   * @returns {Promise<import("./store.mjs").StoredModerationRecord[]>}
   */
  async function listEventModeration(eventId, limit) {
    return moderationStore.listForEvent(eventId, { limit });
  }

  /**
   * Whether the account holds a governance role for the event: an
   * Organizer Owner/Admin role, or the per-event Event Moderator grant.
   *
   * @param {import("../organizers/store.mjs").StoredEvent} event
   * @param {string} accountId
   * @returns {boolean}
   */
  function hasEventGovernanceRole(event, accountId) {
    const role = organizerStore.getMemberRole(event.organizerId, accountId);
    if (role === "owner" || role === "admin") return true;
    return organizerStore.isEventModerator(event.eventId, accountId);
  }

  return {
    recordEventReport,
    applyModeration,
    recordEntryLockChange,
    recordClear,
    eventBanSummaries,
    listEventModeration,
    hasEventGovernanceRole,
  };
}

export { createEventModeration };
