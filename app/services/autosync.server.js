import { logEvent } from "./log.server";

/* Sync with Shopify when an admin page is opened or refreshed - no manual
   "Re-sync" click needed. The sync runs in the background (the page loads at
   once and polls until it finishes), never twice at the same time, and at
   most once per `minIntervalMs` however often the page is refreshed. */

const state = new Map(); // name -> { running, startedAt, finishedAt, error }

export function autoSync(name, fn, { minIntervalMs = 30_000 } = {}) {
  let s = state.get(name);
  if (!s) {
    s = { running: null, startedAt: 0, finishedAt: 0, error: null };
    state.set(name, s);
  }
  if (!s.running && Date.now() - s.startedAt >= minIntervalMs) {
    s.startedAt = Date.now();
    s.running = Promise.resolve()
      .then(fn)
      .then(() => {
        s.error = null;
      })
      .catch((err) => {
        s.error = String(err?.message || err);
        logEvent("error", "auto-sync:" + name, s.error, null, false);
      })
      .finally(() => {
        s.running = null;
        s.finishedAt = Date.now();
      });
  }
  return {
    syncing: !!s.running,
    lastSyncedAt: s.finishedAt ? new Date(s.finishedAt).toISOString() : null,
    error: s.error,
  };
}
