import { connectDb } from "../db.server";
import {
  Account,
  MonthlyPayout,
  Order,
  Product,
  SalesRep,
} from "../models/index.server";
import { isDemoIds, monthKey } from "./ids.server";
import { logEvent } from "./log.server";
import { getSettings } from "./settings.server";
import { escQ, gid, gql, legacyId, metafieldsSet, mfNum } from "./shopify-admin.server";
import { invalidateResponses } from "./response-cache.server";

/* Per-order commission ledger + month-wise payout summary (was Payouts.gs).

   An order's Doctor / Clinic / Practice / Rep split is computed ONCE, the
   moment it is paid, and frozen on the order document (`commission`, plus the
   per-line amounts). Product rates edited later never rewrite history.

   PAYOUT CONSOLIDATION: the admin only ever pays the PRACTICE (one combined
   Doctor + Clinic + Practice amount) or the REP (flat $/unit, always
   separate). A standalone "Doctor" payout row exists only for the true solo
   case, where Clinic and Practice both come out to $0. */

const EMPTY_SPLIT = {
  doctorId: "",
  clinicId: "",
  practiceId: "",
  doctorAmt: 0,
  clinicAmt: 0,
  practiceAmt: 0,
  repId: "",
  repAmt: 0,
  solo: false,
  lines: [],
};

/** Dollars of rep commission per product unit (default $1). */
export async function repCommissionPerUnit() {
  const v = Number((await getSettings()).COMMISSION_PER_UNIT);
  return v > 0 ? v : 1;
}

/**
 * The rep assigned to this order's practice (or, for a practice-less order,
 * its clinic). Assignment lives on the SalesRep record, never in a rep_id:
 * tag. Falls back to the wholesale ids so a wholesale-page order still finds
 * its rep. Demo accounts never pay a rep.
 */
export async function repForOrder(ids) {
  if (!ids) return null;
  if (await isDemoIds(ids)) return null;
  const candidates = [
    ids.practiceId,
    ids.clinicId,
    ids.wsPracticeId,
    ids.wsClinicId,
  ].filter(Boolean);
  if (!candidates.length) return null;
  await connectDb();
  const reps = await SalesRep.find(
    { assignedPracticeIds: { $in: candidates }, active: { $ne: false } },
    { repId: 1, name: 1, assignedPracticeIds: 1 },
  ).lean();
  for (const c of candidates) {
    const rep = reps.find((r) => r.assignedPracticeIds.includes(c));
    if (rep) return { id: rep.repId, name: rep.name || rep.repId };
  }
  return null;
}

/**
 * True when the practice has at most one distinct physician. A solo doctor
 * never gets Product Management, so no per-product physician commission is
 * ever set for them - they keep the full margin instead.
 */
export async function isSoloPractice(practiceId) {
  if (!practiceId) return false;
  await connectDb();
  const known = await Account.countDocuments({ practiceId, wholesale: true });
  if (known > 0) {
    const doctorIds = await Account.distinct("doctorId", {
      practiceId,
      wholesale: true,
      doctorId: { $ne: "" },
    });
    return doctorIds.length <= 1;
  }
  // Accounts not synced yet - ask Shopify directly.
  try {
    const data = await gql(
      `#graphql
      query RxSoloPractice($q: String!) {
        customers(first: 100, query: $q) { nodes { tags } }
      }`,
      { q: `tag:'wholesale' AND tag:'practice_id:${escQ(practiceId)}'` },
    );
    const ids = new Set();
    for (const c of data.customers?.nodes || []) {
      for (const t of c.tags || []) {
        if (String(t).toLowerCase().startsWith("doctor_id:")) {
          ids.add(String(t).slice(10).trim());
        }
      }
    }
    return ids.size <= 1;
  } catch {
    return false;
  }
}

/** { productId: {wholesale, physician, clinic} } - local catalogue first,
 *  Shopify for anything not synced yet. Note the metafield key really is
 *  spelled "wholsale_price" in the store. */
