import { connectDb } from "../../db.server";
import { MonthlyPayout, Order, Payout } from "../../models/index.server";
import { payoutSplit } from "../commission.server";
import { monthKey, parseAmount } from "../ids.server";
import { getSettings } from "../settings.server";

/* Shared by every dashboard: the order shape the dashboard pages already
   understand (it is what the old Apps Script returned), built from the local
   `orders` collection instead of a paged Shopify search. */

export const csvToArr = (s) =>
  String(s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

// Raw Shopify fulfillment display status -> the label shown in the UI. The
// Status filter options on the pages hold exactly these labels.
const DELIVERY_STATUS_LABEL = {
  DELIVERED: "Delivered",
  OUT_FOR_DELIVERY: "Out For Delivery",
  IN_TRANSIT: "In Transit",
  ATTEMPTED_DELIVERY: "Attempted Delivery",
  NOT_DELIVERED: "Not Delivered",
  PICKED_UP: "Picked Up",
  READY_FOR_PICKUP: "Ready For Pickup",
  LABEL_PRINTED: "Label Printed",
  LABEL_PURCHASED: "Label Purchased",
  CONFIRMED: "Confirmed",
  SUBMITTED: "Submitted",
  AWAITING_SHIPMENT: "Awaiting Shipment",
  FAILURE: "Delivery Failed",
  UNFULFILLED: "Unfulfilled",
};

export function deliveryStatusLabel(raw) {
  if (!raw) return "";
  const key = String(raw).toUpperCase();
  return (
    DELIVERY_STATUS_LABEL[key] ||
    (key.charAt(0) + key.slice(1).toLowerCase()).replace(/_/g, " ")
  );
}

/** The status text a purchased order shows everywhere: its delivery status
 *  when known, else the flat 'Purchased'. */
export function orderDisplayStatus(o) {
  return o.deliveryStatus ? deliveryStatusLabel(o.deliveryStatus) : "Purchased";
}

export const isDelivered = (deliveryStatus) =>
  String(deliveryStatus || "").toUpperCase() === "DELIVERED";

// The coarse open-prescription vocabulary - a purchased order never has one.
export const OPEN_ONLY_STATUSES = new Set([
  "Created",
  "Sent",
  "Opened",
  "Checkout Started",
  "Abandoned",
  "Expired",
]);

/** A guest / direct-checkout patient id ('ANON-…') - a real sale, never a
 *  written protocol. */
export const isAnonPatient = (patientId) =>
  /^\s*ANON[-_]/i.test(String(patientId || ""));

/**
 * Parses the builder's Items text, e.g.
 *   "Collagen Gummies ×2 (Monthly); Lean Guard (One time)"
 * -> { products: [{name, qty, plan}], subscription }
 */
export function parseItems(s) {
  const out = { products: [], subscription: false };
  for (let seg of String(s || "").split(";")) {
    seg = seg.trim();
    if (!seg) continue;
    seg = seg.replace(/\s*[-–—]\s*Physician Note:.*$/i, "").trim();

    let plan = "";
    const pm = seg.match(/\(([^()]*)\)\s*$/);
    if (pm) {
      plan = pm[1].trim();
      seg = seg.slice(0, pm.index).trim();
    }
    let qty = 1;
    const qm = seg.match(/×\s*(\d+)\s*$/);
    if (qm) {
      qty = Number(qm[1]) || 1;
      seg = seg.slice(0, qm.index).trim();
    }
    out.products.push({ name: seg || plan, qty, plan });
    if (plan && !/^one[\s-]?time$/i.test(plan)) out.subscription = true;
  }
  return out;
}

/** Stored fulfillment status -> Shopify's display vocabulary. Webhooks send
 *  null / "partial" where GraphQL says UNFULFILLED / PARTIALLY_FULFILLED. */
function fulfillmentStatusLabel(raw) {
  const s = String(raw || "").toUpperCase();
  if (!s || s === "NULL") return "UNFULFILLED";
  if (s === "PARTIAL") return "PARTIALLY_FULFILLED";
  return s;
}

const sumOrNull = (items, key) => {
  let any = false;
  let total = 0;
  for (const it of items) {
    if (it[key] != null) {
      any = true;
      total += it[key];
    }
  }
  return any ? total : null;
};

/**
 * One order document -> the dashboard order shape. Commission figures come
 * from the split frozen on the order when it was paid; an order whose split
 * was never logged reports null (rendered as "-"), not a misleading $0.
 */
export function orderView(o) {
  const logged = !!o.commission?.logged;
  const items = (o.lineItems || []).map((li) => {
    const qty = li.quantity || 1;
    const price = li.price || 0;
    return {
      title: li.title || "",
      qty,
      price,
      wholesale: li.wholesale || 0,
      profit: Math.max(0, (price - (li.wholesale || 0)) * qty),
      physCommission: logged ? li.doctorAmt || 0 : null,
      physicianCommission: logged ? li.doctorAmt || 0 : null,
      clinicCommission: logged ? li.clinicAmt || 0 : null,
      practiceCommission: logged ? li.practiceAmt || 0 : null,
      plan: li.sellingPlan || "",
      productId: li.productId || "",
      variantId: li.variantId || "",
    };
  });
  const planLine = items.find((it) => it.plan);
  const custName = [o.customer?.first, o.customer?.last].filter(Boolean).join(" ");
  return {
    id: o.orderId,
    name: o.name,
    ts: o.orderCreatedAt ? o.orderCreatedAt.getTime() : 0,
    amount: o.total || 0,
    patient: custName,
    email: o.customer?.email || o.email || "",
    customerId: o.customer?.id || "",
    items,
    qty: items.reduce((s, it) => s + it.qty, 0),
    qtyRevenue: items.reduce((s, it) => s + it.price * it.qty, 0),
    commission: items.reduce((s, it) => s + it.profit, 0),
    physicianCommission: sumOrNull(items, "physCommission"),
    clinicCommission: sumOrNull(items, "clinicCommission"),
    practiceCommission: sumOrNull(items, "practiceCommission"),
    deliveryStatus: o.fulfillmentDisplay || "",
    financialStatus: String(o.financialStatus || "").toUpperCase(),
    fulfillmentStatus: fulfillmentStatusLabel(o.fulfillmentStatus),
    trackingUrl: o.trackingUrl || "",
    trackingCompany: o.trackingCompany || "",
    estimatedDeliveryAt: o.estimatedDeliveryAt ? o.estimatedDeliveryAt.getTime() : 0,
    subtotal: o.subtotal || 0,
    phone: o.customer?.phone || o.phone || "",
    // only a real selling-plan line marks an order recurring
    subscription: !!planLine,
    subscriptionPlanName: planLine ? planLine.plan : "",
    rxId: o.rxId || "",
    patientId: o.patientId || "",
    doctor: o.doctorId || "",
    clinic: o.clinicId || "",
    practice: o.practiceId || "",
    wsDoctor: o.wsDoctorId || "",
    wsClinic: o.wsClinicId || "",
    wsPractice: o.wsPracticeId || "",
    wholesaleRole: o.wholesaleRole || "",
    repId: o.commission?.repId || "",
    repAmount: o.commission?.repAmt || 0,
    demo: !!o.demo,
    tags: o.tags || [],
  };
}

/**
 * Purchased Rx orders matching a Mongo filter, newest first. "Purchased"
 * means the order was paid and tagged at some point (the `rx` tag), exactly
 * what the old tag search returned - a later refund does not remove it.
 */
export async function findOrders(filter, { limit = 5000, fromMs = 0, toMs = 0 } = {}) {
  await connectDb();
  const q = { tags: "rx", deletedAt: null, ...filter };
  if (fromMs || toMs) {
    q.orderCreatedAt = {};
    if (fromMs) q.orderCreatedAt.$gte = new Date(fromMs);
    if (toMs) q.orderCreatedAt.$lte = new Date(toMs);
  }
  const rows = await Order.find(q).sort({ orderCreatedAt: -1 }).limit(limit).lean();
  return rows.map(orderView);
}

/** Sum of ad-hoc payouts logged for one id whose status is Paid - a
 *  Pending / Scheduled row is money not yet sent. */
export async function payoutsPaid(entityId) {
  if (!entityId) return 0;
  await connectDb();
  const rows = await Payout.find({ entityId }).lean();
  return rows.reduce(
    (s, r) => s + (String(r.status || "").trim().toLowerCase() === "paid" ? parseAmount(r.amount) : 0),
    0,
  );
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT = MONTHS.map((m) => m.slice(0, 3));

/**
 * Payment history for one (role, id): one line per payout RECORD, newest
 * month first (a month paid and then earning more has a Paid line and an
 * Open / Pending line for the rest):
 *   [{ period: "August 2026", periodRange, key: "2026-08", seq, status,
 *      amount, paid, due, datePaid, transactionNum }]
 * status: "Paid"; "Open" = an unpaid record of the current, still-running
 * month; "Pending" = an unpaid record of a finished month. The current
 * month is always present, even at $0.
 */
export async function payoutHistory(role, entityId) {
  await connectDb();
  const cfg = await getSettings();
  const current = monthKey(new Date(), cfg.TIMEZONE);
  const rows = await MonthlyPayout.find({ role, entityId }).lean();
  const lines = rows.map((r) => {
    const s = payoutSplit(r);
    return {
      key: r.month,
      seq: r.seq || 0,
      status: s.paid > 0 ? "Paid" : r.month === current ? "Open" : "Pending",
      amount: s.amount,
      paid: s.paid,
      due: s.due,
      datePaid: s.paid > 0 ? r.datePaid || "" : "",
      transactionNum: s.paid > 0 ? r.transactionNo || "" : "",
    };
  });
  if (!lines.some((l) => l.key === current)) {
    lines.push({ key: current, seq: 0, status: "Open", amount: 0, paid: 0, due: 0, datePaid: "", transactionNum: "", placeholder: true });
  }
  return lines
    .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : b.seq - a.seq))
    .map((l) => {
      const [y, m] = l.key.split("-").map(Number);
      let period = l.key;
      let periodRange = l.key;
      if (y && m) {
        const lastDay = new Date(y, m, 0).getDate();
        period = `${MONTHS[m - 1]} ${y}`;
        periodRange = `${SHORT[m - 1]} 1, ${y} - ${SHORT[m - 1]} ${lastDay}, ${y}`;
      }
      return { period, periodRange, ...l };
    });
}

/** "Sep 3, 2026" in the configured timezone. */
export function dateLabel(d, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(d);
}
