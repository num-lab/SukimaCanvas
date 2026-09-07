# Store board artifacts in object storage

SukimaCanvas will store Board Archive snapshots, sanitized published canvases, Brand Assets, and generated Image Exports in S3-compatible object storage, while PostgreSQL stores their metadata and the durable change ledger. Local disk is only a disposable working cache, which removes a single host filesystem from the recovery and future-scaling boundary.
