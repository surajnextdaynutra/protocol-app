/* global globalThis */
import cron from "node-cron";
import { runProductSync, syncSharedInventory } from "./catalog.server";
import { syncAllAccounts } from "./accounts.server";
import { logEvent } from "./log.server";
import { syncRecentOrders } from "./orders.server";
import { runPrescriptionReminders } from "./prescriptions.server";
import { reconcilePatientPrices, syncAllProducts } from "./products.server";
import { sendDueWelcomeEmails } from "./provisioning.server";
import { invalidateResponses } from "./response-cache.server";

/* Timed jobs (were the Google time-driven triggers). They run inside the app
   server process - no external cron, no daily quota.

   Webhooks do the real-time work; the order / account / product jobs here
   are safety nets that re-check Shopify in case a webhook was missed. */

const JOBS = [
  // reminders, abandoned detection, link expiry
  { name: "reminders", schedule: "*/5 * * * *", run: runPrescriptionReminders },
  // welcome emails for newly created portal accounts
  { name: "welcome-emails", schedule: "*/5 * * * *", run: sendDueWelcomeEmails },
  // missed-webhook catch-up: last 2 days every 15 min, the full window nightly
  { name: "orders-recent", schedule: "7,22,37,52 * * * *", run: () => syncRecentOrders({ days: 2 }) },
  { name: "orders-full", schedule: "10 3 * * *", run: () => syncRecentOrders() },
  { name: "accounts", schedule: "40 2 * * *", run: syncAllAccounts },
  { name: "products", schedule: "55 2 * * *", run: syncAllProducts },
  // master products -> base product + one copy per practice
  { name: "product-copies", schedule: "12,42 * * * *", run: runProductSync },
  // one shared stock number across every copy of a master
  { name: "shared-inventory", schedule: "*/5 * * * *", run: syncSharedInventory },
  { name: "price-reconcile", schedule: "25 * * * *", run: reconcilePatientPrices },
];

const running = new Set();

/** Runs one job by name; overlapping runs of the same job are skipped. */
export async function runJob(name) {
  const job = JOBS.find((j) => j.name === name) || extraJobs.find((j) => j.name === name);
  if (!job) throw new Error("unknown job " + name);
  if (running.has(name)) return { skipped: "already running" };
  running.add(name);
  const started = Date.now();
  try {
    const result = await job.run();
    // every run is logged, not only failures - so "did it run?" is answerable
    logEvent("job", "job:" + name, `finished in ${Date.now() - started} ms: ${JSON.stringify(result ?? {}).slice(0, 300)}`);
    return { ok: true, ms: Date.now() - started, result };
  } catch (err) {
    logEvent("error", "job:" + name, String(err?.stack || err), null, false);
    return { ok: false, error: String(err?.message || err) };
  } finally {
    running.delete(name);
    invalidateResponses(); // a job may have changed prescriptions / orders / payouts
  }
}

// Jobs registered by other modules (product copies, welcome emails, …).
const extraJobs = [];
export function registerJob(job) {
  if (!extraJobs.some((j) => j.name === job.name)) extraJobs.push(job);
  if (globalThis.__rxSchedulerStarted && job.schedule) {
    cron.schedule(job.schedule, () => runJob(job.name));
  }
}

export function listJobs() {
  return [...JOBS, ...extraJobs].map((j) => ({
    name: j.name,
    schedule: j.schedule || "manual",
    running: running.has(j.name),
  }));
}

export function startScheduler() {
  if (globalThis.__rxSchedulerStarted) return;
  // Say why the timed jobs are NOT running - silently off is what hid the
  // missing welcome emails.
  const off = (why) => {
    if (globalThis.__rxSchedulerOffLogged) return;
    globalThis.__rxSchedulerOffLogged = true;
    console.log(`[rx] scheduler OFF - ${why}`);
    logEvent("job", "scheduler", `timed jobs are OFF - ${why}`, null, false);
  };
  if (process.env.RX_SCHEDULER === "off") return off("RX_SCHEDULER=off");
  // `shopify app dev` restarts the server on every edit - only run timed jobs
  // there when asked to.
  if (process.env.NODE_ENV !== "production" && process.env.RX_SCHEDULER !== "on") {
    return off(`NODE_ENV=${process.env.NODE_ENV || "(unset)"}; set RX_SCHEDULER=on in .env to run them in development`);
  }
  globalThis.__rxSchedulerStarted = true;
  logEvent("job", "scheduler", `timed jobs started (${JOBS.length + extraJobs.length})`);
  for (const job of [...JOBS, ...extraJobs]) {
    if (job.schedule) cron.schedule(job.schedule, () => runJob(job.name));
  }
  console.log(`[rx] scheduler started (${JOBS.length + extraJobs.length} jobs)`);
}
