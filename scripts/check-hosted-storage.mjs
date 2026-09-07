import * as config from "../server/configuration.mjs";
import { createHostedStorage } from "../server/hosted_event/storage/index.mjs";

if (
  config.HOSTED_STATE_STORE !== "postgres" ||
  config.HOSTED_OBJECT_STORE !== "s3"
) {
  throw new Error(
    "Storage preflight requires WBO_HOSTED_STATE_STORE=postgres and WBO_HOSTED_OBJECT_STORE=s3",
  );
}

const storage = createHostedStorage(config);
try {
  await storage.initialize();
  process.stdout.write(
    "PostgreSQL and S3-compatible object storage are ready.\n",
  );
} finally {
  await storage.close();
}
