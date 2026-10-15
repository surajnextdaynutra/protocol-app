import { connectDb } from "../db.server";
import { Kv, Log } from "../models/index.server";

/** Fire-and-forget audit / activity log line. Never throws - a logging
 *  hiccup must not break the request or job it is called from. */
export function logEvent(type, ref, message, data = null, ok = true) {
  connectDb()
    .then(() =>
      Log.create({
        type,
        ref: String(ref ?? ""),
        message: String(message ?? "").slice(0, 2000),
        data,
        ok,
      }),
    )
    .catch(() => {});
  if (!ok) console.error(`[rx:${type}] ${ref} ${message}`);
}

/* ---- tiny key/value store with expiry (job throttles, "already done" marks) */

export async function kvGet(key) {
  await connectDb();
  const row = await Kv.findById(key).lean();
  if (!row) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
  return row.value;
}

export async function kvSet(key, value, ttlSeconds) {
  await connectDb();
  await Kv.updateOne(
    { _id: key },
    {
      $set: {
        value,
        expiresAt: ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000) : null,
      },
    },
    { upsert: true },
  );
}

/** True when the caller got the slot; false when someone ran it within the
 *  window. Used to run a job at most once per `ttlSeconds` across restarts. */
export async function throttle(key, ttlSeconds) {
  if (await kvGet(key)) return false;
  await kvSet(key, 1, ttlSeconds);
  return true;
}

/**
 * Serialises work on one key inside this process (the app runs as a single
 * Node process). Replaces LockService: e.g. two orders/updated webhooks for
 * the same order must not both diff the same snapshot.
 */
const chains = new Map();
export function withLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const run = prev.then(fn);
  const tail = run.catch(() => {});
  chains.set(key, tail);
  tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}
