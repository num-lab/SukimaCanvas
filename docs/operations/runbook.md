# Hosted Event Service — Operations Runbook

This runbook defines the repeatable operating procedures for the Hosted
Event Service: backup and recovery, capacity commitments, failure
playbooks, operational signals, and deployment constraints. The recorded
results of the launch acceptance evidence live in
[launch-evidence.md](./launch-evidence.md).

The first release runs on the file-backed adapters described below. The
procedures are written so the adapter can be swapped to PostgreSQL and
S3-compatible object storage (see `docs/adr/0005-use-database-backed-work-for-lifecycle-and-delivery.md`
and `docs/adr/0007-store-board-artifacts-in-object-storage.md`) without
changing the recovery contract — every durable subsystem writes
crash-consistent records and recovers from disk alone.

## 1. Durable state inventory

Everything the service needs to rebuild itself lives under one data root,
`WBO_HOSTED_DATA_DIR` (default `<cwd>/hosted-data`), plus the WBO board
history directory `WBO_HISTORY_DIR`:

| Subsystem | File(s) | Recovery behavior |
| --- | --- | --- |
| Accounts, sessions, tokens | `accounts.json`, `sessions.json`, `verifications.json`, `resets.json` | Atomic tmp+rename writes; session ids and single-use tokens stored as SHA-256 digests only. |
| Organizers, reservations, events, sessions | `organizers.json`, `organizer_roles.json`, `reservations.json`, `events.json`, `board_sessions.json`, `event_moderators.json` | Atomic writes; lifecycle fields hydrate onto older records without migration. |
| Change Audit | `change_audit.json` | Append-only administrative trail (internal Account ids only). |
| Board snapshots | `WBO_HISTORY_DIR/<board>.svg` (+ `.bak` staging) | Rebuildable projection of the ledger; unreadable snapshots are quarantined (`svg.snapshot_unreadable_quarantined`). |
| Mutation ledger (Change Audit of board writes) | `mutation-ledger/<board>.jsonl` | fsync per acceptance before the sender is confirmed; torn tails repaired on read. |
| Private Board Archives | `board-archives/<boardSessionId>/{canvas.svg,ledger.jsonl,manifest.json}` | Manifest written last as the commit marker; interrupted closes retry safely. |
| Published Canvas objects | `board-archives/published-canvases/<boardSessionId>/<generation>.svg` | Immutable derived artifacts keyed by generation. |
| Image Exports | `board-exports/index.json`, `board-exports/<exportId>.png` | Jobs survive restarts; `processing` jobs re-queue. |
| Notification queue (mail) | `notifications.json` | Idempotent enqueue; sent records shrink to tombstones. |
| Webhook subscriptions + outbox | `webhooks.json`, `webhook_outbox.json` | Idempotent dedupe keys; delivered entries shrink to tombstones after 30 days. |
| Moderation log | `moderation_log.json` | Append-only governance trail. |
| Brand assets, historical imports | `assets/`, historical import store | Stored only after real image/format validation. |

## 2. Backup and PITR

### 2.1 What makes a valid backup

Every durable file is written atomically (temp file + rename) or
fsync-appended (ledger), and every multi-object write has a commit marker
written last (archive manifests, export records after bytes). This means a
**crash-consistent volume snapshot** of the data root taken at any instant
is a valid backup: the recovery paths tolerate exactly the states a crash
can produce (torn ledger tails are repaired on read; marker-less archive
objects are re-written by the close retry; ledger replays fill snapshots).

Accepted procedure (either is valid):

1. **Volume/Filesystem snapshot** of `WBO_HOSTED_DATA_DIR` and
   `WBO_HISTORY_DIR` (ZFS/btrfs/LVM/EBS snapshot). No application quiesce
   is required; snapshots are crash-consistent by construction.
2. **Quiesced copy** (lowest risk on plain filesystems): stop the single
   active application process, copy the two directories, restart. RTO of
   the copy window is seconds.

