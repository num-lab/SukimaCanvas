# Hosted Event Service — Deployment

How to stand one instance up. [runbook.md](./runbook.md) covers operating it
afterwards (backup, recovery, capacity, failure playbooks) and
[launch-evidence.md](./launch-evidence.md) records the measured evidence.

Every `WBO_*` field is read once at startup (`server/configuration.mjs`).
Changing one means a restart.

## 1. Required configuration

Without these the service either refuses to boot or boots into a state where
the product does not work.

| Variable | Not set means |
| --- | --- |
| `WBO_HOSTED_MODE=true` | The Hosted Event Service is off. The process serves legacy WBO instead: arbitrary boards, no events, no admission. |
| `AUTH_SECRET_KEY` | **The process refuses to start** in hosted mode. It derives every Participant Identifier and the webhook and export-download HMACs. Treat it as permanent: rotating it changes every published attribution identifier and invalidates every outstanding export link. Store it in the platform secret store, never in the image. |
| `WBO_HOSTED_OPERATOR_EMAILS` | No Platform Operator exists, so no Organizer Application can ever be approved and nothing downstream (reservations, events, board sessions) can be created. Comma-separated; each address must belong to an account that registers and verifies normally. |
| `WBO_DEPLOYMENT_VERSION`, `WBO_CORRESPONDING_SOURCE_URL` (must contain `{version}`), `WBO_CORRESPONDING_SOURCE_BUILD` | `/source` fails closed with 503 and the deployment does not satisfy its AGPL Corresponding Source obligation. Pin an immutable version, never a rolling label. |
| `NODE_ENV=production` | Development defaults stay on, including non-`Secure` session cookies. |

Worth setting deliberately:

| Variable | Default | Why |
| --- | --- | --- |
| `WBO_HOSTED_DATA_DIR` | `<cwd>/hosted-data` | The data root. See §3. |
| `WBO_HISTORY_DIR` | `<cwd>/server-data` | Board snapshots. See §3. |
| `WBO_HOSTED_MAIL_TRANSPORT` | `outbox` | `smtp` sends real mail; `outbox` writes JSON files nobody delivers. See §4. |
| `WBO_HOSTED_SERVICE_UTC_OFFSET_MINUTES` | `480` | Fixed service timezone for reservation wall-clock times. 480 is mainland China; change only with the service region. |
| `TURNSTILE_SECRET_KEY`, `TURNSTILE_SITE_KEY` | unset | Registration and login run without a CAPTCHA when unset. |
| `PORT`, `HOST` | `8080` | The container image sets `PORT=80`. |
| `LOG_LEVEL` | `info` | |

Capacity, retention, rate-limit, and timing fields all have documented
defaults matching the launch commitments; override only against a recorded
decision.

## 2. HTTPS and the reverse proxy

**HTTPS is not optional.** With `NODE_ENV=production` the hosted session
cookie is issued `Secure`, so over plain HTTP the browser discards it and
nobody can log in. Terminate TLS in front of the process.

Behind a proxy, also set the client-address source, or every request appears
to come from the proxy and the per-IP rate limits (registration, login,
password reset, access codes, entry grants) apply to all users at once:

- `WBO_IP_SOURCE=X-Forwarded-For` (default is `remoteAddress`)
- `WBO_TRUST_PROXY_HOPS=<number of proxies you control>` — must be > 0 when
  a forwarded header is the source, and must count only hops you actually
  operate; a larger number lets a client forge its own address.

If WBO is mounted under a path prefix rather than at the domain root, set
`WBO_BASE_PATH` to that external prefix.

## 3. Data roots that must be persisted

Two directories hold everything:

- `WBO_HOSTED_DATA_DIR` — accounts, sessions, organizers, reservations,
  events, board sessions, mutation ledgers, private archives, published
  canvases, image exports, notification queue, webhook outbox, moderation
  log, brand assets. Full inventory in runbook §1.
- `WBO_HISTORY_DIR` — board SVG snapshots (a rebuildable projection of the
  ledgers, but restoring without it means replaying every ledger).

The container image declares both as volumes (`/opt/app/hosted-data`,
`/opt/app/server-data`) and `docker-compose.yml` mounts both. **A deployment
that mounts only `server-data` loses every account and every archive on the
next container rebuild.** Back both up together — they are one consistency
domain (runbook §2).

## 4. First run: bootstrapping the first Organizer

Platform Operators are granted by configuration, everything else by the
product's own flows. In order:

1. Set `WBO_HOSTED_OPERATOR_EMAILS` to the operator's address and start the
   service.
2. Register that address at `/register` (email, password, 18+ confirmation),
   then verify it — see the mail note below.
