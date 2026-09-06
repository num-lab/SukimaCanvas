const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

const {
  createFixture,
  connectSocket,
  cookieFor,
  rectangleCreate,
  ownAcceptance,
  createSocketScenario,
  participantIdentifierFor,
} = require("./helpers/hosted_board_fixture.js");
const {
  createRateLimiter,
} = require("../server/hosted_event/accounts/rate_limits.mjs");
const {
  createFileBrandAssetStore,
} = require("../server/hosted_event/assets/store.mjs");
const {
  createEventRoutes,
} = require("../server/hosted_event/events/routes.mjs");
const {
  createFilePublicationStore,
} = require("../server/hosted_event/publication/store.mjs");
const {
  createFileBoardExportStore,
} = require("../server/hosted_event/export/store.mjs");
const { BoundaryError } = require("../server/http/boundary_errors.mjs");
const {
  HOSTED_CSRF_COOKIE_NAME,
} = require("../server/auth/hosted_cookies.mjs");

const MINUTE = 60 * 1000;

/** One stubbed hosted page template: captures what the route renders. */
function templateStub() {
  /** @type {{status?: number, params?: any}} */
  const last = {};
  /**
   * @param {any} _request
   * @param {any} response
   * @param {number} statusCode
   * @param {any} extraParams
   */
  const serveWithStatus = (_request, response, statusCode, extraParams) => {
    last.status = statusCode;
    last.params = extraParams;
    response.writeHead(statusCode);
    response.end();
    return {};
  };
  const translationsFor = () => ({ language: "en", translations: {} });
  return /** @type {any} */ ({ last, serveWithStatus, translationsFor });
}

/**
 * Composes the real event routes over the fixture stores with stubbed
 * templates, exactly like the hosted module does, and a fabricated HTTP
 * route context.
 *
 * @param {any} fixture
 */
function composeRoutes(fixture) {
  const templates = {
    home: templateStub(),
    event: templateStub(),
    organizerEvent: templateStub(),
    organizerEventAudit: templateStub(),
    publishedCanvas: templateStub(),
  };
  const routes = createEventRoutes({
    config: fixture.config,
    clock: () => fixture.holder.now,
    accountStore: fixture.accountStore,
    organizerStore: fixture.organizerStore,
    membershipStore: fixture.membershipStore,
    moderation: fixture.eventModeration,
    assetStore: createFileBrandAssetStore({
      dataDir: fixture.dataDir,
      clock: () => fixture.holder.now,
    }),
    publicationStore: fixture.publicationStore,
    archiveStore: fixture.archiveStore,
    participantIdentifierFor,
    // The manage page renders the export queue, so the real export store
    // backs the composition; the pipeline itself is never invoked here.
    exportStore: createFileBoardExportStore({
      dataDir: fixture.dataDir,
      clock: () => fixture.holder.now,
      linkTtlMs: 24 * 60 * 60 * 1000,
      hmacKey: "publication-test-secret",
    }),
    exportPipeline: /** @type {any} */ ({}),
    limiter: createRateLimiter({ clock: () => fixture.holder.now }),
    advanceEventLifecycle: fixture.hostedModule.refreshEventLifecycle,
    templates,
  });
  return { routes, templates };
}

const CSRF = "publication-csrf-0123456789";

/**
 * @param {{request: any, response: any, params?: any, url?: URL}} context
 */
function headersOf(context) {
  return context.response.headers || {};
}

/**
 * A fabricated route context. GETs carry only headers; POSTs carry a
 * urlencoded body through an async-iterable request, like readFormBody sees.
 *
 * @param {{method?: string, params?: Record<string, string>, form?: Record<string, string>, cookie?: string}} options
 * @returns {any}
 */
function makeCtx(options = {}) {
  const cookie = options.cookie;
  /** @type {{[name: string]: string}} */
  const responseHeaders = {};
  let statusCode = 0;
  /**
   * @param {string} name
   * @param {string} value
   */
  const setHeader = (name, value) => {
    responseHeaders[name] = value;
  };
  /**
   * @param {number} status
   * @param {object} [extraHeaders]
   */
  const writeHead = (status, extraHeaders) => {
    statusCode = status;
    Object.assign(responseHeaders, extraHeaders || {});
  };
  const end = () => {};
  const body = Buffer.from(
    new URLSearchParams({
      _csrf: CSRF,
      ...(options.form || {}),
    }).toString(),
  );
  const ctx = {
    response: {
      headers: responseHeaders,
      get statusCode() {
        return statusCode;
      },
      setHeader,
      writeHead,
      end,
    },
    params: options.params || {},
    url: new URL("http://service.test/canvas"),
    request: {
      method: options.method || "GET",
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(options.method === "POST"
          ? { "content-type": "application/x-www-form-urlencoded" }
          : {}),
      },
    },
  };
  if (options.method === "POST") {
    /** @type {any} */ (ctx.request)[Symbol.asyncIterator] = () => {
      let consumed = false;
      return {
        next: async () => {
          if (consumed) return { done: true, value: undefined };
          consumed = true;
          return { done: false, value: body };
        },
      };
    };
  }
  return ctx;
}

