# wbo online whiteboard

WBO is an online collaborative drawing app. This file is the working guide for
agents changing the repository.

## general instructions

- Keep changes narrow, readable, and consistent with nearby code.
- Treat HTTP and socket input as hostile. Malformed requests and socket messages must be rejected deterministically and must not crash the process.
- When behavior, paths, protocol shape, test commands, or ownership documented here changes, update this file.

## project contract

- CI is the source of truth for required checks: [.github/workflows/CI.yml](./.github/workflows/CI.yml).
- Local baseline: `npm install`, then `npm test`.
- `npm test` runs the Node suite, Playwright suite, and Biome lint. It does not run typecheck or benchmarks.
- Use `npm run typecheck` for the unified JS typecheck.
- Use `npm run bench` before and after changes, only for suspected hot-path, persistence, replay, or broadcast-throughput changes.

## Agent skills

### Issue tracker

Issues are tracked as local Markdown files under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the default canonical labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo using root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.

### Operations

Backup/PITR and recovery procedures, capacity commitments, alert hygiene,
and the deployment constraints live in `docs/operations/runbook.md`; the
recorded launch evidence (RPO/RTO drill, capacity rejection proofs,
benchmark baselines, open items) lives in
`docs/operations/launch-evidence.md`. Update both when the durability
contract, capacity limits, or metric inventory change.

## source of truth

Read this section as the normal flow of a board page and a board write. Use
these files as the first place to look, and avoid duplicating owned behavior in
other modules.

### server startup and HTTP routing

Server startup begins in the [server entrypoint](./server/server.mjs), which
defines the HTTP route list and passes it with a runtime from
[create_runtime.mjs](./server/runtime/create_runtime.mjs) into
[boot.mjs](./server/runtime/boot.mjs). Boot owns the Node HTTP server,
history-directory checks, Socket.IO startup, listen, shutdown, and client-error
handling.

Startup configuration is parsed by [configuration.mjs](./server/configuration.mjs)
with shared env helpers from [helpers.mjs](./server/configuration/helpers.mjs).
Runtime logging, metrics, and tracing start from
[observability/index.mjs](./server/observability/index.mjs), with setup details
in [logging.mjs](./server/observability/logging.mjs) and metric utilities in
[metric_helpers.mjs](./server/observability/metric_helpers.mjs).
`WBO_BASE_PATH` public path handling lives with request URL parsing.

The Hosted Event Service shell is composed into the same runtime by
[hosted_event/module.mjs](./server/hosted_event/module.mjs). `WBO_HOSTED_MODE`
switches the root page to the Hosted shell while preserving legacy WBO mode;
`/source` renders the version-pinned Corresponding Source disclosure and
returns an explicit unavailable response when deployment mapping is missing.
Boot passes this runtime to both the HTTP handler and Socket.IO startup so
future Hosted Event behavior has one composition seam.
`WBO_DEPLOYMENT_VERSION`, `WBO_CORRESPONDING_SOURCE_URL` (a URL template with a
`{version}` placeholder), and `WBO_CORRESPONDING_SOURCE_BUILD` are startup-only
source disclosure inputs; they are intentionally not inferred from a mutable
branch or the local working tree.

