# Store accepted board changes in a durable ledger

SukimaCanvas will synchronously persist every accepted board change to a PostgreSQL ledger together with attribution and audit data, while retaining SVG as a materialized board snapshot. Recovery will load the latest snapshot and replay later ledger entries, which supports a five-second recovery-point objective and preserves audit history that a final SVG cannot represent.