/**
 * Connects a member's socket through the real hosted admission gate, failing
 * the test on refusal (the archive tests' guard, inlined).
 *
 * @param {any} scenario
 * @param {any} fixture
 * @param {{rawSessionId: string}} member
 * @param {string} socketId
 * @returns {Promise<any>}
 */
async function openAndConnect(scenario, fixture, member, socketId) {
  const connected = await connectSocket(
    scenario,
    fixture.hostedModule,
    fixture.event.boardName,
    cookieFor(member.rawSessionId),
    socketId,
  );
  if (connected.ok === false || !connected.created) {
    throw new Error(
      `socket connection was refused: ${connected.ok === false ? connected.reason : "no socket"}`,
    );
  }
  return connected.created;
}

/** @param {any} fixture */
const ownerCookie = (fixture) =>
  `${cookieFor(fixture.owner.rawSessionId)}; ${HOSTED_CSRF_COOKIE_NAME}=${CSRF}`;
/** @param {any} member */
const memberCookie = (member) =>
  `${cookieFor(member.rawSessionId)}; ${HOSTED_CSRF_COOKIE_NAME}=${CSRF}`;

test("the published canvas shows only identified participants' identifiers and every audience is re-checked per read", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-published-privacy-" },
    async (scenario) => {
      const fixture = /** @type {any} */ (
        await createFixture(Date.now(), {
          config: scenario.sockets.__config,
        })
      );
      fixture.config = scenario.sockets.__config;
      // The publication store rides on the same data dir and immutable
      // archive store the close pipeline uses.
      fixture.publicationStore = createFilePublicationStore({
        dataDir: fixture.dataDir,
        clock: () => fixture.holder.now,
        archiveStore: fixture.archiveStore,
      });
      const { routes, templates } = composeRoutes(fixture);

      // Two members draw: Alice stays identified, Bob goes anonymous before
      // the session closes.
      fixture.holder.now = fixture.boardSession.startsAtMs;
      await fixture.organizerStore.advanceLifecycle({
        now: fixture.holder.now,
      });
      const alice = await fixture.addMember("alice@example.com");
      const bob = await fixture.addMember("bob@example.com");
      const aliceConnected = await openAndConnect(
        scenario,
        fixture,
        alice,
        "socket-alice",
      );
      await scenario.invoke(
        aliceConnected,
        "broadcast",
        rectangleCreate("rect-alice", "cm-alice"),
      );
      ownAcceptance(aliceConnected, "cm-alice");
      const bobConnected = await openAndConnect(
        scenario,
        fixture,
        bob,
        "socket-bob",
      );
      await scenario.invoke(
        bobConnected,
        "broadcast",
        rectangleCreate("rect-bob", "cm-bob"),
      );
      ownAcceptance(bobConnected, "cm-bob");
      await fixture.membershipStore.setAnonymity({
        eventId: fixture.event.eventId,
        accountId: bob.accountId,
        anonymity: "anonymous",
      });

      // Close and archive.
      fixture.holder.now = fixture.boardSession.endsAtMs + MINUTE;
      await fixture.organizerStore.advanceLifecycle({
        now: fixture.holder.now,
      });
      const closed = await fixture.boardArchivePipeline.runDueCloses({
        now: fixture.holder.now,
      });
      assert.equal(closed.length, 1);
      const session = fixture.organizerStore.getBoardSessionForEvent(
        fixture.event.eventId,
      );
      assert.equal(session?.status, "closed");

      const aliceId = participantIdentifierFor(
        fixture.event.eventId,
        alice.accountId,
      );
      const bobId = participantIdentifierFor(
        fixture.event.eventId,
        bob.accountId,
      );

      // The Owner publishes with attribution for the link audience.
      await routes.serveOrganizerEventPublication(
        makeCtx({
          method: "POST",
          form: { audience: "link", showAttribution: "1" },
          cookie: ownerCookie(fixture),
          params: {
            organizerId: fixture.event.organizerId,
            eventId: fixture.event.eventId,
          },
        }),
      );
      const manageRender = templates.organizerEvent.last;
      assert.equal(manageRender.status, 200);
      const shareUrl = /** @type {string} */ (
        manageRender.params.hostedPublicationShareUrl
      );
      assert.match(shareUrl, /\/events\/[^/]+\/canvas\/[A-Za-z0-9_-]+$/);
      const token = new URL(shareUrl, "http://service.test").pathname
        .split("/")
        .pop();

      // The sanitized artifact: Alice's attribution stays, Bob's is gone.
      const publication =
        fixture.publicationStore.getPublicationForBoardSession(
          /** @type {string} */ (session?.boardSessionId),
        );
      assert.equal(publication?.status, "published");
      assert.equal(publication?.audience, "link");
      const derived = (
        await fixture.archiveStore.readArchive(
          /** @type {string} */ (publication?.canvasKey),
        )
      )?.toString("utf8");
      assert.ok(derived);
      assert.ok(
        derived.includes(`data-wbo-created-by="${aliceId}"`),
        "the identified participant keeps their identifier",
      );
      assert.ok(
        !derived.includes(bobId),
        "the anonymous participant's identifier is absent from the artifact",
      );
      assert.match(derived, /data-wbo-readonly="true"/);
      // No internal identity, session, or audit material in the artifact.
      assert.ok(!derived.includes(alice.accountId));
      assert.ok(!derived.includes(bob.accountId));
      assert.ok(!derived.includes(session?.boardSessionId || ""));
      assert.ok(!derived.includes("acceptedMutation"));
      // The private archive itself is untouched.
      const privateCanvas = (
        await fixture.archiveStore.readArchive(
          /** @type {string} */ (session?.archiveKey || "").replace(
            /manifest\.json$/,
            "canvas.svg",
          ),
        )
      )?.toString("utf8");
      assert.ok(privateCanvas?.includes(`data-wbo-created-by="${bobId}"`));

      // Reading the canvas through the share link renders the sanitized
      // page: noindex headers, contributors without Bob.
      const linkCtx = makeCtx({
        params: { publicId: fixture.event.publicId, token: token || "" },
      });
      await routes.servePublishedCanvas(linkCtx);
      assert.equal(linkCtx.response.statusCode, 200);
      assert.equal(headersOf(linkCtx)["X-Robots-Tag"], "noindex, nofollow");
      const page = templates.publishedCanvas.last;
      assert.equal(page.params.hostedCanvasAttribution, true);
      assert.ok(page.params.hostedCanvasSvg.includes(aliceId));
      assert.ok(!page.params.hostedCanvasSvg.includes(bobId));
      assert.deepEqual(
        page.params.hostedCanvasContributors.map(
          /** @param {{participantId: string}} entry */
          (entry) => entry.participantId,
        ),
        [aliceId],
      );

      // The same URL without the token is a uniform 404 — the link audience
      // is checked per read.
      await assert.rejects(
        () =>
          routes.servePublishedCanvas(
            makeCtx({ params: { publicId: fixture.event.publicId } }),
          ),
        (error) =>
          error instanceof BoundaryError &&
          error.statusCode === 404 &&
          error.reason === "published_canvas_not_found",
      );
      await assert.rejects(
        () =>
          routes.servePublishedCanvas(
            makeCtx({
              params: {
                publicId: fixture.event.publicId,
                token: "wrong-token-value",
              },
            }),
          ),
        { statusCode: 404 },
      );
      // An unknown Public ID is the same 404: nothing is confirmed.
      await assert.rejects(
        () =>
          routes.servePublishedCanvas(
            makeCtx({
              params: { publicId: "does-not-exist", token: token || "" },
            }),
          ),
        { statusCode: 404 },
      );

      // Switching the audience to members: the old share link dies
      // immediately, a signed-in member may read, a signed-out one may not.
      await routes.serveOrganizerEventPublication(
        makeCtx({
          method: "POST",
          form: { audience: "members", showAttribution: "1" },
          cookie: ownerCookie(fixture),
          params: {
            organizerId: fixture.event.organizerId,
            eventId: fixture.event.eventId,
          },
        }),
      );
      await assert.rejects(
        () =>
          routes.servePublishedCanvas(
            makeCtx({
              params: { publicId: fixture.event.publicId, token: token || "" },
            }),
          ),
        { statusCode: 404 },
      );
      const memberCtx = makeCtx({
        cookie: memberCookie(alice),
        params: { publicId: fixture.event.publicId },
      });
      await routes.servePublishedCanvas(memberCtx);
      assert.equal(memberCtx.response.statusCode, 200);
      await assert.rejects(
        () =>
          routes.servePublishedCanvas(
            makeCtx({ params: { publicId: fixture.event.publicId } }),
          ),
        { statusCode: 404 },
      );

      // Organizer-only audience: the member is refused, the owner passes.
      await routes.serveOrganizerEventPublication(
        makeCtx({
          method: "POST",
          form: { audience: "organizer", showAttribution: "1" },
          cookie: ownerCookie(fixture),
          params: {
            organizerId: fixture.event.organizerId,
            eventId: fixture.event.eventId,
          },
        }),
      );
      await assert.rejects(
        () =>
          routes.servePublishedCanvas(
            makeCtx({
              cookie: memberCookie(alice),
              params: { publicId: fixture.event.publicId },
            }),
          ),
        { statusCode: 404 },
      );
      const ownerCtx = makeCtx({
        cookie: ownerCookie(fixture),
        params: { publicId: fixture.event.publicId },
      });
      await routes.servePublishedCanvas(ownerCtx);
      assert.equal(ownerCtx.response.statusCode, 200);

      // Revocation: every audience and the old link stop immediately.
      const revokeCtx = makeCtx({
        method: "POST",
        cookie: ownerCookie(fixture),
        params: {
          organizerId: fixture.event.organizerId,
          eventId: fixture.event.eventId,
        },
      });
      await routes.serveOrganizerEventPublicationRevoke(revokeCtx);
      assert.equal(revokeCtx.response.statusCode, 303);
      for (const ctx of [
        makeCtx({
          cookie: ownerCookie(fixture),
          params: { publicId: fixture.event.publicId },
        }),
        makeCtx({
          cookie: memberCookie(alice),
          params: { publicId: fixture.event.publicId },
        }),
        makeCtx({
          params: { publicId: fixture.event.publicId, token: token || "" },
        }),
      ]) {
        await assert.rejects(() => routes.servePublishedCanvas(ctx), {
          statusCode: 404,
        });
      }

      // A publish attempt while the session was never archived is refused.
      // (fresh fixture above had no close; run its publish once more for a
      // deterministic status assertion)
      const fresh2 = /** @type {any} */ (
        await createFixture(Date.now(), {
          config: scenario.sockets.__config,
        })
      );
      fresh2.config = scenario.sockets.__config;
      fresh2.publicationStore = createFilePublicationStore({
        dataDir: fresh2.dataDir,
        clock: () => fresh2.holder.now,
        archiveStore: fresh2.archiveStore,
      });
      const fresh2Routes = composeRoutes(fresh2);
      const earlyCtx = makeCtx({
        method: "POST",
        form: { audience: "link", showAttribution: "1" },
        cookie: ownerCookie(fresh2),
        params: {
          organizerId: fresh2.event.organizerId,
          eventId: fresh2.event.eventId,
        },
      });
      await fresh2Routes.routes.serveOrganizerEventPublication(earlyCtx);
      assert.equal(earlyCtx.response.statusCode, 409);
      assert.equal(
        fresh2Routes.templates.organizerEvent.last.params
          .hostedEventManageError,
        "hosted_publication_error_not_archived",
      );
    },
  );
});