In hosted mode, accounts live under
[hosted_event/accounts/](./server/hosted_event/accounts/): `store.mjs` owns the
durable account/session/verification-token/password-reset-token state
(verification tokens, reset tokens, and session ids are persisted only as
SHA-256 digests; sessions additionally carry a stable 10-hex public id that
the account page uses to list and revoke sessions), `passwords.mjs` owns scrypt
hashing, `emails.mjs` owns normalization and validation, `routes.mjs` owns the
`/register`, `/verify`, `/login`, `/logout`, `/forgot`, `/reset`, and
`/account` flows, and `captcha.mjs` exposes the configurable CAPTCHA contract
backed by the shared `TURNSTILE_*` configuration. Password resets and password
changes revoke sessions (resets revoke all of the account's sessions, changes
keep the current device's); account disabling and explicit global revocation
invalidate every session. CSRF tokens rotate on login and logout, so tokens
rendered before a session transition are deterministically rejected. Raw
hosted page templates are never served statically; their routes own them, and
legacy mode 404s all account routes. Verification and recovery mail is
composed in the request's language and queued through the notification
service's durable queue (see below), so a mail vendor outage becomes an
observable retry instead of a failed request, and is delivered as JSON files
in `WBO_HOSTED_MAIL_OUTBOX_DIR` (default `<WBO_HOSTED_DATA_DIR>/mail-outbox`)
until a mail vendor is selected. Account
responses, logs, and emails must never carry passwords, password hashes, or
verification tokens; hosted pages are session-aware and therefore `no-store`
with `Referrer-Policy: no-referrer`. Hosted account limits and timeouts are
configured with `WBO_HOSTED_DATA_DIR`, `WBO_HOSTED_SESSION_MAX_AGE_MS`,
`WBO_HOSTED_SESSION_IDLE_TIMEOUT_MS`, `WBO_HOSTED_VERIFICATION_TOKEN_TTL_MS`,
`WBO_HOSTED_PASSWORD_RESET_TTL_MS`, and the `WBO_HOSTED_REGISTER_ATTEMPTS_*` /
`WBO_HOSTED_LOGIN_ATTEMPTS_*` / `WBO_HOSTED_FORGOT_ATTEMPTS_*` pairs. The
`HOSTED_CLOCK` config field is an injectable clock adapter for isolated tests
(never read from the environment); integration tests drive expiry and
revocation through it instead of sleeping.

Event lifecycle mail lives under
[hosted_event/notifications/](./server/hosted_event/notifications/):
[service.mjs](./server/hosted_event/notifications/service.mjs) is the single
fan-out seam — reservation approval/rejection and Change Request decisions
notify organizer members ([notices.mjs](./server/hosted_event/notifications/notices.mjs)
composes every lifecycle notice bilingually, `zh-CN` first then `en`, with no
links), event cancellation and Board Session close also reach every Event
Membership holder, the archive close pipeline reports archive success and
first-failure episodes, and the lifecycle pass sends one upcoming-start
heads-up per scheduled session inside
`WBO_HOSTED_NOTICE_UPCOMING_WINDOW_MS` (organizers only). Every notice is
enqueued with a stable idempotency key (`<logical trigger>:<audience>:<accountId>`)
into the durable store
([store.mjs](./server/hosted_event/notifications/store.mjs), one
`notifications.json` per data directory), so retries, repeated passes, and
restarts never re-send a delivered notice; sent records shrink to
content-free tombstones. Delivery drains through the shared mail adapter on
detached, coalescing passes (kicked per enqueue and on the lifecycle-poker
cadence — never inside a request or the close pipeline); failed attempts back
off from `WBO_HOSTED_MAIL_RETRY_MS` (doubled, capped at one hour) and stay
listed with recipient and last error on the operator console's "Mail
delivery retries" section until the vendor accepts them. Trigger methods and
the drain never throw: a notice problem must not fail the state change,
request, or close pass that reported it.

In hosted mode, Event admission lives under
[hosted_event/events/](./server/hosted_event/events/),
[hosted_event/memberships/](./server/hosted_event/memberships/), and
[hosted_event/admission/](./server/hosted_event/admission/): the event routes
own the Public ID event page, Access Code admission
(`/events/{publicId}/enter`), the one-way anonymity switch
(`/events/{publicId}/anonymity`), and Owner/Admin Access Code mint/rotation
plus Event Lock toggling under
`/organizers/{organizerId}/events/{eventId}/access-code` and `/entry-lock`.
The shared Access Code is high-entropy, normalized before comparison, and
persisted only as a SHA-256 digest in the event record; its raw value is
revealed exactly once to the managing Owner/Admin and never stored or
re-rendered. Rotation blocks future admission with the old code and keeps
every existing membership; the Event Lock refuses all new admission while
memberships remain. [memberships/store.mjs](./server/hosted_event/memberships/store.mjs)
owns the durable Event Membership records (an Event/Account pair plus the
anonymity choice) and Event Bans, which survive refreshes, rotation, and
locks; the anonymity choice is changeable only while the Board Session is
scheduled or open and frozen afterwards. Admission failures render one
uniform response — wrong code, locked, cancelled, and not-yet-open are
indistinguishable — and attempts are rate limited per Account and per IP
through `WBO_HOSTED_ACCESS_CODE_ATTEMPTS_*`. Public URLs carry only Event
Public IDs and event board names, never internal event or Board Session
identifiers. Hosted mode additionally wraps every pre-Event WBO entry surface
(`/boards/*`, `/random`, raw SVG, preview, export, download) in `server.mjs`
with a deterministic 404 and never redirects to a compatibility path.

Organizer-backend integration lives under
[hosted_event/integrations/](./server/hosted_event/integrations/): API
Credential administration (create, rotate, revoke) is Owner-only on the
organizer manage page under `/organizers/{organizerId}/credentials*`, and the
versioned machine API is exactly `GET /api/v1/events/{publicId}` (lifecycle
query) and `POST /api/v1/events/{publicId}/entry-grants`, both authenticated
by an `Authorization: Bearer <credentialId>.<secret>` header. Only a SHA-256
digest of the full bearer value is stored; the raw secret is revealed exactly
once at creation or rotation, rotation invalidates the previous bearer value
but not grants it already issued, and revocation invalidates both immediately.
Every endpoint scopes through the credential's own organizer — another
organizer's event is indistinguishable from a missing one — and grant
creation is rate limited per credential (`WBO_HOSTED_API_ENTRY_GRANT_*`).
Entry Grants are 10-minute, single-use tokens
(`WBO_HOSTED_ENTRY_GRANT_TTL_MS`) that travel to the participant's browser
only in the redirect URL's fragment; [hosted-entry-grant.js](./client-data/hosted-entry-grant.js)
redeems them with one authenticated POST to `/events/{publicId}/entry-grant`
(never in query, path, referrer, or ordinary access logs), clearing the
fragment immediately and stashing a pending grant in sessionStorage until a
signed-out participant completes Hosted Account login. Redemption is one
uniform deterministic failure for expired, reused, revoked-credential,
foreign-event, malformed, banned, locked, and not-yet-open cases — Event
Ban, the Entry Lock, the Board Session lifecycle, and seat capacity all
precede a valid grant — and attempts are rate limited per Account and per IP
(`WBO_HOSTED_ENTRY_GRANT_ATTEMPTS_*`). The optional External Participant
Reference is opaque, control-character-stripped, length-capped, and never
influences admission or identity.

Real-time access to an event's Board Session is owned by
[hosted_event/admission/](./server/hosted_event/admission/): each event
carries an unguessable board name (`event-<hex>`), and `/b/{boardName}` is the
only hosted page that renders the real WBO board (delegating to the legacy
board renderer with the role pinned on the context); `/b/{boardName}.svg`
serves the same board's SVG baseline behind the same admission gate so the
client's reconnect baseline refresh cannot strand a disconnected tab. The same
admission module gates every Socket.IO handshake — legacy board names are
refused, and role ("moderator" for Organizer Owner/Admin including the
Preparation Window, "event_moderator" for a per-event Event Moderator grant
with the same entry window and seat exemption but never the Clear capability,
"editor" for a member holding the account's single writable connection,
"reader" for its extra tabs) is pinned on the socket and consumed by
[board_capabilities.mjs](./server/auth/board_capabilities.mjs) instead of
JWTs. Event Moderator grants are created and revoked by Owner/Admin from the
organizer event console (`/organizers/{organizerId}/events/{eventId}/moderators`);
revocation refreshes the revoked account's live connections through the
moderation socket-effects registry ([moderation/socket_effects.mjs](./server/hosted_event/moderation/socket_effects.mjs))
— still-admissible sockets get their new role immediately, refused ones are
dropped. Participant Seats count distinct Accounts per Event against the Board
Session's approved capacity, survive a 10-minute reconnect grace
(`WBO_HOSTED_SEAT_GRACE_MS`) after an account's last connection drops, and
promote a companion tab to writer on writer loss; persistent writes are
revalidated live (lifecycle, ban, writer slot) per message through
`revalidateSocketWrite`. Hosted mode also blocks the Download tool through
`BLOCKED_TOOLS`, and the board shell embeds its board identity
(`board-identity` JSON, including the event page path on hosted boards) so the
client boots correctly on non-`/boards/` URLs and can route terminal admission
refusals back to the event page instead of looping reconnects.

Hosted mode fail-closes at boot when `AUTH_SECRET_KEY` is empty: participant
identifier derivation needs a stable deployment secret. Every accepted
persistent write is operator-resolved server-side (hosted session → Account →
Event Membership → Board Session → pinned role) and stamped with an opaque,
event-scoped Participant Identifier ([attribution.mjs](./server/hosted_event/attribution.mjs))
— never an email or Account id — which becomes the item's immutable
`createdBy` (top-level canonical field, stored as `data-wbo-created-by` in
SVG, round-tripped centrally through [stored_svg_item_codec.mjs](./server/persistence/stored_svg_item_codec.mjs)).
Copies attribute to the copier while keeping their source relation; updates
never change `createdBy`. Message normalization drops client-supplied
attribution fields, so the browser can never forge an author.

Event-scoped governance lives under
[hosted_event/moderation/](./server/hosted_event/moderation/): a durable,
append-only moderation log (`moderation_log.json`) records every report, warn,
kick, Event Ban, unban, Entry Lock change, and Clear with the actual operator
account, the target's event-scoped Participant Identifier and frozen display
name, and a required reason (Clear collects one in hosted mode through the
Clear tool; the wire schema allows an optional `reason` on CLEAR). The socket
handlers in [hosted_moderation.mjs](./server/socket/hosted_moderation.mjs)
own the real-time surface: hosted `report_user` messages never disconnect
anyone — they are recorded and surfaced to governance roles via
`user_reported` — while `moderation_action` (warn/kick/ban/unban, moderator
only, reason required) applies dispositions, bans revoke the membership and
evict every connection of the target through the socket-effects registry, and
`moderation_state` serves moderators the event's ban list as Participant
Identifiers with frozen names. Governance roles are protected targets:
reports and dispositions against them are refused deterministically. Reports
never carry emails or Account ids into the board; the Owner/Admin console
renders the trail on the organizer event page with operator emails resolved.

Every HTTP request passes through [dispatch.mjs](./server/http/dispatch.mjs),
where URL validation, route matching, route-level access checks, request
observation, and error responses are wired together. Supporting HTTP behavior is
kept beside it: [cache_policy.mjs](./server/http/cache_policy.mjs) chooses cache
headers, [compression.mjs](./server/http/compression.mjs) wraps compressed
responses, [templating.mjs](./server/http/templating.mjs) renders HTML shells,
and [observation.mjs](./server/http/observation.mjs) records and reports
request outcomes.

### serving a board page

Serving `/boards/{board}` is handled by
[board_page.mjs](./server/routes/board_page.mjs), with shared normalization,
ETag, cookie, and replay-baseline helpers in
[board_http_helpers.mjs](./server/routes/board_http_helpers.mjs). That route
normalizes the board name, checks board access, handles redirects and ETags,
reads the stored board document, pins the served baseline sequence for replay,
sets the user-secret cookie, and streams the board HTML shell around the SVG
baseline. Board SVG, preview, export, and download routes are in
[board_assets.mjs](./server/routes/board_assets.mjs); index redirects,
random-board redirects, and static fallbacks are in
[static.mjs](./server/routes/static.mjs).

Board access decisions belong to
[board_capabilities.mjs](./server/auth/board_capabilities.mjs). Board-scoped
JWTs use [board_jwt.mjs](./server/auth/board_jwt.mjs) and the generic helpers in
[jwt.mjs](./server/auth/jwt.mjs). `WBO_BOARD_MODERATORS` grants the existing
moderator role to board-specific user-secret cookies through
[board_moderators.mjs](./server/auth/board_moderators.mjs). The user-secret cookie is handled by
[user_secret_cookie.mjs](./server/auth/user_secret_cookie.mjs), and board-name
normalization shared with the browser is in
[board_name.js](./client-data/js/board_name.js).

The board HTML shell in [board.html](./client-data/board.html) carries the
chrome, embedded configuration/translations/board state, and inline
authoritative `<svg id="canvas">` baseline with `<g id="drawingArea">`.

### browser boot and runtime

The browser starts in [board_main.js](./client-data/js/board_main.js). It uses
[board_bootstrap.js](./client-data/js/board_bootstrap.js) and
[app_tools_core.js](./client-data/js/app_tools_core.js) to create a minimal
runtime shell, then [board_dom_bootstrap.js](./client-data/js/board_dom_bootstrap.js)
attaches the server-rendered board DOM and reads the inline baseline sequence.
After the viewport is restored, [board.js](./client-data/js/board.js) hydrates
the full runtime.
The board boot process is carefully crafted to prioritize which assets are loaded first in order to arrive at an interactive zoom+pan board ASAP. Be careful never to add unnecessary cruft on the critical path. Adding a new frontend file that has to be carefully considered for boot time impact.

[app_tools.js](./client-data/js/app_tools.js) assembles that full runtime from
modules in [board_full_runtime_modules.js](./client-data/js/board_full_runtime_modules.js)
and shared classes in [board_runtime_core.js](./client-data/js/board_runtime_core.js).
Once hydrated, viewport, zoom, pan, and canvas growth are handled by
[board_viewport.js](./client-data/js/board_viewport.js) and
[board_extent.js](./client-data/js/board_extent.js). Page chrome, status, board
access, and presence are handled by
[board_shell_module.js](./client-data/js/board_shell_module.js),
[board_status_module.js](./client-data/js/board_status_module.js),
[board_access_module.js](./client-data/js/board_access_module.js), and
[board_presence_module.js](./client-data/js/board_presence_module.js). The
frontend-only friend list is keyed by the visible, secret-derived presence
`userId`; resilient local persistence and cross-tab synchronization belong to
[board_friend_store.js](./client-data/js/board_friend_store.js), while presence
owns friend decoration and display order. Socket
connection, replay, received-message dispatch, optimistic state, and outgoing
writes are handled by
[board_connection_module.js](./client-data/js/board_connection_module.js),
[board_replay_module.js](./client-data/js/board_replay_module.js),
[board_message_module.js](./client-data/js/board_message_module.js),
[board_optimistic_module.js](./client-data/js/board_optimistic_module.js), and
[board_write_module.js](./client-data/js/board_write_module.js).

### tools and client messages

[manifest.js](./client-data/tools/manifest.js) defines tool identity, stable
numeric tool codes, capability requirements, live-message fields, and stored SVG
contracts. Tool order and defaults are split into
[tool-order.js](./client-data/tools/tool-order.js) and
[tool-defaults.js](./client-data/tools/tool-defaults.js). The runtime loads and
mounts tools through
[board_tool_registry_module.js](./client-data/js/board_tool_registry_module.js),
which also drains pending messages for lazy-loaded tools and owns active-tool
pointer dispatch. Shared tool exports live in
[index.js](./client-data/tools/index.js), shape behavior is shared through
[shape_contract.js](./client-data/tools/shape_contract.js) and
[shape_tool.js](./client-data/tools/shape_tool.js), and each concrete tool keeps
its interaction, DOM, rendering, cleanup, and stored-item behavior in
`client-data/tools/<tool-id>/index.js`.

When a user interaction modifies the board, the active tool creates a live board
message with primitives from [message_common.js](./client-data/js/message_common.js),
limits from [message_limits.js](./client-data/js/message_limits.js), tool and
mutation metadata from
[message_tool_metadata.js](./client-data/js/message_tool_metadata.js), and
mutation codes from [mutation_type.js](./client-data/js/mutation_type.js). The
write module assigns a `clientMutationId` for persistent writes, captures
optimistic rollback, draws locally, applies message hooks such as extent growth,
and sends the message through
[board_transport.js](./client-data/js/board_transport.js) as a Socket.IO
`broadcast` event on the active socket.

### socket connection, replay, and writes

The Socket.IO server is started and wired in
[socket/index.mjs](./server/socket/index.mjs). On connect,
[replay.mjs](./server/socket/replay.mjs) binds and normalizes the board name,
checks board access, loads or reuses the board, compares the client's
`baselineSeq` with the board mutation log, and prepares a replay batch. The
connection then emits `boardstate` followed by a `broadcast` replay batch before
marking the socket as synced for persistent live broadcasts.

Client `broadcast` messages enter
[broadcasts.mjs](./server/socket/broadcasts.mjs) and are handled in this order:

1. Resolve the client IP and board user, then enforce Turnstile when required.
2. Apply pre-normalization rate limits with
   [rate_limits.mjs](./server/socket/rate_limits.mjs).
3. Use [policy.mjs](./server/socket/policy.mjs) and
   [message_validation.mjs](./server/socket/message_validation.mjs) to normalize
   and validate the message shape, including blocked-tool checks.
4. Apply post-normalization rate limits with the same rate-limit module.
5. Check board permissions for the normalized mutation.
6. For cursor messages, update presence and rebroadcast the ephemeral message
   without persistence.
7. For persistent mutations, serialize acceptance through the per-board
   queue in [session.mjs](./server/board/session.mjs), apply the mutation to
   [data.mjs](./server/board/data.mjs) through
   [message_processing.mjs](./server/board/message_processing.mjs), record it in
   [mutation_log.mjs](./server/board/mutation_log.mjs), and emit sequenced
   `broadcast` frames to synced clients and the sender. In hosted mode the
   session also resolves the server-authoritative operator, stamps the
   operator's `createdBy` onto item-creating mutations, deduplicates accepted
   `clientMutationId`s (retries re-confirm the original entry), and durably
   appends the entry to the board's mutation ledger before the sender is
   confirmed; a failed ledger append rejects the write (`ledger_unavailable`)
   and drops the mutated board instance so it reloads from snapshot plus
   ledger. Legacy mode skips all of this and keeps in-memory-only logging.

[presence.mjs](./server/socket/presence.mjs) tracks connected board users,
[reports.mjs](./server/socket/reports.mjs) handles user reports,
[ban store](./server/socket/bans.mjs) tracks moderator report-to-ban state, and
[turnstile.mjs](./server/socket/turnstile.mjs) validates Turnstile tokens.
Client and server share rate-limit math through
[rate_limit_common.js](./client-data/js/rate_limit_common.js).

On the browser side, socket `broadcast` frames are queued by the connection
module and consumed by the replay module. Replay enforces sequence order,
applies replay batches, refreshes the authoritative SVG baseline when replay is
not possible, and then passes messages to the message module. The message module
updates hooks and calls the owning tool's `draw` method; unknown tool messages
are held until that tool is booted.

### board state and persistence

In memory, [data.mjs](./server/board/data.mjs) represents a board as a
canonical item index. [canonical_items.mjs](./server/board/canonical_items.mjs)
defines item shape, [canonical_index.mjs](./server/board/canonical_index.mjs)
owns lookup and paint order, and [svg_extent.mjs](./server/board/svg_extent.mjs)
tracks the SVG extent. Mutation application stays in
[message_processing.mjs](./server/board/message_processing.mjs), while
[data_persistence.mjs](./server/board/data_persistence.mjs) owns autosave
scheduling, load, save, unload, and stale-save handling.

On disk, stored SVG is authoritative, and in hosted mode the durable
mutation ledger is the authoritative post-snapshot history: board loads
hydrate ledger entries newer than the snapshot sequence
(`board.ledger_hydrated`), the ledger stays append-only for the Board
Session's lifetime (retention is later work building on it), and ledger
corruption or a replay gap fails the load instead of silently diverging.
An unreadable stored SVG is quarantined with `svg.snapshot_unreadable_quarantined`
and recovery continues from the backup or the ledger rebuild; a torn
final ledger line (a crash mid-append) is dropped on read and the append
boundary is repaired before the next append so the torn bytes are never
buried mid-file.
[svg_board_store.mjs](./server/persistence/svg_board_store.mjs)
reads served baselines, loads canonical board state, writes fresh SVGs, and
rewrites existing SVGs. It relies on
[streaming_stored_svg_scan.mjs](./server/persistence/streaming_stored_svg_scan.mjs)
for structural scans,
[stored_svg_item_codec.mjs](./server/persistence/stored_svg_item_codec.mjs) for
item decode/encode, [svg_envelope.mjs](./server/persistence/svg_envelope.mjs)
for root metadata and drawing-area boundaries, and
[legacy_json_svg_migration.mjs](./server/persistence/legacy_json_svg_migration.mjs)
for legacy JSON conversion. Persistence paths and timing are configured through
`WBO_HISTORY_DIR`, `WBO_SAVE_INTERVAL`, `WBO_MAX_SAVE_DELAY`, and
`WBO_SEQ_REPLAY_RETENTION_MS`. Board moderators are configured with
`WBO_BOARD_MODERATORS` as space-separated `board:secret[,secret]` groups.

The durable mutation ledger lives under
[hosted_event/ledger/](./server/hosted_event/ledger/) with one JSONL file per
board in `<WBO_HOSTED_DATA_DIR>/mutation-ledger/<board>.jsonl`; each entry
carries `seq`, `acceptedAtMs`, `eventId`, `boardSessionId`, the internal
`accountId`, and the full attributed mutation. The board layer reaches it
through the factory seam in
[ledger_registry.mjs](./server/board/ledger_registry.mjs), which the hosted
module registers at composition — a future PostgreSQL adapter slots in
without touching the acceptance flow.

Board Session closing is owned by the close pipeline in
[hosted_event/archive/close.mjs](./server/hosted_event/archive/close.mjs),
run after every lifecycle advancement (request-driven and through the
lifecycle poker). Once a session's drain window elapses the pipeline drains
already-admitted writes through the board session queue, levels the stored SVG
snapshot with the mutation ledger on one final authoritative sequence, and
only on agreement produces the immutable Private Board Archive — canvas with
item attribution, the accepted-mutation ledger as audit boundary, and a
manifest with integrity hashes — before sealing the session `closed`
(`markBoardSessionClosed`). Validation or storage failure moves the session
to a durable `archive_failed` state (`recordBoardSessionArchiveFailed`) that
keeps the classified failure code, the internal detail, and the attempt
history on the session record plus a Change Audit entry and an archive
metric; an `archive_failed` session admits no writes and never displays an
archived result. Recovery is idempotent end to end: automatic retries
re-attempt `archive_failed` sessions after
`WBO_HOSTED_BOARD_SESSION_ARCHIVE_RETRY_MS` (the deterministic manifest and
the immutable archive store make re-puts no-ops, and the guarded seal never
double-advances), while Platform Operators can retry immediately from the
operator console (`retryBoardSessionArchive`, POST
`/operator/board-sessions/{boardSessionId}/archive-retry`), which lists
failed work with its failure context. A close is never faked: the read-only
completion notification is sent only when the session actually sealed.
Archive objects live under `<WBO_HOSTED_DATA_DIR>/board-archives/` via
[archive/store.mjs](./server/hosted_event/archive/store.mjs), whose keys are
internal and never public access credentials. A sealed session cannot be
re-edited or reopened; its connected sockets end on a read-only completion
state (`BOARDSTATE` carrying `eventClosed: true`, demoted to reader) and
reconnects are refused by admission. Empty Board Sessions archive the same
way. Archive success and first-failure episodes enqueue organizer notices
through the notification service, which also tells the event's members the
event has closed.

Published Canvas publication lives under
[hosted_event/publication/](./server/hosted_event/publication/): Owner/Admin
publish flows (`POST
/organizers/{organizerId}/events/{eventId}/publication` and
`.../publication/revoke` in
[events/routes.mjs](./server/hosted_event/events/routes.mjs)) always derive a
sanitized, read-only presentation from the sealed Private Board Archive —
never the authoritative canvas — via
[publication/canvas.mjs](./server/hosted_event/publication/canvas.mjs), which
strips every `data-wbo-created-by` attribute that the Publication Policy does
not allow to show (an item keeps its Participant Identifier only when the
organizer enabled public attribution and its creator's frozen Presentation
Choice is "identified"; anonymous, banned, and unknown creators fail safe to
no identifier). The derived artifact is stored immutably under
`published-canvases/` in the archive store by
[publication/store.mjs](./server/hosted_event/publication/store.mjs), keyed by
a per-board-session monotonic generation; unchanged policy content reuses the
current generation's object. Publication Audience (`organizer`, `members`,
`link`) is re-checked on every read of `GET /events/{publicId}/canvas` and
`GET /events/{publicId}/canvas/{token}` — revocation invalidates all
audiences and the (digest-stored, revealed-once, rotated on every
link-audience publish) share token immediately, and every refusal renders one
uniform 404. The published page is `no-store` with `X-Robots-Tag` and meta
`robots` noindex.