3. Sign in. `/operator` is now available to that account.
4. The organizer applies at `/organizer/apply` from their own verified
   account; the operator reviews pending applications from `/operator` and
   approves at `/operator/applications/{applicationId}`.
5. The Organizer Owner reserves a Board Session from `/organizer`; the
   operator approves it under `/operator/reservations`. Approval commits the
   capacity allocation and creates the Event.
6. Participants reach the event at `/events/{publicId}` and enter with the
   Access Code. The board itself is `/b/{boardName}`, only after admission.

Step 2 needs mail to work. Configure it before the first registration.

### Mail

Set `WBO_HOSTED_MAIL_TRANSPORT=smtp` to send real mail. The default,
`outbox`, writes each message as `message-<id>.json`
(`{to, subject, body, sentAtMs}`) under
`<WBO_HOSTED_DATA_DIR>/mail-outbox` (override with
`WBO_HOSTED_MAIL_OUTBOX_DIR`) and delivers nothing — usable for a local trial
by reading the verification link out of `body`, not for a real deployment.

With `smtp`, these apply (`ADR 0010`):

| Variable | Default | |
| --- | --- | --- |
| `WBO_HOSTED_MAIL_FROM` | — | **Required.** Its domain must be onboarded with the vendor. |
| `WBO_HOSTED_SMTP_PASSWORD` | — | **Required.** For Cloudflare, an API token with Email Sending: Edit. Keep it in the secret store. |
| `WBO_HOSTED_MAIL_FROM_NAME` | unset | Display name beside the From address. |
| `WBO_HOSTED_SMTP_HOST` | `smtp.mx.cloudflare.net` | Any SMTP vendor works; only the defaults are Cloudflare's. |
| `WBO_HOSTED_SMTP_PORT` | `465` | Cloudflare offers implicit TLS on 465 only — no STARTTLS on 587, no relay on 25. |
| `WBO_HOSTED_SMTP_USER` | `api_token` | Cloudflare authenticates its API token under this literal username. |
| `WBO_HOSTED_SMTP_TLS` | `true` | Only disablable for a loopback host; the adapter refuses anything routable, so the credential never crosses a network in the clear. |

Missing the From address or the credential refuses the start (§5) rather than
accepting registrations whose verification mail can never arrive.

Cloudflare-side setup, per its docs: the domain's DNS must be on Cloudflare,
the domain onboarded under Compute → Email Service → Email Sending, and the
`cf-bounce` MX plus SPF, DKIM, and DMARC records published. Email Sending is
Beta, transactional-only, on Workers Paid — which fits this service's mail
exactly (verification, resets, invitations, lifecycle notices; no marketing).

A vendor outage is not lost mail: delivery failures stay queued with backoff
and appear on the operator console with the recipient and the vendor's SMTP
reply. Watch that list after the first deploy.

**Unverified for mainland China.** Reachability of
`smtp.mx.cloudflare.net:465` from a mainland China host, and deliverability
to QQ, 163, and 126 mailboxes from Cloudflare's senders, are untested here
and are the main risk in this choice. Measure both during the deployment
test, record the result in `launch-evidence.md`, and switch the host, port,
and credentials to a domestic vendor if the numbers are poor — no code change
is needed for that.

## 5. Verify after every deploy

- `/source` returns 200 and names the exact immutable version just deployed.
  A 503 means the mapping is missing or a rolling label was pinned.
- `/` serves the hosted shell (the readiness probe in `app.json` matches
  `hosted-shell` on this page).
- Sign in as the operator and load `/operator` — this exercises the session
  cookie end to end, which is where a missing HTTPS terminator shows up.
- Confirm both data roots are mounted and writable before the first event.

A refused start exits with status 1 and writes `server.start_failed: <reason>`
to stderr — read it before assuming the platform is at fault.

## 6. Known limits of this release

- **One active application instance.** Seat and connection accounting live in
  process; a second instance would double-count. Scale-out is a post-launch
  decision (runbook §6).
- **File-backed adapters.** PostgreSQL and S3-compatible object storage are
  the intended stores and are not selected yet; the recovery contract in
  runbook §2 is written so the swap does not change it.
- **Mail delivery is unproven from the service region.** The vendor is
  selected and wired (§4), but nothing here has sent a message from a
  mainland China host to a domestic mailbox.
- **A large Image Export stalls the instance** for the duration of the render
  (issue 24, launch-evidence §3). Until that is resolved, treat exports of
  large archives as a scheduled maintenance action rather than a
  self-service button during a live event.
- **Legal review of the Terms of Service and Privacy Policy is outstanding**
  and blocks opening registrations (runbook §8).