Frequency: snapshots at least every 15 minutes, shipped off-host. Retention
aligns with the outcome retention period (90 days) plus audit obligations.

### 2.2 Point-in-time recovery

Board state is reconstructable to any point in time:

- Snapshots are projections; the mutation ledger is authoritative.
- Restoring the data root to a snapshot and replaying the ledger rebuilds
  every accepted write with `acceptedAtMs <= target`.
- The ledger file itself must be backed up continuously (it is
  fsync-appended only, so log-shipping or frequent snapshots both work).
- Non-board state (accounts, organizers, queues) restores to the snapshot
  instant; the durable task queues (notices, webhook outbox, archive
  retries) then re-drive every pending task forward.

When PostgreSQL and S3-compatible object storage are selected, the same
procedures map to: continuous WAL archiving (PITR) for the database,
versioned bucket replication + lifecycle rules for objects, and the same
monthly drill.

### 2.3 Restore procedure

1. Provision a host with the deployed application version
   (`WBO_DEPLOYMENT_VERSION` pinned).
2. Restore the two directories from the snapshot (and re-ship the latest
   ledger tails when log-shipping is used).
3. Start the process. Recovery is automatic: no manual state surgery is
   permitted or needed.
4. Verify per the drill checklist in `launch-evidence.md`: accounts sign
   in, sessions advance, `archive_failed` tasks retry, queues drain, the
   Source page reports the pinned version.

## 3. Monthly recovery drill

Run monthly; record the result row in `launch-evidence.md`:

1. Snapshot the data root of a staging host (or restore the latest
   production snapshot into staging).
2. Run the automated equivalent: `node --test test-node/hosted_recovery_drill.test.js`
   — it composes the real subsystems, accepts a persistent write through
   the ledger fsync boundary, fails an archive task, queues a webhook event
   and a notice, then **restarts every store and pipeline from disk alone**
   and verifies: zero confirmed writes lost (RPO), the failed task is
   visible and due, the webhook outbox and notice queue are intact,
   permission boundaries (roles, memberships, Event Bans) are unchanged,
   and the recovery finishes the archive, drains the outbox, and delivers
   the notice (RTO far inside 15 minutes).
3. Record: measured RTO (process restart to serving), RPO (confirmed
   writes lost — expected 0), drill operator, date, and any anomalies.

Pass criteria: RPO ≤ 5 seconds (the fsync-before-confirm contract makes
the measured window zero for confirmed writes), RTO ≤ 15 minutes measured
on the drill host (the automated drill completes in well under a second;
on the deployment target the restore copy time is added), and every
consistency check in the drill green. The drill covers both recovery
paths: restart from the live data root and restore from a crash-consistent
backup with re-shipped ledger tails (PITR).

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

- **Single active application instance.** Exactly one process serves HTTP
  and Socket.IO for the deployment; scale-out is a post-launch decision
  that requires moving the seat/connection accounting first. Everything
  else (all durable state above) already lives outside the process: a
  restart — planned or crashed — loses nothing and recovers from disk.
- **Rolling restart procedure:** drain (stop intake, let the lifecycle
  poker seal), stop, deploy the pinned version, start. The durable task
  queues catch up through the persisted times; the lifecycle poker and
  every pipeline are idempotent catch-ups, not timers.
- **Source disclosure:** the deployment pins `WBO_DEPLOYMENT_VERSION`,
  `WBO_CORRESPONDING_SOURCE_URL` (with `{version}`), and
  `WBO_CORRESPONDING_SOURCE_BUILD`. The `/source` page serves exactly the
  version-pinned mapping and fails closed (503) when the mapping is
  missing — verify after every deploy that `/source` reports the new
  immutable version.
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
2. PostgreSQL and S3-compatible object storage adapters are not selected
   yet; §2 documents the contract they must satisfy.
3. Full-scale load validation on the production-shaped deployment target
   (see `launch-evidence.md` §Capacity).
