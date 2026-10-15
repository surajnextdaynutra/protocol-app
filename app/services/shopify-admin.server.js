import mongoose, { connectDb } from "../db.server";
import { sessionStorage, unauthenticated } from "../shopify.server";

/* Thin helpers over the Shopify GraphQL Admin API for background work
   (webhooks, jobs, app-proxy requests) - anywhere there is no admin browser
   session. Uses the app's stored offline token. */

/**
 * RX_READ_ONLY=true: the app reads from Shopify but never writes to it and
 * never emails or texts anyone. For trying the app against the live store
 * while the Google scripts are still doing the real work. Everything the app
 * would have changed is still recorded in its own database.
 */
export const READ_ONLY = /^(1|true|yes|on)$/i.test(String(process.env.RX_READ_ONLY || ""));

let shopCache = null;

/** The one store this private app is installed on. */
export async function getShop() {
  if (shopCache) return shopCache;
  await connectDb();
  const sessions = mongoose.connection.db.collection("shopify_sessions");
  const installed = [
    ...new Set(
      (await sessions.find({ isOnline: { $ne: true } }, { projection: { shop: 1 } }).toArray()).map((r) => r.shop),
    ),
  ].filter(Boolean);
  if (!installed.length) throw new Error("App is not installed yet - open it once from Shopify admin.");

  // Never GUESS the store: with the app installed on more than one store,
  // picking "the first one" sent writes (customer deletes, product copies)
  // to the wrong store. SHOPIFY_SHOP must name it, and it must be installed.
  const wanted = String(process.env.SHOPIFY_SHOP || "").trim().toLowerCase();
  if (wanted) {
    if (!installed.includes(wanted)) {
      throw new Error(`SHOPIFY_SHOP is ${wanted}, but the app is only installed on ${installed.join(", ")}.`);
    }
    shopCache = wanted;
  } else if (installed.length === 1) {
    shopCache = installed[0];
  } else {
    throw new Error(
      `The app is installed on ${installed.join(" and ")} - set SHOPIFY_SHOP in .env to the store it should work on. Nothing is written to Shopify until then.`,
    );
  }
  console.log(`[rx] Shopify background work uses ${shopCache}`);
  return shopCache;
}

/* "fetch failed" / reset / timeout / Shopify 5xx: the request got no answer.
   Usually a short network drop on this machine, gone a second later. */
const NETWORK_ERR = /fetch failed|no response available|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|UND_ERR|other side closed|\b50[0-4]\b/i;
const NETWORK_RETRY_MS = [1000, 3000, 8000];

/* 401: Shopify no longer accepts the stored token - the app was uninstalled
   (and maybe reinstalled) while its uninstall webhook couldn't reach us, so
   the dead session was never removed. Opening the app in admin only fetches
   a new token when there is no usable session, so the dead one is deleted
   here; the next admin open reconnects and everything works again. */
const UNAUTHORIZED = /\b401\b|Unauthorized/i;
async function dropRejectedToken(shop) {
  try {
    const dead = await sessionStorage.findSessionsByShop(shop);
    if (dead.length) {
      await sessionStorage.deleteSessions(dead.map((s) => s.id));
      console.error(`[rx] Shopify rejected the stored access token for ${shop} (401) - removed it. Open the app once in Shopify admin to reconnect.`);
    }
  } catch (e) {
    console.warn("[rx] could not remove the rejected Shopify session:", e.message || e);
  }
  shopCache = null;
  return new Error(`Shopify rejected the app's access token for ${shop} (401 Unauthorized) - the app was probably reinstalled. Open the app once in Shopify admin to reconnect it.`);
}

/* A create can't be repeated blindly: if the first try reached Shopify and
   only the answer was lost, a retry makes a second product / customer.
   Those fail once and are retried by their own job (which finds the first
   copy). Updates, deletes, tag and stock writes are safe to repeat - stock
   writes carry the same idempotency key on every try. */
