# Hosted Event Service — Operations Runbook

This runbook defines the repeatable operating procedures for the Hosted
Event Service: backup and recovery, capacity commitments, failure
playbooks, operational signals, and deployment constraints. The recorded
results of the launch acceptance evidence live in
[launch-evidence.md](./launch-evidence.md).

The production profile uses self-hosted PostgreSQL and a private Cloudflare R2
bucket (ADR 0011). File-backed adapters remain available for tests and local
trials only. PostgreSQL, R2, and their off-host backups form the recovery
boundary; the application host does not.

## 1. Durable state inventory

| Store | Contents | Recovery behavior |
| --- | --- | --- |
| PostgreSQL `wbo_hosted_state_documents` | Versioned JSONB documents for accounts, sessions and tokens; organizers, reservations, Events and Board Sessions; memberships and bans; Change Audit and moderation; API credentials and grants; notification and webhook queues; publication, Brand Asset, Historical Archive, and Export Job metadata. | Each store mutation replaces all of that store's documents in one transaction. The one active app loads them before listen and holds an advisory lock until shutdown. |
| PostgreSQL `wbo_board_mutation_ledger` | One ordered row per accepted persistent board mutation, keyed by board name and sequence. | The row commits before sender confirmation. It is authoritative after the latest SVG snapshot and can rebuild a missing cache. |
| Private R2 keys under `WBO_HOSTED_S3_PREFIX` | `board-archives/`, `published-canvases/`, `historical-archives/`, `brand-assets/`, and `image-exports/`. | Writes are immutable and idempotent; retention enumerates and deletes internal keys. Archive manifests remain the commit marker. |
| Local `WBO_HISTORY_DIR` | Current board SVG snapshots and `.bak` staging. | Disposable projection cache. Unreadable snapshots are quarantined and rebuilt from PostgreSQL ledger rows. |

Session ids, single-use account tokens, Access Codes, API credentials, and
share secrets remain digest-only. R2 object keys are internal and must never be
used as public credentials.

## 2. Backup and PITR

### 2.1 What makes a valid backup

A production backup has both parts:

1. A PostgreSQL physical base backup plus continuously archived WAL, stored
   off the database host and tested with a `recovery_target_time`. `pg_dump`
   is useful for logical exports but is not PITR and does not satisfy this
   requirement by itself. Configure WAL shipping or a synchronous standby so
   site-loss RPO remains at most 5 seconds.
2. An independent copy of the private R2 prefix, in another failure and
   credential boundary, with enough history to restore objects deleted by a
   mistaken retention action or compromised credential. R2 durability protects
   stored bytes from infrastructure loss; it is not a backup against a valid
   delete request. A Bucket Lock may be used only when its prefix and retention
   period do not prevent the application's required outcome deletion.

The local `board-cache` volume is optional in backup. Keep database and object
backup timestamps together in the backup catalog. Retention must cover the
90-day outcome window plus audit obligations.

### 2.2 Point-in-time recovery

PostgreSQL restores mutable state and accepted mutations to the chosen target.
The restored R2 copy must contain every object referenced by that database
state; extra immutable objects are harmless and can be reconciled later.
Pending notification, webhook, archive, export, and purge records then re-drive
idempotently. Local snapshots are projections and may be restored for speed or
discarded and rebuilt from the ledger.

### 2.3 Restore procedure

1. Stop the application and provision the pinned application version in an
   isolated recovery environment.
2. Restore PostgreSQL from the latest base backup and WAL to the target time.
3. Restore any missing R2 objects from the independent object backup. Keep the
   production bucket untouched; perform drills against a separate bucket and
   prefix.
4. Start with an empty `WBO_HISTORY_DIR` unless a matching cache snapshot is
   available. Run `npm run check:hosted-storage` before starting the app.
5. Start exactly one application process. Recovery is automatic; do not edit
   JSONB documents, ledger rows, or manifests by hand.
6. Verify per `launch-evidence.md`: accounts sign in, a board snapshot rebuilds,
   sessions advance, `archive_failed` work retries, queues drain, authorized R2
   artifacts read correctly, and the source-code links resolve to the public
   repository.

## 3. Monthly recovery drill

Run monthly and record the result in `launch-evidence.md`:

1. Keep the fast contract tests green:
   `WBO_TEST_POSTGRES_URL=<isolated-url> node --test test-node/hosted_storage_adapters.test.js`
   exercises PostgreSQL restart, ordered ledger recovery, the single-instance
   lock, and the S3 protocol contract. The existing
   `test-node/hosted_recovery_drill.test.js` still exercises every pipeline
   against disposable file adapters.
2. In staging, record a target time, accept a mutation, force an archive
   failure, and enqueue one notice and webhook. Restore the latest production
   PostgreSQL base backup plus WAL and the matching R2 backup into isolated
   targets, then follow §2.3.
3. Record application version, database and object backup ids, target time,
   measured RPO/RTO, operator, and anomalies.

Pass criteria: no confirmed mutation older than the 5-second RPO boundary is
lost; serving resumes within 15 minutes; the ledger, permissions, referenced
R2 objects, and task queues agree; every pending task completes exactly as its
idempotency contract permits. Adapter tests alone are not production backup
evidence.

## 4. Capacity commitments and rejection behavior