Asynchronous Board Image Export lives under
[hosted_event/export/](./server/hosted_event/export/): Owner/Admin request a
PNG projection of a successfully archived Board Session from the organizer
event console (POST
`/organizers/{organizerId}/events/{eventId}/exports`); the pipeline reads the
sealed archive only (manifest integrity hash verified, never a live Board
Session, no raw SVG exposure), re-wraps the drawing area in a sanitized SVG
without `data-wbo-*` attribution, and rasterizes it with `@resvg/resvg-js`
into an ordinary PNG — white background, content bounds plus margin, longest
edge capped at 8192 px — whose chunks are checked against a strict allowlist
so attribution, Participant Identifiers, audit data, or object keys can never
appear in the output. Oversized or unrenderable content fails deterministically
(`archive_unavailable`, `archive_invalid`, `render_failed`,
`output_limit_exceeded`, `output_metadata_rejected`, `storage_write_failed`).
Job records and PNG bytes live under `<WBO_HOSTED_DATA_DIR>/board-exports/`
via [export/store.mjs](./server/hosted_event/export/store.mjs); jobs survive
restarts (`processing` jobs are re-queued), retry failed renders up to three
attempts paced by `WBO_HOSTED_BOARD_EXPORT_RETRY_MS`, and then stay settled —
repeated passes never re-run succeeded work. Export passes are kicked on the
lifecycle-poker cadence but detached: rendering can take seconds, so no
request path ever blocks on it. The download route
(`GET /organizers/{organizerId}/events/{eventId}/exports/{exportId}/download`)
requires an authorized Owner/Admin session plus an HMAC-derived token; links
are valid for `WBO_HOSTED_BOARD_EXPORT_LINK_TTL_MS` (24 h) and die immediately
on revoke or delete.

