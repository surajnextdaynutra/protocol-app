import { connectDb } from "../db.server";
import { ApiError, getCaller } from "../services/caller.server";
import { logEvent } from "../services/log.server";
import { cachedBody, invalidateResponses } from "../services/response-cache.server";
import { resources } from "./resources.server";

/* One entry point for every /apps/rx/<resource> call. Each resource is a map
   of action name -> handler(ctx); see resources.server.js. Responses keep the
   shapes the Apps Script web apps returned, so the pages read them unchanged. */

const json = (body, status = 200, extraHeaders = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });

/* Read-only answers that may be served from the per-account cache
   (services/response-cache.server.js). Everything else - saves, sends,
   tracking, banking - always runs, and clears the cache afterwards. */
const CACHEABLE = {
  builder: ["search", "patientHistory"],
  practice: ["dashboard", "products", "practiceInfo", "clinicInfo", "practiceAccountInfo", "payoutOrders", "getAccount"],
  physician: ["dashboard", "practiceInfo", "clinicName", "payoutOrders", "products", "getAccount"],
  clinic: ["dashboard", "getAccount"],
  rep: ["repdash"],
  finance: ["admindash", "orderDetail"],
  account: ["getAccount", "orderHistory"],
  about: ["aboutUsLoad"],
  physicians: ["customers"],
};
// reads that are never cached (banking) still don't clear the cache
const READ_ONLY = new Set([...Object.values(CACHEABLE).flat(), "ping", "load", "bankingLoad", "guardcheck"]);
// Shopify's per-request signing params (they change every call) and tokens
const KEY_SKIP = new Set(["signature", "timestamp", "path_prefix", "shop", "logged_in_customer_id", "token", "secret", "_", "t"]);

function cacheKey(resourceName, actionName, customerId, p) {
  const parts = Object.keys(p)
    .filter((k) => !KEY_SKIP.has(k) && k !== "action")
    .sort()
    .map((k) => `${k}=${typeof p[k] === "object" ? JSON.stringify(p[k]) : p[k]}`);
  return `${resourceName}/${actionName}|${customerId}|${parts.join("&")}`;
}

async function readParams(request) {
  const url = new URL(request.url);
  const p = Object.fromEntries(url.searchParams.entries());
  let body = {};
  if (request.method !== "GET" && request.method !== "HEAD") {
    // The pages post JSON as text/plain (no CORS preflight) or as a form.
    const type = request.headers.get("content-type") || "";
    if (type.includes("multipart/form-data") || type.includes("application/x-www-form-urlencoded")) {
      const form = await request.formData();
      for (const [k, v] of form.entries()) body[k] = v;
    } else {
      const text = await request.text();
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          throw new ApiError("bad json", 400);
        }
      }
    }
  }
  return { query: p, body };
}

export async function handleProxy(request, splat) {
  const started = Date.now();
  const [resourceName, ...rest] = String(splat || "").split("/").filter(Boolean);
  let actionName = "";
  try {
    const caller = await getCaller(request);
    const resource = resources[resourceName];
    if (!resource) return json({ ok: false, error: "unknown endpoint" }, 404);

    const { query, body } = await readParams(request);
    const p = { ...query, ...body };
    actionName = String(body.action || query.action || rest[0] || "");
    const handler = resource[actionName] || (!actionName ? resource.default : null);
    if (!handler) return json({ ok: false, error: "unknown action" });

    await connectDb();
    const run = async () => {
      const result = await handler({ p, query, body, caller, request, method: request.method });
      if (result instanceof Response) return result;
      const out = result ?? { ok: true };
      if (out && typeof out === "object" && !Array.isArray(out)) out.ms = Date.now() - started;
      return out;
    };

    // Repeat reads (reloads, tab switches, auto-refresh) come from memory.
    // fresh=1 (a Refresh button) always reads live
    if ((CACHEABLE[resourceName] || []).includes(actionName) && request.method === "GET" && p.fresh !== "1") {
      let response = null;
      const { body: cached, hit } = await cachedBody(cacheKey(resourceName, actionName, caller.customerId, p), async () => {
        const out = await run();
        if (out instanceof Response) { response = out; return null; }
        const text = JSON.stringify(out);
        // only good answers are kept - an error is retried next time
        return out && out.ok === false ? (response = json(text), null) : text;
      });
      if (response) return response;
      if (cached == null) { // shared a run that ended in an error - answer for this request itself
        const out = await run();
        return out instanceof Response ? out : json(out);
      }
      return json(cached, 200, { "X-Rx-Cache": hit ? "hit" : "miss" });
    }

    const out = await run();
    // a save / send / upload changed something - no cached answer may outlive it
    if (!READ_ONLY.has(actionName)) invalidateResponses();
    if (out instanceof Response) return out;
    return json(out);
  } catch (err) {
    if (err instanceof Response) return err; // App Proxy signature failure
    if (err instanceof ApiError) {
      return json({ ok: false, error: err.message }, err.status === 401 || err.status === 403 ? 200 : err.status);
    }
    logEvent("error", `${resourceName}/${actionName}`, String(err?.stack || err), null, false);
    return json({ ok: false, error: String(err?.message || err) });
  }
}