| Commitment | Enforcement point | Rejection behavior |
| --- | --- | --- |
| ≤ 20 overlapping Board Sessions | `approveReservation` (`sessionLimit`) | `reason: "capacity"` with the would-be peak (`maxSessions`); reservation stays submitted, operator can reject or reschedule. |
| ≤ 1,000 Participant Seats overlapping | `approveReservation` (`seatLimit`) | Same deterministic `capacity` refusal with `maxSeats`. |
| 1–50 seats per session | Reservation form validation (`HOSTED_MAX_RESERVATION_SEATS`) | Form error `hosted_reservation_error_seats`. |
| Overlapping windows buffer ±15 min | Capacity window computation | Sessions just outside each other's window never consume each other's capacity. |

Store-level proof: `test-node/hosted_capacity_limits.test.js` (exactly at
both limits is approved; the 21st session and the 1,001st seat are refused;
concurrent approvals never oversell — see also
`test-node/hosted_reservation_store.test.js`). Load validation against the
deployment target is a launch checklist item (below).

## 5. Operational signals

Counters (`wbo.*`): HTTP request metrics, `wbo.socket.connection` and
`.replay`, `wbo.board.message`, `wbo.hosted.board_archive`
(`archived`/`failed` + deterministic failure code), `wbo.hosted.board_export`,
`wbo.hosted.webhook_delivery` (`delivered`/`failed` + failure kind),
`wbo.hosted.outcome_purge`, `wbo.hosted.notice` (by kind),
`wbo.hosted.historical_import`, Turnstile verifications,
`http.server.request.duration`, board operation durations (load, save,
rewrite — `recordBoardOperationDuration`).

Gauges: `wbo.board.loaded`, `wbo.socket.connection.active`,
`wbo.board.user.connected`, `wbo.hosted.capacity.board_sessions_active`,
`wbo.hosted.capacity.seats_committed` (the last two are pushed on every
lifecycle pass and read directly against the 20-session / 1,000-seat
limits).

Minimum alert set: archive close failures > 0 for 15 min, webhook delivery
failure rate > 20% over 30 min, notice queue retry age > 1 h, purge
failures > 0, active sessions ≥ 18 (90% of the session limit), committed
seats ≥ 900, p95 board save duration over the save-interval budget, HTTP
5xx rate. Failure detail fields (`failure.code`, `last_error`) are
deterministic labels — never raw errors from external hosts.

Log hygiene (enforced by review; the response-level behaviors that keep
secrets out of pages and errors are covered by the account, credential,
and webhook test suites): structured logs carry
identifiers (`account_id`, `subscription_id`, board names) and
deterministic codes only. Passwords, password hashes, verification/reset
tokens, session ids, Access Codes, API credential secrets, webhook signing
secrets, Entry Grants, participant emails, webhook endpoint URLs, and raw
canvas content must never appear in logs or alerts. Enumeration-safe
login/account flows and one-time reveals are covered by the account,
credential, and webhook suites.

## 6. Deployment

Standing an instance up for the first time — required configuration, the
reverse-proxy and HTTPS requirements, the data roots to mount, and the
first-Organizer bootstrap order — is [deployment.md](./deployment.md). This
section covers the constraints that hold for every deploy afterwards.

- **Single active application instance.** Exactly one process serves HTTP
  and Socket.IO for the deployment; scale-out is a post-launch decision
  that requires moving the seat/connection accounting first. Everything
  else (all durable state above) already lives in PostgreSQL and R2: a restart
  — planned or crashed — loses no committed state.
- **Rolling restart procedure:** drain (stop intake, let the lifecycle
  poker seal), stop, deploy the pinned version, start. The durable task
  queues catch up through the persisted times; the lifecycle poker and
  every pipeline are idempotent catch-ups, not timers.
- **Source disclosure:** there is no `/source` page; the source-code links
  on the board chrome and the hosted footer point at the public project
  repository (https://github.com/Eitrous/SukimaCanvas). Verify after every
  deploy that those links resolve.
- Configuration: all `WBO_HOSTED_*` fields are startup-only
  (`server/configuration.mjs`); never mutate them per request, and never
  persist secrets outside the platform secret store (`AUTH_SECRET_KEY`
  derives participant identifiers and the webhook/export HMAC material).

## 7. Failure playbooks

- **Archive close failure** (`archive_failed`): automatic backoff retry
  (`WBO_HOSTED_BOARD_SESSION_ARCHIVE_RETRY_MS`); operator retry from
  `/operator` if the fault persists. Never fake a close.
- **Webhook suspension**: Owners are notified; they fix the endpoint and
  resume from the organizer console — queued records deliver. Rotation
  works while suspended.
- **Notice/mail retries**: visible on the operator console with recipient
  and last deterministic error; backoff doubles to one hour.
- **Outcome purge failure**: durable context on the event; operator retry
  route `POST /operator/events/{eventId}/outcome-purge-retry`.
- **Ledger corruption**: loads fail loudly (never silently skipped); if a
  restore is needed, follow §2.3 and re-run the drill checklist.
- **Export failures**: deterministic codes on the job record; re-request a
  fresh export after fixing storage.

## 8. Open items before launch

1. **Legal review (required, external):** Terms of Service and Privacy
   Policy for mainland China must be reviewed and approved by legal
   counsel. This runbook and the evidence record do not substitute for
   that review.
2. **Production recovery proof:** configure off-host PostgreSQL base
   backups/WAL archiving and an independent R2 copy, then pass and record the
   real restore drill in §3. Adapter selection and code-level restart tests are
   complete; infrastructure backup evidence is not.
3. Full-scale load validation on the production-shaped deployment target
   (see `launch-evidence.md` §Capacity).
