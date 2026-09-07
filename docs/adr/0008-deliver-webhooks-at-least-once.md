# Deliver webhooks at least once

SukimaCanvas will emit signed webhook events through the durable outbox with at-least-once delivery and stable event identifiers for subscriber deduplication. It deliberately does not promise exactly-once remote delivery, because network acknowledgement is inherently ambiguous; failed deliveries retry for 24 hours and then pause the subscription with organizer notification.
