/**
 * The standalone lifecycle advancement used by hosted route factories when
 * the composed module did not inject one (standalone store composition): it
 * only advances the durable Board Session lifecycle, without the close
 * pipeline, which lives with the hosted module composition.
 *
 * @param {{
 *   organizerStore: ReturnType<typeof import("./organizers/store.mjs").createFileOrganizerStore>,
 *   clock: () => number,
 *   config: { HOSTED_BOARD_SESSION_CLOSE_DRAIN_MS?: number },
 * }} dependencies
 * @returns {() => Promise<void>}
 */
function createStoreLifecycleAdvancer(dependencies) {
  const { organizerStore, clock, config } = dependencies;
  return async () => {
    await organizerStore.advanceLifecycle({
      now: clock(),
      closeDrainMs: config.HOSTED_BOARD_SESSION_CLOSE_DRAIN_MS,
    });
  };
}

export { createStoreLifecycleAdvancer };
