import { renderArchivePng } from "./render.mjs";

// One archive per process: native allocations are reclaimed on process exit.
process.once("message", (input) => {
  let reply;
  try {
    reply = renderArchivePng(
      /** @type {Parameters<typeof renderArchivePng>[0]} */ (input),
    );
  } catch (error) {
    reply = {
      code:
        /** @type {{code?: string}} */ (error || {}).code || "render_failed",
      message:
        error instanceof Error ? error.message : "Archive rendering failed",
    };
  }
  process.send?.(reply, () => process.disconnect?.());
});
process.once("disconnect", () => process.exit(0));
