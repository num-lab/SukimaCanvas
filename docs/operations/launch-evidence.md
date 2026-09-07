# Hosted Event Service — Launch Acceptance Evidence

Recorded evidence for the pre-launch acceptance gates of issue 23. The
procedures live in [runbook.md](./runbook.md). Each row records what was
run, when, and the measured result, so the next drill or regression has a
baseline to compare against.

Recorded: 2026-09-06, on the `develop` branch (commit a1ba710 + issue 23
changes), local development machine (Apple Silicon, macOS). §3 was
re-recorded the same day on commit 4157ff7 plus the archive and export
benchmark scenarios. Numbers are baselines for future comparisons, not SLA
guarantees.

## 1. Recovery drill (RPO / RTO / consistency)

Automated drill: `node --test test-node/hosted_recovery_drill.test.js`
(passing; runs in the standard Node suite).

What the drill does — against the real composed subsystems (admission,
ledger fsync, close pipeline, notice queue, webhook outbox):

1. Accepts a persistent board write through the real admission gate and the
   ledger fsync boundary; observes the sequenced confirmation.
2. Fails an archive close (object-storage fault) into the durable
   `archive_failed` state; queues `event.opened` + `archive.failed` in the
   webhook outbox; queues an upcoming-start notice whose first delivery
   fails (vendor outage).
3. **Crashes**: drops every in-memory object and recomposes every store,
   pipeline, and the ledger from the data directory alone.

Measured result:

| Check | Result |
| --- | --- |
| RPO | **0 confirmed writes lost** — the write confirmed to its sender before the crash is present with identical `seq` and `acceptedAtMs` after the restart. The ledger fsync gates confirmation, so the measured loss window is zero (budget: 5 s). |
| RTO | Recompose from disk + finish the archive + drain the webhook outbox + deliver the notice completes in **< 1 s wall clock** in the automated drill (budget: 15 min). The restore drill additionally proves the backup path end to end; the deployment-target restore copy time is added to the budget at launch. Recovery is automatic; no manual state surgery. |
| Task consistency | `archive_failed` session visible to the restarted process with its failure context, due again on the retry backoff; after the fault is removed the archive seals with `finalSeq` agreeing between manifest, ledger, and session. |
| Outbox consistency | Webhook events still pending after the restart and delivered afterwards. |
| Notice consistency | The retrying notice survives and delivers through the restarted mail adapter. |
| Permission boundaries | Organizer Owner role, live Event Membership, and Event Ban all unchanged after the restart; admission decisions answered from durable state alone (`hosted_recovery_drill.test.js` second test). |
| Restore/PITR | A crash-consistent backup (plain recursive copy) plus re-shipped ledger tails rebuilds every accepted write — including one accepted after the backup — and the restored state drives a complete close with `finalSeq` 2 and a manifest ledger hash matching the re-shipped file (`hosted_recovery_drill.test.js` restore drill). |

This recorded drill predates the production storage selection and proves the
recovery behavior with disposable file adapters. On 2026-09-07,
`test-node/hosted_storage_adapters.test.js` additionally passed against a real
PostgreSQL 16 container: JSONB document restart, ordered ledger rows and
deletion, competing-instance lock rejection, and register/verify/restart/login
all passed. Its S3 test uses a protocol fake to prove immutable writes,
prefixing, and Brand Asset/Image Export byte placement. Neither test is a
production PostgreSQL WAL restore or a real R2 backup/restore; those remain the
external launch evidence in §7.

## 2. Capacity commitments and rejection behavior

Automated proof: `node --test test-node/hosted_capacity_limits.test.js`
(passing), plus `test-node/hosted_reservation_store.test.js` (at-limit
approval, concurrent approvals never oversell, non-overlapping windows
independent) and the reservation route validation for the 1–50 seat band.