Outcome retention, early deletion, and expiry purge live under
[hosted_event/outcomes.mjs](./server/hosted_event/outcomes.mjs): a sealed
Board Session's Private Board Archive, the Item Attribution inside its canvas,
its Change Audit (the durable mutation ledger file), the event's Published
Canvas, and its Board Image Export objects are retained for
`WBO_HOSTED_OUTCOME_RETENTION_MS` (90 days from the archive seal, `0`
disables expiry purges) and then purged together by one idempotent,
event-isolated pass on the lifecycle-poker cadence. An Owner/Admin can request
early deletion from the event console (POST
`/organizers/{organizerId}/events/{eventId}/outcomes/delete`); the request
enters the `WBO_HOSTED_OUTCOME_DELETE_WINDOW_MS` recoverable window (7 days)
and immediately invalidates the Published Canvas and every export download
link by consulting the durable deletion record on every read — nothing is
deleted yet — while POST `.../outcomes/restore` inside the window removes the
request and every surface is consistent again by construction. The purge
deletes outcome objects first and stamps durable markers last
(`outcomesPurgedAtMs` per session, `purgedAtMs` on the event's deletion
record), so an interrupted purge replays as a no-op; failures record a
durable context on the event, stay visible on the organizer event console and
the operator console, retry after `WBO_HOSTED_OUTCOME_PURGE_RETRY_MS`, and can
be retried immediately by a Platform Operator (POST
`/operator/events/{eventId}/outcome-purge-retry`). Moderation-log and
organizer Change Audit records are governance/accountability data and are not
part of the outcome purge. The Owner/Admin audit view
(`GET /organizers/{organizerId}/events/{eventId}/audit`) renders the
retention deadline from the service clock, the Board Item Attribution counted
from the archived canvas, the recent accepted board mutations from the ledger
with internal Account ids projected to Participant Identifiers, and the
event-scoped administrative activity; Event Moderators and Participants have
no console access at all.

