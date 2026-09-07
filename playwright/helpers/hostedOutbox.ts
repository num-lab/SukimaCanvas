import * as fs from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import type { TestServer } from "./testServer";

/**
 * Reads the verification or password-reset link that the hosted mail outbox
 * queued for one recipient, waiting for delivery.
 *
 * @param {TestServer} server
 * @param {string} recipient
 * @param {"verify" | "reset"} kind
 * @returns {Promise<string>}
 */
export async function readAccountEmailLink(
  server: TestServer,
  recipient: string,
  kind: "verify" | "reset",
): Promise<string> {
  let link = "";
  await expect
    .poll(async () => {
      const dir = path.join(server.dataPath, "hosted-data", "mail-outbox");
      const files = (await fs.readdir(dir).catch(() => [])).sort();
      for (const file of files) {
        const message = JSON.parse(
          await fs.readFile(path.join(dir, file), "utf8"),
        );
        if (
          message.to === recipient &&
          message.body.includes(`/${kind}?token=`)
        ) {
          const match = /https?:\/\/\S+/.exec(message.body);
          if (match) link = match[0];
        }
      }
      return link;
    })
    .not.toBe("");
  return link;
}