export async function commissionRates(productIds) {
  const map = {};
  const ids = [...new Set(productIds.map(String).filter(Boolean))];
  if (!ids.length) return map;
  await connectDb();
  const local = await Product.find(
    { productId: { $in: ids } },
    { productId: 1, wholesale: 1, physicianCommission: 1, clinicCommission: 1 },
  ).lean();
  for (const p of local) {
    map[p.productId] = {
      wholesale: p.wholesale || 0,
      physician: p.physicianCommission || 0,
      clinic: p.clinicCommission || 0,
    };
  }
  const missing = ids.filter((id) => !map[id]);
  if (missing.length) {
    try {
      const data = await gql(
        `#graphql
        query RxCommissionRates($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
              id
              wholesaleMf: metafield(namespace: "custom", key: "wholsale_price") { value type }
              physicianMf: metafield(namespace: "custom", key: "physician_commission") { value type }
              clinicMf: metafield(namespace: "custom", key: "clinic_commission") { value type }
            }
          }
        }`,
        { ids: missing.map(gid.product) },
      );
      for (const n of data.nodes || []) {
        if (!n?.id) continue;
        map[legacyId(n.id)] = {
          wholesale: mfNum(n.wholesaleMf),
          physician: mfNum(n.physicianMf),
          clinic: mfNum(n.clinicMf),
        };
      }
    } catch (err) {
      logEvent("error", "commissionRates", String(err), null, false);
    }
  }
  return map;
}

/**
 * The Doctor / Clinic / Practice $ split for one order, line by line:
 *   lineProfit = max(0, (sell - wholesale) * qty)
 *   Doctor / Clinic = their fixed $/unit product rate * qty
 *   Practice = whatever is left of lineProfit (never negative)
 * SOLO doctor: the doctor gets the full lineProfit.
 * Rep $ is a separate flat rate * total units.
 *
 * `lineItems` are the order document's line items ({productId, quantity,
 * price, title}). Returns the resolved ids the split is credited to
 * (wholesale ids fill in when the plain ones are blank).
 */