Signed Webhooks live under
[hosted_event/webhooks/](./server/hosted_event/webhooks/): an Organizer Owner
creates, rotates, revokes, and resumes Webhook Subscriptions from the
organizer console (`POST /organizers/{organizerId}/webhooks`,
`.../webhooks/{subscriptionId}/rotate|revoke|resume`) — non-Owners never see
or replace the HMAC secret, which is revealed exactly once and stored raw
only because the platform itself signs with it. Endpoints must be HTTPS
(HTTP only where the composition allows development), credential-free, and
hosted; invalid URLs are refused at creation. The durable outbox derives
`event.opened`, `event.closed`, `archive.ready`, and `archive.failed`
idempotently from the durable Board Session state (dedupe keys per session
and failure episode, so restarts and repeated passes enqueue nothing new),
captures the subscriptions active at derivation time, and delivers each
payload — Event Public ID, event name, timestamps, and a deterministic
failure code for `archive.failed`, nothing else — at least once per
subscription with `X-SukimaCanvas-Signature: t=<unix-seconds>,v1=<hmac-sha256
over "<t>.<body>">` plus stable event id, event type, and delivery id
headers. Non-2xx responses, network errors, and timeouts retry with capped
exponential backoff (`WBO_HOSTED_WEBHOOK_RETRY_MS`) for
`WBO_HOSTED_WEBHOOK_GIVE_UP_MS` (24 h) per record, measured from its first
failed attempt; after that the subscription is suspended — its queued
records freeze, never drop — the Organizer Owners are notified through the
durable notice queue, and an Owner resumes from the console to deliver them.
Resuming starts a fresh give-up window for every frozen record, so a fixed
endpoint can always recover. Fully delivered outbox entries shrink to
idempotency tombstones after 30 days; their dedupe keys survive, so a
delivered event can never re-enqueue. Delivery runs detached on the lifecycle-poker
cadence, discards response bodies unread, treats every failure as data, and
never logs secrets, signatures, or endpoint URLs. Revocation drops a
subscription's pending records with the Owner's explicit opt-out.

