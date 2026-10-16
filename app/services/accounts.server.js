import { connectDb } from "../db.server";
import { Account, SalesRep } from "../models/index.server";
import { forgetCustomer } from "./caller.server";
import { hasTag, idsFromCustomerTags, tagList } from "./ids.server";
import { logEvent } from "./log.server";
import { getCustomer, gqlAll, legacyId } from "./shopify-admin.server";
import { invalidateResponses } from "./response-cache.server";

/* The `accounts` collection: one document per portal user (practice master,
   clinic, physician, sales rep), mirrored from the role tags on the Shopify
   customer. Patients are not stored here. */

/** Role from the tag shape - the same rules the theme uses to pick a
 *  dashboard. doctor_id wins; a clinic account has clinic_id and no
 *  doctor_id; a Practice Master has practice_id alone. */
export function roleFromTags(tags) {
  const ids = idsFromCustomerTags(tags);
  if (ids.finance) return "Finance Admin";
  if (ids.repId || hasTag(tags, "wholesale_rep")) return "Sales Rep";
  if (ids.doctorId) return "Physician";
  if (ids.clinicId) return "Clinic";
  if (ids.practiceId) return "Practice";
  return "";
}

const isPortalUser = (tags) => {
  const ids = idsFromCustomerTags(tags);
  if (ids.patient && !ids.wholesale && !ids.repId) return false;
  return ids.wholesale || !!ids.repId || hasTag(tags, "wholesale_rep") || ids.finance;
};

/** Normalised customer ({id, first, last, email, phone, tags, state,
 *  address}) -> upsert / remove its account document. */
export async function upsertAccount(c) {
  invalidateResponses();
  await connectDb();
  const customerId = String(c.id);
  forgetCustomer(customerId);
  const tags = tagList(c.tags);
  if (!isPortalUser(tags)) {
    await Account.deleteOne({ customerId });
    return null;
  }
  const ids = idsFromCustomerTags(tags);
  const address = c.address || null;
  const doc = {
    role: roleFromTags(tags),
    first: c.first || "",
    last: c.last || "",
    email: String(c.email || "").toLowerCase(),
    phone: c.phone || "",
    company: address?.company || "",
    doctorId: ids.doctorId,
    clinicId: ids.clinicId,
    clinicIds: ids.clinicIds,
    practiceId: ids.practiceId,
    repId: ids.repId,
    wholesale: ids.wholesale,
    demo: ids.demo,
    tags,
    address,
    state: c.state || "",
  };
  const existing = await Account.findOne(
    { customerId },
    { email: 1, role: 1, provisionedAt: 1, first: 1, last: 1 },
  ).lean();
  // An account created from the Accounts page keeps the role it was created
  // with ("Practice + Doctor", "Master Clinic", ...).
  if (existing?.provisionedAt && existing.role) doc.role = existing.role;
  await Account.updateOne({ customerId }, { $set: doc }, { upsert: true });

  // Any portal account with a practice_id (the Practice itself, or a clinic /
  // physician under it) gives that practice its product copies - straight
  // away, however it was added (Accounts page, Shopify admin, the old
  // scripts, a re-sync). A practice that already has copies is skipped, so
  // this is cheap on every update.
  if (ids.practiceId && ids.wholesale) {
    import("./catalog.server.js")
      .then((m) => m.ensurePracticeCopies(ids.practiceId))
      .catch((err) => logEvent("error", "product-sync", `practice ${ids.practiceId} copies: ${err}`, null, false));
  }

  // The user changed their own email in Shopify: send the welcome email to
  // the new address (it is de-duplicated per address).
  if (existing?.provisionedAt && existing.email && doc.email && existing.email !== doc.email) {
    import("./provisioning.server.js")
      .then((m) => m.sendWelcomeEmail({ firstName: doc.first, lastName: doc.last, email: doc.email, role: doc.role }))
      .then((result) => logEvent("email", doc.email, "welcome re-send after email change: " + result))
      .catch(() => {});
  }
  return doc;
}

/** customers/create + customers/update webhook payload (REST shape). */
export function customerFromWebhook(p) {
  const a = p.default_address || null;
  return {
    id: p.id,
    first: p.first_name,
    last: p.last_name,
    email: p.email,
    phone: p.phone || a?.phone || "",
    tags: p.tags,
    state: String(p.state || "").toUpperCase(),
    address: a && {
      company: a.company || "",
      address1: a.address1 || "",
      address2: a.address2 || "",
      city: a.city || "",
      province: a.province || "",
      provinceCode: a.province_code || "",
      zip: a.zip || "",
      country: a.country || "",
      phone: a.phone || "",
    },
  };
}

/**
 * customers/create + customers/update webhooks. The customer is re-read
 * LIVE from Shopify rather than trusted from the payload: newer webhook
 * payloads can arrive without tags (or with protected fields left out), and
 * a tag-less payload used to make upsertAccount treat a brand-new physician
 * as "not a portal user" and delete their account moments after it was
 * created. If Shopify can't be reached, the payload is only used when it
 * actually carries tags - an account is never removed on missing data.
 */
