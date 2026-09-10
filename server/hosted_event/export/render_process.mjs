import { fork } from "node:child_process";

/** Includes process startup, SVG projection, rasterization and PNG validation. */
const EXPORT_RENDER_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Keep native rendering and its memory/libuv pool outside the serving process.
 * Settle only after the child closes so the next job cannot overlap its render.
 *
 * @param {Parameters<typeof import("./render.mjs").renderArchivePng>[0]} input
 * @returns {Promise<ReturnType<typeof import("./render.mjs").renderArchivePng>>}
 */
function renderArchivePngInChildProcess(input) {
  return new Promise((resolve, reject) => {
    const child = fork(new URL("./render_child.mjs", import.meta.url), [], {
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      execArgv: [],
    });
    const stopChild = () => {
      child.kill("SIGKILL");
    };
    process.once("exit", stopChild);
    /** @type {ReturnType<typeof import("./render.mjs").renderArchivePng> | undefined} */
    let result;
    /** @type {Error | undefined} */
    let failure;
    /** @param {string} code @param {string} message */
    function fail(code, message) {
      failure ||= Object.assign(new Error(message), { code });
      child.kill("SIGKILL");
    }
    const timer = setTimeout(() => {
      fail(
        "render_timeout",
        "Archive rendering exceeded the 300000ms deadline",
      );
    }, EXPORT_RENDER_TIMEOUT_MS);
    child.on("error", (error) => fail("render_failed", error.message));
    child.on("message", (message) => {
      if (result || failure) return;
      const reply =
        /** @type {{png?: Buffer, width?: number, height?: number, code?: string, message?: string}} */ (
          message
        );
      if (
        Buffer.isBuffer(reply.png) &&
        Number.isInteger(reply.width) &&
        Number.isInteger(reply.height)
      ) {
        result =
          /** @type {ReturnType<typeof import("./render.mjs").renderArchivePng>} */ (
            reply
          );
        child.kill("SIGKILL");
      } else {
        fail(
          reply.code || "render_failed",
          reply.message || "Invalid renderer reply",
        );
      }
    });
    child.once("close", () => {
      clearTimeout(timer);
      process.removeListener("exit", stopChild);
      if (failure) reject(failure);
      else if (result) resolve(result);
      else
        reject(
          Object.assign(new Error("Renderer exited without a PNG"), {
            code: "render_failed",
          }),
        );
    });
    child.send(input, (error) => {
      if (error) fail("render_failed", error.message);
    });
  });
}

export { EXPORT_RENDER_TIMEOUT_MS, renderArchivePngInChildProcess };