Historical Archive import lives under
[hosted_event/history/](./server/hosted_event/history/): a Platform Operator
imports one explicitly selected legacy WBO SVG for one explicitly selected
Organizer from the operator console (`GET/POST
/operator/historical-imports`). The strict parser in
[legacy_svg_import.mjs](./server/hosted_event/history/legacy_svg_import.mjs)
accepts only the stored-SVG item vocabulary under `drawingArea` and
re-serializes every item canonically through the tools' stored-item
contracts, so unsupported structure is deterministically rejected, hostile
attributes and markup cannot survive, and every `data-wbo-created-by` claim
is stripped — a Historical Archive is private, read-only, authorship
`unknown`, and has no Change Audit, ledger object, or Participant/operator
fabrication. Imports are idempotent by construction: the import id derives
from the target Organizer plus the source digest, a crashed import is
completed (never duplicated) by re-importing, and a completed import refuses
the same source deterministically; every attempt, outcome, and failure reason
is recorded in `historical_archives.json` and audited only on the operator
console. There is no history-directory scan, no batch migration, no
Event/Reservation creation, and no path that reopens a Historical Archive as
a Board Session; retention never enumerates the `historical-archives/` key
namespace.

Account deregistration is owned by
[hosted_event/accounts/store.mjs](./server/hosted_event/accounts/store.mjs):
`deleteAccount` irreversibly pseudonymizes the account (the email is replaced
by a random `deleted-<hex>@sukimacanvas.invalid` placeholder that no one can
map back, the password hash is dropped, status becomes the terminal
`deleted`), revokes every session, and consumes outstanding verification and
reset tokens. The internal Account id is kept on purpose so the mutation
ledger, moderation log, and organizer Change Audit stay accountable; public
attribution was already an opaque event-scoped Participant Identifier and is
unchanged. The flow runs through POST `/account/delete` (password re-proof +
CSRF) and lands on `/login?deleted=1`.

### tests, benchmarks, and profiling

Use [test-node](./test-node) for Node tests and
[playwright/tests](./playwright/tests) with
[playwright.config.ts](./playwright.config.ts) for browser integration tests.
Server benchmarks are in [benchmark-server.mjs](./scripts/benchmark-server.mjs),
profiling starts from
[profile-benchmark-server.mjs](./scripts/profile-benchmark-server.mjs), and the
peer-visible erase benchmark is
[benchmark-peer-visible-erase.mjs](./scripts/benchmark-peer-visible-erase.mjs).

## wire socket protocol

WBO uses Socket.IO. Clients connect with query fields such as `board`,
`baselineSeq`, `token`, `tool`, `color`, and `size`. The server immediately emits
`boardstate`, then emits a `broadcast` replay batch from the requested
`baselineSeq`.

Live board writes are JSON messages sent on the `broadcast` event. They use
numeric `tool` codes from [client-data/tools/manifest.js](./client-data/tools/manifest.js)
and numeric mutation `type` codes from [client-data/js/mutation_type.js](./client-data/js/mutation_type.js):
`1` create, `2` update, `3` delete, `4` append, `5` batch, `6` clear, `7` copy.
The server validates client messages, rejects malformed writes with
`mutation_rejected`, and rebroadcasts accepted persistent writes as sequenced
`broadcast` frames.

User reports are sent by clients on the `report_user` event with a payload of
`{ "socketId": "<reported socket id>" }`. Moderator warning/ban actions add
`banDurationMs` and may add `moderationRule`. A `banDurationMs` of `0` warns
without banning, a positive number bans for that duration, and an omitted or
invalid value preserves the legacy default 15-minute ban. Ban durations are
clamped to at most one week. A user with an active edit ban receives
`boardstate.canReport: false`; the client hides report controls, and the server
also ignores any `report_user` event that user emits. Ban-aware board state also
includes `accessRefreshAfterMs`, the server-derived delay until the last active
secret/IP ban expires. The browser schedules one reconnect at that boundary so
`canEdit` and `canReport` refresh without polling. The server also ignores a
non-moderator report targeting the reporter's own socket or another socket with
the same non-empty, secret-derived user identity. On hosted event boards the
`report_user` flow is event governance: self-reports, malformed socket ids, and
targets on other events are rejected deterministically, reports are recorded in
the moderation log and surfaced to governance roles via `user_reported`, and no
one is disconnected by a report alone.

Hosted Event moderators apply dispositions on the `moderation_action` event:
`{ "action": "warn" | "kick" | "ban" | "unban", "reason": "<required>", "socketId"?: "<online target>", "participantId"?: "<banned participant identifier>" }`.
Warn delivers `moderation_notice { "reason" }` to the target while it stays
connected; kick and ban evict every connection of the target account on the
event; ban revokes the membership and creates the durable Event Ban that
overrides Access Codes, memberships, and future Entry Grants; unban matches by
Participant Identifier against the event's current bans. A missing reason,
unknown action, protected governance target, or unresolvable identifier is
rejected deterministically (the optional ack reports `{ ok: false, reason }`).
Moderators fetch the ban list for the unban flow via a `moderation_state` ack
carrying `{ "banned": [{ "participantId", "name" }] }`.

Board state and presence expose `canBan` separately from `canClear`. Moderation
UI and moderator markers use `canBan`; Clear-tool access, large-batch admission,
and destructive rate-limit bypasses use `canClear`. Hosted Event Moderators hold
`canBan` but never `canClear`.

Before the reported socket is closed, the server emits
`moderation_disconnect { "banDurationMs": <duration>, "source": "moderator" | "peer_report" | "event_ban", "moderationRule"?: "<rule>" }`.
Moderator actions use `source: "moderator"`; `0` means a warning and a positive
duration means a ban. Non-moderator reports disconnect the reporter and
reported user after logging the report, emit a zero-duration notice with
`source: "peer_report"` only to the reported target, and do not ban. Hosted
event bans use `source: "event_ban"`. The client treats a missing, unknown, or
incoherent source as moderator-originated for backward-compatible, fail-safe
wording. For accepted non-moderator reports, the
server emits `user_reported` only to connected moderators on that board. The
`user_reported` payload is
`{ "reporterName": "<display name>", "reportedName": "<display name>" }`.
Moderator warning/ban actions do not emit `user_reported`; warning actions only
disconnect the reported user, while ban actions also ban the reported secret and
IP. Active moderators are protected targets based on authoritative live
capabilities, including when the reporter is a temporary moderator.

Permanent moderators use `set_temporary_moderator { socketId, durationMs }` to
grant up to one week or revoke with `0`. Grants are board-scoped, process-local,
secret-keyed across tabs, lost on restart, and cannot be delegated by temporary
moderators. Changes refresh board state and presence for every matching socket.