export async function refreshAccountFromWebhook(payload) {
  const id = String(payload?.id || "").trim();
  if (!id) return null;
  let live = null;
  try {
    live = await getCustomer(id);
  } catch (err) {
    logEvent("error", id, "customer webhook: live read failed - " + err, null, false);
  }
  if (live) return upsertAccount(live);
  const fromHook = customerFromWebhook(payload);
  if (tagList(fromHook.tags).length) return upsertAccount(fromHook);
  logEvent("job", id, "customer webhook without tags and no live read - account left as it is");
  return null;
}

/**
 * Drops a deleted customer's account. When that leaves its practice with no
 * portal account at all, the practice's product copies are deleted straight away
 * (`cleanupProducts: false` = the caller does that itself and waits for it).
 * Returns the removed account, or null.
 */
export async function removeAccount(customerId, { cleanupProducts = true } = {}) {
  invalidateResponses();
  await connectDb();
  forgetCustomer(String(customerId));
  const acct = await Account.findOneAndDelete({ customerId: String(customerId) }).lean();
  if (cleanupProducts && acct?.practiceId) {
    import("./catalog.server.js")
      .then((m) => m.removePracticeCopiesIfUnused(acct.practiceId, { except: String(customerId) }))
      .catch((err) => logEvent("error", "product-delete", `practice ${acct.practiceId}: ${err}`, null, false));
  }
  // A deleted sales rep must also leave the "Sales Reps" list (and the
  // Accounts page's rep dropdown) - its rep record used to stay behind.
  const gone = await SalesRep.deleteMany({
    $or: [{ customerId: String(customerId) }, ...(acct?.repId ? [{ repId: acct.repId }] : [])],
  });
  if (gone.deletedCount) {
    logEvent("sync", acct?.email || String(customerId), `sales rep ${acct?.repId || ""} removed (customer deleted)`.replace("  ", " "));
  }
  return acct;
}

/**
 * Full re-read of every portal customer from Shopify. Accounts whose
 * customer is gone (or lost its portal tags) are removed.
 */
export async function syncAllAccounts() {
  await connectDb();
  const nodes = await gqlAll(
    `#graphql
    query RxAccountsAll($after: String, $query: String!) {
      customers(first: 100, after: $after, query: $query) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id legacyResourceId firstName lastName email phone tags state
          defaultAddress { company address1 address2 city province provinceCode zip country phone }
        }
      }
    }`,
    { query: "tag:'wholesale' OR tag:'wholesale_rep' OR tag:'finance_admin'" },
    (d) => d.customers,
    { max: 50000 },
  );
  const seen = [];
  for (const c of nodes) {
    const id = String(c.legacyResourceId || legacyId(c.id));
    const doc = await upsertAccount({
      id,
      first: c.firstName,
      last: c.lastName,
      email: c.email,
      phone: c.phone || c.defaultAddress?.phone || "",
      tags: c.tags,
      state: c.state,
      address: c.defaultAddress,
    });
    if (doc) seen.push(id);
  }

  // Shopify's customer SEARCH lags a few seconds behind writes, so a customer
  // missing from it is only a suspect: each one is read LIVE by id and only
  // removed when Shopify confirms it is gone (or no longer a portal user).
  // Without this, syncing on every page open deleted brand-new accounts.
  let removed = 0;
  let confirmedLive = 0;
  const gone = [];
  const suspects = await Account.find({ customerId: { $nin: seen } }, { customerId: 1 }).lean();
  for (const s of suspects) {
    let live;
    try {
      live = await getCustomer(s.customerId);
    } catch (err) {
      logEvent("job", "account-sync", `could not confirm ${s.customerId} - kept (${err.message || err})`, null, false);
      continue; // can't confirm -> keep; under-deleting is the safe side
    }
    if (live && (await upsertAccount(live))) {
      confirmedLive++; // still there, the search just hadn't caught up
      continue;
    }
    await removeAccount(s.customerId); // also drops its sales rep record
    gone.push(s.customerId);
    removed++;
  }
  // Sales reps whose Shopify customer is gone (deleted while a webhook was
  // missed): same live confirmation. Reps with no customer id (imported from
  // the old sheet) stay.
  let repsRemoved = 0;
  const repSuspects = await SalesRep.find(
    { customerId: { $nin: ["", null, ...seen, ...gone] } },
    { customerId: 1, repId: 1 },
  ).lean();
  for (const r of repSuspects) {
    let live;
    try {
      live = await getCustomer(r.customerId);
    } catch {
      continue;
    }
    if (live) continue;
    await SalesRep.deleteOne({ _id: r._id });
    repsRemoved++;
    logEvent("sync", r.repId, "sales rep removed (customer no longer in Shopify)");
  }
  logEvent("job", "account-sync",
    `accounts=${seen.length + confirmedLive} removed=${removed} keptAfterLiveCheck=${confirmedLive} salesRepsRemoved=${repsRemoved}`);
  return { synced: seen.length + confirmedLive, removed, repsRemoved };
}