export async function computeOrderCommission(lineItems, ids) {
  if (!lineItems?.length) return { ...EMPTY_SPLIT };

  const doctorId = ids.doctorId || ids.wsDoctorId || "";
  const clinicId = ids.clinicId || ids.wsClinicId || "";
  const practiceId = ids.practiceId || ids.wsPracticeId || "";

  const rates = await commissionRates(lineItems.map((li) => li.productId));
  const solo =
    !clinicId && !!doctorId && !!practiceId && (await isSoloPractice(practiceId));

  let doctorAmt = 0;
  let clinicAmt = 0;
  let practiceAmt = 0;
  let units = 0;
  const lines = lineItems.map((li) => {
    const qty = li.quantity || 1;
    units += qty;
    const sell = Number(li.price) || 0;
    const mf = rates[String(li.productId)] || { wholesale: 0, physician: 0, clinic: 0 };
    const lineProfit = Math.max(0, (sell - mf.wholesale) * qty);

    let d, c, p;
    if (solo) {
      d = lineProfit;
      c = 0;
      p = 0;
    } else {
      d = (mf.physician || 0) * qty;
      c = (mf.clinic || 0) * qty;
      p = Math.max(0, lineProfit - d - c);
    }
    doctorAmt += d;
    clinicAmt += c;
    practiceAmt += p;
    return {
      title: li.title || "",
      qty,
      doctorAmt: d,
      clinicAmt: c,
      practiceAmt: p,
      // Effective per-unit rate (amount / qty) so rate * qty is right in the
      // solo case too, where there is no product rate at all.
      physicianRate: d / qty,
      clinicRate: c / qty,
      wholesale: mf.wholesale || 0,
    };
  });

  const rep = await repForOrder(ids);
  const repAmt = rep ? units * (await repCommissionPerUnit()) : 0;

  return {
    doctorId,
    clinicId,
    practiceId,
    doctorAmt: round2(doctorAmt),
    clinicAmt: round2(clinicAmt),
    practiceAmt: round2(practiceAmt),
    repId: rep ? rep.id : "",
    repAmt: round2(repAmt),
    solo,
    lines,
  };
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* ------------------------- monthly payout summary ----------------------- */

/** Adds (or, with a negative delta, subtracts) on top of what is already
 *  logged for (month, role, id). Never touches Status / Date Paid /
 *  Transaction # - those are the finance admin's. A decrement never creates
 *  a row. */
export async function adjustMonthlyPayout(month, role, entityId, delta) {
  if (!delta || !entityId) return;
  await connectDb();
  if (delta > 0) {
    await MonthlyPayout.updateOne(
      { month, role, entityId },
      { $inc: { amount: round2(delta) }, $setOnInsert: { status: "Pending" } },
      { upsert: true },
    );
  } else {
    const res = await MonthlyPayout.updateOne(
      { month, role, entityId },
      { $inc: { amount: round2(delta) } },
    );
    if (!res.matchedCount) {
      logEvent("job", `${month}/${role}/${entityId}`, "payout decrement: no matching row");
    }
  }
}

/** Applies one split to the payout summary. `sign` -1 reverses it. */
async function applySplitToPayouts(month, c, sign) {
  const shared = (c.clinicAmt || 0) + (c.practiceAmt || 0);
  if (shared > 0) {
    if (c.practiceId) {
      await adjustMonthlyPayout(
        month,
        "Practice",
        c.practiceId,
        sign * ((c.doctorAmt || 0) + (c.clinicAmt || 0) + (c.practiceAmt || 0)),
      );
    } else {
      logEvent("job", month, "shared Clinic/Practice split but no practiceId - payout not recorded");
    }
  } else if (c.doctorId && c.doctorAmt > 0) {
    await adjustMonthlyPayout(month, "Doctor", c.doctorId, sign * c.doctorAmt);
  }
  if (c.repId && c.repAmt > 0) {
    await adjustMonthlyPayout(month, "Rep", c.repId, sign * c.repAmt);
  }
}

/**
 * Logs one paid order's split, if (and only if) it has not been logged yet.
 * Idempotent across webhook re-deliveries and the safety-net sync: the
 * `commission.logged` flag is claimed atomically before anything is counted.
 * Never throws.
 */
export async function recordOrderPayoutIfNew(order, ids) {
  try {
    if (!order?.orderId) return false;
    if (
      !ids ||
      (!ids.doctorId &&
        !ids.clinicId &&
        !ids.practiceId &&
        !ids.wsDoctorId &&
        !ids.wsClinicId &&
        !ids.wsPracticeId)
    ) {
      return false; // not attributable to anyone
    }
    await connectDb();
    const fresh = await Order.findOne({ orderId: order.orderId }).lean();
    if (!fresh || fresh.commission?.logged) return false;

    const split = await computeOrderCommission(fresh.lineItems, ids);
    if (!split.doctorAmt && !split.clinicAmt && !split.practiceAmt && !split.repAmt) {
      return false;
    }

    const cfg = await getSettings();
    const month = monthKey(fresh.orderCreatedAt || new Date(), cfg.TIMEZONE);
    const lineItems = fresh.lineItems.map((li, i) => ({
      ...li,
      doctorAmt: split.lines[i]?.doctorAmt || 0,
      clinicAmt: split.lines[i]?.clinicAmt || 0,
      practiceAmt: split.lines[i]?.practiceAmt || 0,
      physicianRate: split.lines[i]?.physicianRate || 0,
      clinicRate: split.lines[i]?.clinicRate || 0,
      wholesale: split.lines[i]?.wholesale || 0,
    }));

    // Claim the "logged" flag atomically - only the winner counts the split.
    const claimed = await Order.updateOne(
      { orderId: order.orderId, "commission.logged": { $ne: true } },
      {
        $set: {
          lineItems,
          repId: split.repId,
          commission: {
            logged: true,
            loggedAt: new Date(),
            doctorId: split.doctorId,
            clinicId: split.clinicId,
            practiceId: split.practiceId,
            doctorAmt: split.doctorAmt,
            clinicAmt: split.clinicAmt,
            practiceAmt: split.practiceAmt,
            repId: split.repId,
            repAmt: split.repAmt,
            solo: split.solo,
            counted: "Yes",
            month,
            status: "Active",
          },
        },
      },
    );
    if (!claimed.modifiedCount) return false;

    await applySplitToPayouts(month, split, 1);
    // Same split stamped onto the Shopify order as list metafields, so it is
    // visible in Shopify admin as before. Best-effort.
    setOrderCommissionMetafields(order.orderId, split).catch(() => {});
    return true;
  } catch (err) {
    logEvent("error", order?.name || order?.orderId, "recordOrderPayoutIfNew: " + err, null, false);
    return false;
  }
}

/**
 * A previously-logged order was DELETED in Shopify: mark it Deleted and take
 * its exact split back out of the payout summary. The order document is kept
 * as the audit trail. Returns true when a logged order was found (already
 * reversed counts - repeat deliveries are a safe no-op).
 */
export async function reverseOrderCommission(orderId, orderName) {
  try {
    await connectDb();
    const q = orderId ? { orderId: String(orderId) } : { name: String(orderName || "") };
    const order = await Order.findOne(q).lean();
    if (!order) return false;
    const c = order.commission || {};
    const claimed = await Order.updateOne(
      { _id: order._id, "commission.status": { $ne: "Deleted" } },
      {
        $set: {
          deletedAt: new Date(),
          "commission.status": "Deleted",
          "commission.counted": c.counted === "Yes" ? "Reversed" : c.counted || "No",
        },
      },
    );
    if (!claimed.modifiedCount) return !!c.logged;
    if (c.logged && c.counted === "Yes") {
      await applySplitToPayouts(c.month, c, -1);
    }
    logEvent("job", order.name, "order deleted - commission reversed");
    return !!c.logged;
  } catch (err) {
    logEvent("error", orderId, "reverseOrderCommission: " + err, null, false);
    return false;
  }
}

/**
 * Rebuilds the Monthly Payout Summary amounts FROM SCRATCH off the orders'
 * logged commission - the ledger's real source of truth (was Payouts.gs
 * recalculateMonthlyPayoutSummary). The summary is otherwise only ever
 * incremented / decremented per order, so after backfills, re-syncs or a
 * formula change the two can drift; this makes every amount match the
 * orders again, bucketed exactly like applySplitToPayouts.
 *
 * Only `amount` changes. Status, Date Paid and Transaction # are finance's
 * own bookkeeping and are never touched. A row that now totals nothing (all
 * its orders reversed) is kept at 0, never deleted - a Paid record must not
 * vanish. `dryRun` reports the differences without writing.
 */
export async function rebuildMonthlyPayouts({ dryRun = true } = {}) {
  if (!dryRun) invalidateResponses();
  await connectDb();
  const totals = new Map(); // "month|role|id" -> amount
  const add = (month, role, id, amt) => {
    if (!month || !id || !amt) return;
    const k = `${month}|${role}|${id}`;
    totals.set(k, (totals.get(k) || 0) + amt);
  };
  const orders = await Order.find(
    { "commission.logged": true, "commission.counted": "Yes", "commission.status": { $ne: "Deleted" } },
    { commission: 1 },
  ).lean();
  for (const { commission: c } of orders) {
    const shared = (c.clinicAmt || 0) + (c.practiceAmt || 0);
    if (shared > 0) {
      if (c.practiceId) add(c.month, "Practice", c.practiceId, (c.doctorAmt || 0) + shared);
    } else if (c.doctorId && c.doctorAmt > 0) {
      add(c.month, "Doctor", c.doctorId, c.doctorAmt);
    }
    if (c.repId && c.repAmt > 0) add(c.month, "Rep", c.repId, c.repAmt);
  }

  const existing = await MonthlyPayout.find({}, { month: 1, role: 1, entityId: 1, amount: 1, status: 1 }).lean();
  const changes = [];
  const seen = new Set();
  for (const row of existing) {
    const k = `${row.month}|${row.role}|${row.entityId}`;
    seen.add(k);
    const want = round2(totals.get(k) || 0);
    if (Math.abs(want - round2(row.amount || 0)) > 0.004) {
      changes.push({ month: row.month, role: row.role, entityId: row.entityId, from: round2(row.amount || 0), to: want, status: row.status });
    }
  }
  for (const [k, amt] of totals) {
    if (seen.has(k)) continue;
    const [month, role, entityId] = k.split("|");
    changes.push({ month, role, entityId, from: null, to: round2(amt), status: "Pending" });
  }

  if (!dryRun) {
    for (const ch of changes) {
      await MonthlyPayout.updateOne(
        { month: ch.month, role: ch.role, entityId: ch.entityId },
        { $set: { amount: ch.to }, $setOnInsert: { status: "Pending" } },
        { upsert: true },
      );
    }
    logEvent("job", "payout-rebuild", `rebuilt from ${orders.length} orders - ${changes.length} row(s) corrected`);
  }
  return {
    dryRun,
    orders: orders.length,
    rows: existing.length,
    changed: changes.filter((c) => c.from !== null).length,
    created: changes.filter((c) => c.from === null).length,
    changes: changes.sort((a, b) => b.month.localeCompare(a.month)).slice(0, 50),
  };
}

/**
 * Recomputes ONE logged order's split at today's product rates. Admin-only,
 * run by hand; moves the payout summary by the difference so the two stay in
 * step.
 */
export async function resyncOrderCommission(orderId) {
  await connectDb();
  const order = await Order.findOne({ orderId: String(orderId) }).lean();
  if (!order || order.commission?.status === "Deleted") return null;
  const ids = {
    doctorId: order.doctorId,
    clinicId: order.clinicId,
    practiceId: order.practiceId,
    wsDoctorId: order.wsDoctorId,
    wsClinicId: order.wsClinicId,
    wsPracticeId: order.wsPracticeId,
  };
  const old = order.commission || {};
  if (old.logged && old.counted === "Yes") await applySplitToPayouts(old.month, old, -1);
  await Order.updateOne(
    { _id: order._id },
    { $set: { "commission.logged": false } },
  );
  await recordOrderPayoutIfNew(order, ids);
  return (await Order.findOne({ _id: order._id }).lean()).commission;
}

/**
 * Writes the per-line breakdown onto the Shopify order as three list
 * metafields (custom.physician_commission / clinic_commission /
 * practice_commission) - one entry per line item, same order as the order's
 * own line items.
 */
export async function setOrderCommissionMetafields(orderId, split) {
  if (!orderId || !split?.lines?.length) return;
  const fmt = (amt) => "$" + Number(amt || 0).toFixed(2);
  const ownerId = gid.order(orderId);
  const list = (key, values) => ({
    ownerId,
    namespace: "custom",
    key,
    type: "list.single_line_text_field",
    value: JSON.stringify(values),
  });
  const errs = await metafieldsSet([
    list("physician_commission", split.lines.map((l) => `${l.title}: ${fmt(l.physicianRate)}`)),
    list("clinic_commission", split.lines.map((l) => `${l.title}: ${fmt(l.clinicRate)}`)),
    list("practice_commission", split.lines.map((l) => `${l.title} ×${l.qty}: ${fmt(l.practiceAmt)}`)),
  ]);
  if (errs.length) {
    logEvent("error", orderId, "order commission metafields: " + JSON.stringify(errs).slice(0, 300), null, false);
  }
}