Client write messages normally have top-level `tool` and `type` fields.
Tool-owned batches have top-level `tool` plus `_children`; each child carries its
own mutation `type`. Normal socket batches are capped by `WBO_MAX_CHILDREN`, but
users with the existing `canClear` capability bypass that batch-size cap.
Server `broadcast` payloads are either bare ephemeral messages, sequenced
persistent mutations, or replay batches with `type: 5`, `fromSeq`, `seq`, and
`_children`.

Client `broadcast` payload examples. Comments are explanatory; they are not sent
on the wire.

```jsonc
{
  // Rectangle tool.
  "tool": 3,
  // MutationType.CREATE.
  "type": 1,
  "id": "rmou34r3xa", // Rectangle IDs are generated as "r" + base36 timestamp + base36 suffix.
  "color": "#1f2937",
  "size": 10,
  "opacity": 0.85,
  "x": 120,
  "y": 80,
  "x2": 240,
  "y2": 160,
  // Generated by the write module as "cm-" + base36 timestamp + base36 suffix.
  "clientMutationId": "cm-mou34r3xc"
}
```

```jsonc
{
  // Hand tool batch. The parent carries the tool; children carry mutation types.
  "tool": 7,
  "clientMutationId": "cm-mou34r3xd",
  "_children": [
    {
      // MutationType.UPDATE with an affine SVG transform.
      "type": 2,
      "id": "rmou34r3xa",
      "transform": { "a": 1, "b": 0, "c": 0, "d": 1, "e": 10, "f": 20 }
    },
    {
      // MutationType.COPY. Hand copies keep the source ID's first-character prefix.
      "type": 7,
      "id": "rmou34r3xa",
      "newid": "rmou34r3xb"
    }
  ]
}
```

Server `broadcast` payload examples:

```jsonc
{
  // Server-assigned persistent sequence.
  "seq": 42,
  "acceptedAtMs": 1710000000000,
  "mutation": {
    "tool": 3,
    "type": 1,
    "id": "rmou34r3xa",
    "color": "#1f2937",
    "size": 10,
    "opacity": 0.85,
    "x": 120,
    "y": 80,
    "x2": 240,
    "y2": 160,
    "clientMutationId": "cm-mou34r3xc",
    // The sender socket id is echoed only on the primary live broadcast.
    "socket": "server-socket-id"
  }
}
```

```jsonc
{
  // Authoritative replay batch sent after connect.
  "type": 5,
  "fromSeq": 40,
  "seq": 42,
  "_children": [
    {
      "tool": 3,
      "type": 1,
      "id": "rmou34r3xa",
      "color": "#1f2937",
      "size": 10,
      "opacity": 0.85,
      "x": 120,
      "y": 80,
      "x2": 240,
      "y2": 160,
      "clientMutationId": "cm-mou34r3xc"
    }
  ]
}
```

Important files:

- Events and message codes: [client-data/js/socket_events.js](./client-data/js/socket_events.js),
  [client-data/tools/manifest.js](./client-data/tools/manifest.js),
  [client-data/js/mutation_type.js](./client-data/js/mutation_type.js), and
  [client-data/js/message_tool_metadata.js](./client-data/js/message_tool_metadata.js).
- Client connection/send/receive: [client-data/js/board_transport.js](./client-data/js/board_transport.js),
  [client-data/js/board_write_module.js](./client-data/js/board_write_module.js), and
  [client-data/js/board_connection_module.js](./client-data/js/board_connection_module.js).
- Server admission and fan-out: [server/socket/message_validation.mjs](./server/socket/message_validation.mjs),
  [server/socket/policy.mjs](./server/socket/policy.mjs),
  [server/socket/replay.mjs](./server/socket/replay.mjs), and
  [server/socket/broadcasts.mjs](./server/socket/broadcasts.mjs).

## persisted board file format

Persisted boards are SVG documents. The root SVG carries `data-wbo-format`,
`data-wbo-seq`, `data-wbo-readonly`, `width`, and `height`; drawable items live
under `<g id="drawingArea">`. Stored items use SVG tag names; those tag names map
back to string tool ids when the server decodes the file.

Minimal stored SVG example:

```svg
<svg id="canvas" xmlns="http://www.w3.org/2000/svg" version="1.1" width="1000" height="800" data-wbo-format="whitebophir-svg-v2" data-wbo-seq="42" data-wbo-readonly="false">
<defs id="defs"></defs>
<g id="drawingArea">
<!-- Rectangle item. The stored tag maps back to the "rectangle" tool. -->
<rect id="rmou34r3xa" x="120" y="80" width="120" height="80" stroke="#1f2937" stroke-width="10" fill="none" opacity="0.85"></rect>
<!-- Pencil item. Pencil IDs are generated with the "l" prefix in live tool code. -->
<path id="lmou34r3xe" d="M 120 80 l 20 10" stroke="#1f2937" stroke-width="10" fill="none" stroke-linecap="round" stroke-linejoin="round"></path>
<!-- Text item. Text IDs are generated with the "t" prefix. -->
<text id="tmou34r3xf" x="120" y="220" font-size="24" fill="#1f2937">Hello WBO</text>
</g>
<g id="cursors"></g>
</svg>
```

Important files:

- Envelope and root metadata: [server/persistence/svg_envelope.mjs](./server/persistence/svg_envelope.mjs)
  and [server/persistence/svg_board_store.mjs](./server/persistence/svg_board_store.mjs).
- Scan, load, and rewrite: [server/persistence/streaming_stored_svg_scan.mjs](./server/persistence/streaming_stored_svg_scan.mjs)
  and [server/persistence/stored_svg_item_codec.mjs](./server/persistence/stored_svg_item_codec.mjs).
- Tool stored-item contracts: [client-data/tools/index.js](./client-data/tools/index.js),
  [client-data/tools/shape_contract.js](./client-data/tools/shape_contract.js), and
  `client-data/tools/<tool-id>/index.js`.

## core invariants

- Server live-message admission validates and rejects. Client tools own
  UX-side clamping and normalization before optimistic draw/send.
- After a tool calls `Tools.drawAndSend`, `Tools.send`, or write-buffer APIs, the
  runtime owns that message object. Callers must not mutate it.
- Persistent socket writes flow through policy, rate limits, the per-board
  session, board mutation application, mutation-log recording, and sequenced
  broadcasts. Cursor messages are ephemeral and are not persisted or replayed.
- Hosted item attribution is server-authoritative end to end: the operator is
  resolved from the hosted session and admission verdict, `createdBy` is
  stamped at acceptance from an opaque participant identifier, and updates,
  copies, and replayed ledger entries can never rewrite an item's creator.
- In hosted mode an accepted persistent write is durable before it is
  confirmed: the ledger append (fsync) gates the sequenced broadcast, a
  ledger failure rejects the write and drops the mutated board instance, and
  loads replay ledger entries past the stored SVG snapshot. Ledger history is
  never silently skipped; corruption fails the load loudly.