test("publish refuses an archived canvas that fails its manifest integrity hash", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-published-integrity-" },
    async (scenario) => {
      const fixture = /** @type {any} */ (
        await createFixture(Date.now(), {
          config: scenario.sockets.__config,
        })
      );
      fixture.config = scenario.sockets.__config;
      fixture.publicationStore = createFilePublicationStore({
        dataDir: fixture.dataDir,
        clock: () => fixture.holder.now,
        archiveStore: fixture.archiveStore,
      });
      const { routes } = composeRoutes(fixture);

      // Close the (empty) session so its archive exists, then tamper with
      // the canvas bytes at rest: the manifest's integrity hash no longer
      // matches, so the archive must not become a publication source.
      fixture.holder.now = fixture.boardSession.endsAtMs + MINUTE;
      await fixture.hostedModule.refreshEventLifecycle();
      const session = fixture.organizerStore.getBoardSessionForEvent(
        fixture.event.eventId,
      );
      assert.equal(session?.status, "closed");
      // The archive store's root is `<dataDir>/board-archives/` and the
      // close pipeline's keys repeat that prefix as their namespace.
      const canvasPath = path.join(
        fixture.dataDir,
        "board-archives",
        /** @type {string} */ (session?.archiveKey || "").replace(
          /manifest\.json$/,
          "canvas.svg",
        ),
      );
      await fs.writeFile(canvasPath, '<svg id="canvas">tampered</svg>');

      await assert.rejects(
        () =>
          routes.serveOrganizerEventPublication(
            makeCtx({
              method: "POST",
              form: { audience: "link", showAttribution: "1" },
              cookie: ownerCookie(fixture),
              params: {
                organizerId: fixture.event.organizerId,
                eventId: fixture.event.eventId,
              },
            }),
          ),
        (error) =>
          error instanceof BoundaryError &&
          error.statusCode === 500 &&
          error.reason === "published_archive_unavailable",
      );
      assert.equal(
        fixture.publicationStore.getPublicationForBoardSession(
          session?.boardSessionId,
        ),
        null,
        "no publication is recorded for an unverified archive",
      );
    },
  );
});
