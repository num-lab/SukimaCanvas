# Use organizer-scoped entry grants for external entry

External integrations will authenticate with revocable organizer-scoped API credentials and exchange them for short-lived, single-use Entry Grants. This avoids sharing the service-wide board signing secret with organizers or exposing long-lived authorization in browser URLs, while keeping direct entry bound to an authenticated SukimaCanvas participant.

The browser receives an Entry Grant only in the redirect URL fragment, exchanges it with an HTTPS `POST` after authentication, and immediately clears the fragment. This keeps the one-time grant out of normal server access logs, referrer propagation, and durable browser history.