- Connection replay starts from the SVG baseline sequence attached to the page.
  Reconnects refresh the authoritative SVG baseline before opening a new socket
  when replay is not possible.
- Canonical board items store scalar fields in `attrs`, `transform` once at
  the item top level, server-stamped `createdBy` as the only other top-level
  scalar, and payload-specific state under `payload`.
- Stored SVG is authoritative. `.svg.bak` is a transient save staging file, and
  unreadable primary SVGs are quarantined before fallback. Legacy `.json`
  boards are migration inputs, not the steady-state format.
- Stored SVG structural scan, summary decode, and full materialization are
  separate. Bad recognized items may be skipped; broken SVG structure is an
  error. Do not turn structural failures into silent repairs.
- Board pages stream stored SVG baselines through the HTML shell. The board chrome
  and boot payloads must remain before the streamed board markup.
- All user-visible strings MUST be localized via `Tools.i18n`. All [translation keys](server/http/translations.json) MUST have a carefully designed, natural sounding, context-aware version in `en`, `zh-CN`, and `ja`; Hosted Event pages additionally render only `en` and `zh-CN` (see `HOSTED_LANGUAGES`). Legacy board keys must keep their existing coverage in the other supported languages; do not drop existing translations.
- The shared moderation rule list lives in [client-data/js/moderation_rules.js](./client-data/js/moderation_rules.js). It defines rule identity, icon files, translation key references, and the moderation-appeal URL. Rule SVG icons live in [client-data/rules/](./client-data/rules/). The `/rules` page, the moderation-action dialog, and the banned disconnect notice all read metadata from this single source.

## hot paths

Hot paths include live socket message validation, per-coordinate message
helpers, board load, canonical item materialization, mutation application,
stored-SVG summary scan, save/rewrite, and broadcast fan-out.

When touching hot paths:

- Do not read env or rebuild config inside per-item, per-child, or
  per-coordinate work. Capture or pass values once at the boundary.
- Avoid avoidable allocations, cloning, regex creation, and spans inside
  per-coordinate loops.
- Use summary decode for board load and canonical indexing. Do not hydrate Pencil
  point arrays on board open, save, rewrite, or copy unless the active tool
  interaction truly needs them.
- Do not read source SVG from live socket-message paths. SVG source reads belong
  to board load, served baseline reads, and persistence rewrite.
- Use `withExpensiveActiveSpan` or a span around a batch for high-volume work.
  Do not start `withActiveSpan` per item.
- Run `npm run bench` before and after suspected hot-path changes. Use
  `npm run bench -- <e2e|load|persist|broadcast>` or the matching shortcut when
  one scenario is enough.

## frontend rules

- Preserve the existing whiteboard shell. Small UX fixes should not restyle
  unrelated controls or introduce a new visual system.
- The left tool rail is the primary anchor. HUD, presence, status, and popovers
  must not cover it, intercept clicks meant for it, or force it to move.
- Viewport, zoom, pan, URL hash, scroll bounds, and board extent logic belong in
  [client-data/js/board_viewport.js](./client-data/js/board_viewport.js) and
  [client-data/js/board_extent.js](./client-data/js/board_extent.js).
- Generic message hooks must derive extent from persistent/content payloads only.
  Ephemeral messages such as cursor updates must not grow the board extent.
- SVG layout measurement such as `getBBox()` is allowed only in narrow tool
  interaction paths over a small selected/updated element set. Do not traverse or
  measure the whole board SVG from generic gesture or message handling.
- Treat SVG-affecting CSS as board-load sensitive; style recalculation can make
  existing boot-time SVG reads such as `getPathData()` very expensive.
- Scale-disabled draw tools remain selectable; interaction is blocked, the board
  cursor is `not-allowed`, and status explains that the user must zoom in.
- Tool modules own tool-specific DOM behavior, stored-item summary/serialization,
  rendering, boot hooks, cleanup hooks, and rejection/disconnect handling.

## design system

- Style target: precise, calm, utilitarian whiteboard chrome around an infinite
  canvas.
- Default surfaces are white or near-white (`#ffffff`, `#fcfcfd`, `#f3f4f6`).
  Avoid decorative gradients, tinted cards, glossy treatments, and dark-theme
  fragments unless explicitly requested.
- Use thin cool-gray borders first (`#d9dde3`, stronger `#b8c0cc`) and very
  light shadows only when separation is needed.
- Keep controls compact and mostly square. Use tight radii: `2px` for controls,
  `4px` for larger panels.
- Use compact UI type: `13px` primary, `11px` to `12px` secondary.
- Default accent colors are the muted green family (`#abc6c6`, `#ccdfdf`).
- Idle status stays hidden. Only show persistent board-state UI when there is
  meaningful state to communicate.

## test commands

- Typecheck: `npm run typecheck`.
- Node suite: `npm run test-node` or targeted `node --test test-node/<file>.test.js`.
- Browser suite: `npm run test:pw` or targeted
  `npx playwright test playwright/tests/<file>.spec.ts`.
- Lint: `npm run lint`.
- Format: `npm run format`.
- Full local gate: `npm test`.
- Benchmarks: `npm run bench`, `npm run bench:load`, `npm run bench:persist`,
  `npm run bench:broadcast`, `npm run bench:e2e`.
- Profiling: `npm run profile -- <e2e|load|persist|broadcast>`.

`npm test` needs Chromium and local browser/network capability. If Chromium is
missing, run `npx playwright install chromium`.

In Playwright specs, assert authoritative app or socket state. Avoid sleeps. When
browser tests fail or flake, prefer fixing the application behavior over adding
test workarounds.

## change checklist

- Message shape or protocol: update the schema/metadata sources, shared message
  helpers, client send/draw paths if needed, focused Node tests, and benchmarks
  if a hot normalizer changed.
- Config/env: update [server/configuration.mjs](./server/configuration.mjs) and
  focused tests. Do not add memoization layers or reset hooks inside
  configuration.
- Rate limits: update shared rate-limit logic first, then server enforcement and
  policy. Run `node --test test-node/rate_limit_common.test.js test-node/socket_policy.test.js test-node/rate_limits.test.js`.
- Persistence, replay, or board state: review board data/session/persistence and
  SVG store together. Run focused Node tests and benchmarks for affected load,
  persist, or broadcast paths.
- Auth or permissions: start in `server/auth`, then verify HTTP routes and socket
  policy. Run relevant auth, route, and socket tests.
- Tool UX: start in `client-data/tools/<tool-id>`, shared tool helpers only when
  duplication is real, and verify with targeted Playwright or client-tool tests.
- HTTP template, cache, compression, or routing: update the route/helper source
  and server-route tests.

## profiling notes

- `npm run profile -- <scenario>` writes CPU and heap profiles under
  `.profiles/`.
- Use profiling after a benchmark regression, not as a routine check.
