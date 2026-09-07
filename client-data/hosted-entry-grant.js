/**
 * Hosted Entry Grant redemption.
 *
 * The grant token reaches this page only in the URL fragment (it never
 * touches the server on the way in). This script redeems it with a single
 * authenticated POST as soon as the participant is signed in, and clears the
 * fragment immediately so reloads, copies, and referrers never re-carry it. A
 * signed-out participant completes Hosted Account login first: the token
 * waits in this tab's sessionStorage (never a URL) and is redeemed when the
 * login redirect returns to this page. Every terminal outcome — success,
 * failure, or expiry — moves the browser to a clean event URL.
 */
(() => {
  const anchor = document.getElementById("hosted-entry-grant");
  if (!anchor) return;
  const FRAGMENT_PREFIX = "#entryGrant=";
  const STORAGE_KEY = "sukima-entry-grant";
  const publicId = anchor.getAttribute("data-event-public-id") || "";
  const signedIn = anchor.getAttribute("data-signed-in") === "1";
  const csrfToken = anchor.getAttribute("data-csrf") || "";
  if (publicId === "") return;

  function fragmentToken() {
    const hash = window.location.hash || "";
    return hash.startsWith(FRAGMENT_PREFIX)
      ? hash.slice(FRAGMENT_PREFIX.length)
      : "";
  }

  function storedToken() {
    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return "";
      const parsed = JSON.parse(raw);
      return parsed &&
        parsed.eventId === publicId &&
        typeof parsed.token === "string"
        ? parsed.token
        : "";
    } catch {
      return "";
    }
  }

  function stashToken(token) {
    try {
      window.sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ eventId: publicId, token }),
      );
    } catch {
      // Storage unavailable: the participant needs a fresh grant link.
    }
  }

  function dropStash() {
    try {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing to clean up.
    }
  }

  function clearFragment() {
    if (!window.location.hash) return;
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
  }

  function eventPath(query) {
    const base = `events/${encodeURIComponent(publicId)}`;
    return query ? `${base}?${query}` : base;
  }

  let token = fragmentToken();
  if (token !== "") {
    // The fragment has served its purpose the moment the token is read.
    clearFragment();
    if (!signedIn) {
      stashToken(token);
      return;
    }
  } else if (signedIn) {
    token = storedToken();
  }
  if (token === "" || !signedIn || csrfToken === "") return;

  fetch(`${eventPath()}/entry-grant`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    },
    body: new URLSearchParams({
      _csrf: csrfToken,
      entryGrant: token,
    }).toString(),
  })
    .then((response) => {
      if (response.ok) {
        dropStash();
        window.location.replace(eventPath());
        return;
      }
      if (response.status === 401) {
        // The session ended mid-flow; keep the grant for the next sign-in
        // instead of burning it on a login screen.
        stashToken(token);
        window.location.replace(eventPath());
        return;
      }
      dropStash();
      window.location.replace(eventPath("notice=grant_invalid"));
    })
    .catch(() => {
      // Network trouble: leave the stash in place so reloading this page
      // retries the redemption while the grant is still valid.
    });
})();