| Commitment | Evidence |
| --- | --- |
| Exactly 20 overlapping Board Sessions approved | Store test approves 20 overlapping sessions at the limit; the 21st is refused with `reason: "capacity"` and the would-be peak `maxSessions: 21`. |
| Exactly 1,000 committed Participant Seats approved | The same test commits 20 × 50 = 1,000 seats; a further 1-seat overlap is refused with `maxSeats: 1001`. |
| 1–50 seats per session | Route validation refuses 0 or > 50 with `hosted_reservation_error_seats`; 50 seats per session approved at the store. |
| Capacity signal | `wbo.hosted.capacity.board_sessions_active` / `wbo.hosted.capacity.seats_committed` gauges track live sessions and committed seats on the lifecycle pass (proven in the same test). |

## 3. Benchmark baseline

`npm run bench` (all scenarios, this machine, 2026-09-06):

| Scenario | Result |
| --- | --- |
| e2e: open 6,000-item board, peer-visible erase | avg 392.1 ms (369.4 / 370.5 / 436.3); 13.8 MiB transient |
| load: load 32,768-item board (19.2 MiB) | avg 90.5 ms (83.2 / 89.9 / 98.6); 25.5 MiB transient |
| persist: 128 pencil appends + 128 transforms on the 32,768-item board (19.1 MiB written) | avg 47.8 ms (45.6 / 48.3 / 49.6); 21.4 MiB transient |
| broadcast: 20,000 mixed socket broadcasts | avg 126.6 ms (122.6 / 124.3 / 132.9); 70.7 MiB transient |
| archive: close a 32,768-item Board Session carrying an 8,320-entry ledger (archives 19.1 MiB canvas + 2.0 MiB ledger) | avg 105.6 ms (101.6 / 106.4 / 108.8); 79.2 MiB transient |
| export: render a 512-item archive to a 7211x3096 PNG (0.4 MiB) | avg 2,356.9 ms (2,319.7 / 2,338.7 / 2,412.3); 7.4 MiB transient |

Post-storage-adapter recheck on 2026-09-07 remained within the recorded
baseline's normal variance: e2e 344.5 ms, load 85.7 ms, persist 49.3 ms,
broadcast 122.7 ms, archive 103.3 ms, and export 2,184.3 ms. This run exercises
the local adapter benchmark fixtures; target-host PostgreSQL/R2 latency belongs
to the deployment-shaped validation.

The `archive` and `export` scenarios (`scripts/benchmark-hosted-outcomes.mjs`)
drive the real composed pipelines against real file stores, so both hot
paths now carry a regression guard: `archive` seals the write boundary,
settles the snapshot at the final authoritative sequence, exports and
hashes the accepted-mutation ledger, writes the three immutable archive
objects, and seals the session; `export` reads the sealed archive, verifies
the canvas against its manifest integrity hash, renders the sanitized PNG,
and stores the result. A sample that fails to archive or render fails the
run instead of reporting a number.

These numbers are the recorded baseline for future regression comparison.
Per the project convention, `npm run bench` must be re-run before/after any
change touching live mutation validation, persistence, replay, broadcast
fan-out, archive, or export paths.

### Image Export cost, and what it means operationally

The `export` scenario deliberately renders a small 512-item archive so
`npm run bench` stays quick. Export cost scales with the archived item
count, and at capacity it is large. Measured on this machine with
`WBO_BENCH_EXPORT_ITEMS=<n> npm run bench -- export`
(raise `WBO_BENCH_TIMEOUT_MS` for the large runs):

| Archived board | Rendered output | Export pass |
| --- | --- | --- |
| 512 items | 7211x3096, 0.4 MiB PNG | avg 2.4 s |
| 32,768 items (the `MAX_ITEM_COUNT` cap) | 8192x7844, 18.6 MiB PNG | avg 235.4 s (174.7 / 263.8 / 267.7) |

Two consequences, both covered by open item 3 in §7:

1. The render call in `renderArchivePng` is synchronous, so it holds the
   event loop for its whole duration — measured at 649 ms of event-loop lag
   for a 652 ms render, with a 50 ms heartbeat missing more than half its
   ticks. On the single active application instance that stalls live Board
   Sessions, Socket.IO traffic, HTTP requests, and the lifecycle pass for
   the duration. The cost is not the rasterization: on an 8192x8192 output,
   `new Resvg(svg)` (SVG parse) takes 2,422 ms at 512 items and 17,192 ms at
   4,000 items, while `.render()` takes 65 ms and 170 ms and `.asPng()`
   about 0.5 s. Parse scales at roughly 4.2 ms per item.
2. `runDueExports` settles due jobs one at a time, so several large
   exports queue behind each other and add up.

Issue 24 carries the fix and the options measured so far.

Neither is a durability problem — jobs stay durable, idempotent, and
retryable — but a full-capacity export blocking a shared instance for
minutes is a capacity decision that belongs on the launch checklist.

## 4. Operational signals

Inventory and minimum alert set: `docs/operations/runbook.md` §5. Coverage
spans capacity (the two new capacity gauges), connections (socket gauges),
saves (board operation durations), archive/export/mail/webhook failures
(counters with deterministic failure codes), and HTTP metrics. Alert
hygiene rules (no passwords, sessions, tokens, Access Codes, credentials,
Entry Grants, emails, or canvas content) are documented there; the
account/credential/webhook test suites assert the enumeration-safe and
one-time-reveal behaviors that keep secrets out of responses and logs.

## 5. Deployment constraints and source mapping

- Single active application instance is the deployment constraint;
  documented in `docs/operations/runbook.md` §6. Every durable subsystem
  (state, queues, and ledgers in PostgreSQL; artifacts in R2) lives outside
  the application process. PostgreSQL's advisory lock rejects an accidental
  second active instance.
- The `/source` page serves the immutable, version-pinned Corresponding
  Source mapping and fails closed (503) when the deployment mapping is
  missing or a rolling version label is pinned (tested in
  `test-node/hosted_runtime.test.js` / server route tests). Verify
  `/source` after every deploy.

## 6. Gate status at recording time

| Gate | Command | Status |
| --- | --- | --- |
| Node suite (incl. recovery drill + capacity) | `npm run test-node` | 713 passing, 2 external-PostgreSQL tests skipped, 0 failing; the same adapter file passes 5/5 with PostgreSQL 16 enabled |
| Browser suite | `npx playwright test` | 86 passing |
| Lint | `npm run lint` | clean |
| Typecheck | `npm run typecheck` | clean |
| Benchmarks | `npm run bench` | recorded in §3 |

Re-checked 2026-09-06 on commit 4157ff7: `npm run lint` was failing on
seven files — formatter drift in `server/hosted_event/notifications/`,
`server/hosted_event/organizers/routes.mjs`,
`server/hosted_event/webhooks/store.mjs`, and three hosted test files,
plus one unused constant. A `npm run format` sweep landed the fix. CI runs
only on `master` and pull requests into it, so `develop` never exercises
this gate on its own: run `npm run lint` before merging to `master`.

## 7. Open items (blocking launch, not this evidence)

1. **Legal review:** Terms of Service and Privacy Policy for mainland
   China must be reviewed and approved by legal counsel. No code change
   in this repository substitutes for that review.
2. Full-scale load validation on the production-shaped target: run the
   documented capacity procedure (runbook §4) with 20 concurrent live
   sessions / 1,000 provisioned seats on the target infrastructure and
   record the measured headroom here before opening registrations.
3. **Image Export blocks the shared instance** (issue 24). The performance
   work is deliberately deferred until after the production-shaped deployment
   test. Before opening registrations, choose and record an async render,
   worker/process isolation, cheaper parsing, or an enforceable export limit.
4. **Production storage recovery evidence:** the PostgreSQL and Cloudflare R2
   adapters are selected and implemented, but real R2 credential preflight,
   off-host PostgreSQL base backup/WAL archiving, independent R2 backup, and
   the combined restore drill in runbook §3 still need to run on the target.
