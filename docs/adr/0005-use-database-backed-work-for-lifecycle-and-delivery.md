# Use database-backed work for lifecycle and delivery

SukimaCanvas will use PostgreSQL-backed scheduled work and an outbox for session transitions, archive creation, image exports, notifications, and webhooks. Workers will recover due or unfinished work after restart, rather than treating in-process timers or best-effort sends as authoritative, so the single-instance deployment can still meet its lifecycle and recovery commitments.