const notRepeatable = (query) => /\bmutation\b/.test(query) && /\b\w*(Create|Duplicate|Append)\w*\s*\(/.test(query);

/**
 * Runs one Admin GraphQL operation and returns `data`. Throws on transport
 * errors and top-level GraphQL errors; `userErrors` are the caller's to read.
 * Retries on throttling, and on a dropped connection (except creates).
 */
export async function gql(query, variables = {}, shop) {
  if (READ_ONLY && /\bmutation\s+\w+/.test(query)) {
    const name = (/\bmutation\s+(\w+)/.exec(query) || [])[1];
    throw new Error(`Read-only mode (RX_READ_ONLY): ${name} was not sent to Shopify.`);
  }
  shop = shop || (await getShop());
  const { admin } = await unauthenticated.admin(shop);
  const opName = (/\b(?:query|mutation)\s+(\w+)/.exec(query) || [])[1] || "graphql";
  let netTries = 0;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await admin.graphql(query, { variables });
    } catch (err) {
      const msg = String(err?.message || err) + " " + String(err?.cause?.code || err?.cause?.message || "");
      if (NETWORK_ERR.test(msg) && netTries < NETWORK_RETRY_MS.length && !notRepeatable(query)) {
        const wait = NETWORK_RETRY_MS[netTries++];
        console.warn(`[rx] Shopify ${opName}: no answer (${msg.trim().slice(0, 120)}) - retry ${netTries} in ${wait / 1000}s`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (UNAUTHORIZED.test(msg)) throw await dropRejectedToken(shop);
      if (netTries) err.message = `${err.message} (after ${netTries} retries)`;
      throw err;
    }
    const body = await res.json();
    const throttled = (body.errors || []).some(
      (e) => e?.extensions?.code === "THROTTLED",
    );
    if (throttled && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    if (body.errors?.length) {
      throw new Error("Shopify GraphQL: " + JSON.stringify(body.errors).slice(0, 500));
    }
    return body.data;
  }
}

/** Walks every page of a connection. `pick(data)` returns the connection. */
export async function gqlAll(query, variables, pick, { max = 5000 } = {}) {
  const out = [];
  let after = null;
  do {
    const data = await gql(query, { ...variables, after });
    const conn = pick(data);
    if (!conn) break;
    out.push(...(conn.nodes || []));
    after = conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after && out.length < max);
  return out;
}

export const gid = {
  order: (id) => toGid("Order", id),
  customer: (id) => toGid("Customer", id),
  product: (id) => toGid("Product", id),
  variant: (id) => toGid("ProductVariant", id),
};
function toGid(type, id) {
  const s = String(id || "");
  return s.startsWith("gid://") ? s : `gid://shopify/${type}/${s}`;
}
/** "gid://shopify/Order/123" -> "123" (plain ids pass through). */
export function legacyId(g) {
  const s = String(g || "");
  return s.includes("/") ? s.slice(s.lastIndexOf("/") + 1).split("?")[0] : s;
}

/** Strips characters that would break out of a quoted search term. */
export function escQ(s) {
  return String(s ?? "").replace(/['"\\]/g, "");
}

/* ------------------------------ tags ------------------------------------ */

export async function setOrderTags(orderId, tags) {
  const data = await gql(
    `#graphql
    mutation RxOrderTags($input: OrderInput!) {
      orderUpdate(input: $input) { order { id tags } userErrors { field message } }
    }`,
    { input: { id: gid.order(orderId), tags } },
  );
  const errs = data.orderUpdate?.userErrors || [];
  if (errs.length) throw new Error("orderUpdate: " + JSON.stringify(errs));
  return data.orderUpdate.order.tags;
}

export async function addOrderTags(orderId, tags) {
  const data = await gql(
    `#graphql
    mutation RxTagsAdd($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
    }`,
    { id: gid.order(orderId), tags },
  );
  return !(data.tagsAdd?.userErrors || []).length;
}

export async function getCustomerTags(customerId) {
  const data = await gql(
    `#graphql
    query RxCustomerTags($id: ID!) { customer(id: $id) { id tags } }`,
    { id: gid.customer(customerId) },
  );
  return data.customer ? data.customer.tags || [] : null;
}

export async function setCustomerTags(customerId, tags) {
  const data = await gql(
    `#graphql
    mutation RxCustomerTagsSet($input: CustomerInput!) {
      customerUpdate(input: $input) { customer { id tags } userErrors { field message } }
    }`,
    { input: { id: gid.customer(customerId), tags } },
  );
  const errs = data.customerUpdate?.userErrors || [];
  if (errs.length) throw new Error("customerUpdate: " + JSON.stringify(errs));
  return data.customerUpdate.customer.tags;
}

/* ---------------------------- customers --------------------------------- */

const CUSTOMER_FIELDS = `#graphql
  fragment RxCustomer on Customer {
    id legacyResourceId firstName lastName email phone tags state
    defaultAddress { phone company address1 address2 city province provinceCode zip country }
  }`;

/** Customers matching a search query, newest-updated first. */
export async function searchCustomers(queryStr, first = 50) {
  const data = await gql(
    `#graphql
    ${CUSTOMER_FIELDS}
    query RxCustomers($first: Int!, $query: String) {
      customers(first: $first, query: $query, sortKey: UPDATED_AT, reverse: true) {
        nodes { ...RxCustomer }
      }
    }`,
    { first: Math.min(250, first), query: queryStr || null },
  );
  return (data.customers?.nodes || []).map(shapeCustomer);
}

export function shapeCustomer(c) {
  const tags = c.tags || [];
  let patientId = "";
  for (const t of tags) {
    const s = String(t).trim();
    if (s.toLowerCase().startsWith("patient_id:")) patientId = s.slice(11).trim();
  }
  return {
    id: String(c.legacyResourceId || legacyId(c.id)),
    first: c.firstName || "",
    last: c.lastName || "",
    email: c.email || "",
    phone: c.phone || c.defaultAddress?.phone || "",
    patientId,
    tags,
    state: c.state || "",
    address: c.defaultAddress || null,
  };
}

/** One customer read live by id (normalised like searchCustomers), or null
 *  when Shopify has no such customer. Throws on a transport / API error. */
export async function getCustomer(customerId) {
  const data = await gql(
    `#graphql
    ${CUSTOMER_FIELDS}
    query RxCustomerById($id: ID!) { customer(id: $id) { ...RxCustomer } }`,
    { id: gid.customer(customerId) },
  );
  return data.customer ? shapeCustomer(data.customer) : null;
}

export async function findCustomerByEmail(email) {
  email = String(email || "").trim();
  if (!email) return null;
  const list = await searchCustomers("email:" + JSON.stringify(email), 10);
  return (
    list.find((c) => c.email.toLowerCase() === email.toLowerCase()) || null
  );
}

/** Creates a customer; a phone Shopify rejects is retried once without it. */
export async function createCustomer(input) {
  const run = (payload) =>
    gql(
      `#graphql
      mutation RxCustomerCreate($input: CustomerInput!) {
        customerCreate(input: $input) {
          customer { id legacyResourceId }
          userErrors { field message }
        }
      }`,
      { input: payload },
    );
  let data = await run(input);
  let errs = data.customerCreate?.userErrors || [];
  if (errs.length && input.phone && /phone/i.test(JSON.stringify(errs))) {
    const { phone, ...rest } = input;
    data = await run(rest);
    errs = data.customerCreate?.userErrors || [];
  }
  if (errs.length) throw new Error("customerCreate: " + JSON.stringify(errs));
  return String(data.customerCreate.customer.legacyResourceId);
}

/** Updates a customer; returns 'ok', 'ok (phone rejected)' or the reason. */
export async function updateCustomer(customerId, fields) {
  const run = (payload) =>
    gql(
      `#graphql
      mutation RxCustomerUpdate($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer { id }
          userErrors { field message }
        }
      }`,
      { input: { id: gid.customer(customerId), ...payload } },
    );
  try {
    let data = await run(fields);
    let errs = data.customerUpdate?.userErrors || [];
    if (!errs.length) return "ok";
    if (fields.phone && /phone/i.test(JSON.stringify(errs))) {
      const { phone, ...rest } = fields;
      data = await run(rest);
      errs = data.customerUpdate?.userErrors || [];
      if (!errs.length) return "ok (phone rejected)";
    }
    return "failed " + JSON.stringify(errs).slice(0, 200);
  } catch (err) {
    return "error " + err;
  }
}

/* ---------------------------- metafields -------------------------------- */

export async function metafieldsSet(metafields) {
  const data = await gql(
    `#graphql
    mutation RxMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
    }`,
    { metafields },
  );
  return data.metafieldsSet?.userErrors || [];
}

/** A metafield { value, type } -> number. Handles a money JSON value, a plain
 *  number, or text that merely looks like money ("$10.00 USD"). */
export function mfNum(mf) {
  if (!mf || mf.value == null || mf.value === "") return 0;
  if (mf.type === "money") {
    try {
      return Number(JSON.parse(mf.value).amount) || 0;
    } catch {
      return 0;
    }
  }
  return Number(String(mf.value).replace(/[^0-9.]/g, "")) || 0;
}
