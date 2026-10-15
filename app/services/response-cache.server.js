/* Short-lived cache of storefront API answers (dashboards, product lists,
   patient search…), one entry per logged-in account + request.

   Why: every dashboard load is several MongoDB queries; reloads, tab
   switches and the 60-second auto-refresh asked for the same answer again.
   Now a repeat within TTL_MS is served from memory.

   Never stale after a change: ANY write - a storefront save, a webhook
   (order / customer / product), a scheduled job, an admin change - clears
   the whole cache (see invalidateResponses callers). A request already
   running while a write happens is not stored.

   Only answers listed as cacheable in api/index.server.js are kept, and
   every entry is keyed by the logged-in customer, so one account never
   receives another account's data. Banking details are never cached. */

const TTL_MS = 45_000;
const MAX_ENTRIES = 1000;

const store = new Map(); // key -> { at, body }
const inflight = new Map(); // key -> Promise<body>
let version = 0;

/** Drops every cached answer (call after any write). */
export function invalidateResponses() {
  version++;
  store.clear();
  inflight.clear();
}

/**
 * The cached JSON body for `key`, or runs `fn()` (returning the JSON string)
 * and keeps it. Identical requests arriving together share one run.
 * Returns { body, hit }.
 */
export async function cachedBody(key, fn) {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return { body: hit.body, hit: true };
  if (inflight.has(key)) return { body: await inflight.get(key), hit: true };

  const startVersion = version;
  const run = (async () => fn())();
  inflight.set(key, run);
  try {
    const body = await run;
    // a write happened meanwhile -> this answer may already be out of date
    if (body != null && version === startVersion) {
      if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value);
      store.set(key, { at: Date.now(), body });
    }
    return { body, hit: false };
  } finally {
    if (inflight.get(key) === run) inflight.delete(key);
  }
}
