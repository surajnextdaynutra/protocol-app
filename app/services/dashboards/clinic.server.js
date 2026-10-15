import { connectDb } from "../../db.server";
import { Prescription, Product } from "../../models/index.server";
import { clinicDoctors, doctorInfo } from "../directory.server";
import { parseAmount } from "../ids.server";
import { findOrders, isAnonPatient, isDelivered, parseItems, payoutsPaid } from "./common.server";

/* Clinic Dashboard backend (was 6-rx-clinic dashboardStats).

   Purchased sales come from the clinic's paid Rx orders; open prescriptions
   from the prescriptions collection. Assigned doctors are seeded from the
   account directory, so a newly added doctor shows up before a first sale.
   "earning" is the physician's cut of an order, "commission" the clinic's
   own cut - both frozen on the order when it was paid. */

// The Status filter's value is this normalised form, not the raw label.
const statusClass = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");

function orderStatusLabel(fulfillmentStatus, deliveryStatus, hasTracking) {
  if (isDelivered(deliveryStatus)) return "Delivered";
  if (String(fulfillmentStatus || "").toUpperCase() !== "FULFILLED") return "Unfulfilled";
  if (hasTracking || deliveryStatus) return "Tracking Added";
  return "Fulfilled";
}

const normalizeTitle = (s) => String(s || "").toLowerCase().trim();

/** Catalogue price by product title, for showing an estimated price on a
 *  not-yet-purchased prescription (which only stores product names). */
async function estimatedPrices(names) {
  names = [...new Set(names.map((n) => String(n || "").trim()).filter(Boolean))];
  if (!names.length) return {};
  await connectDb();
  const rows = await Product.find(
    { title: { $in: names.map((n) => new RegExp("^" + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i")) } },
    { title: 1, price: 1, variants: 1 },
  ).lean();
  const map = {};
  for (const p of rows) {
    const prices = (p.variants || []).map((v) => v.price).filter((n) => n > 0);
    map[normalizeTitle(p.title)] = prices.length ? Math.min(...prices) : p.price || 0;
  }
  return map;
}

function lookupEstimatedPrice(priceMap, name) {
  const norm = normalizeTitle(name);
  if (!norm) return null;
  if (priceMap[norm] != null) return priceMap[norm];
  for (const k of Object.keys(priceMap)) {
    if (k.includes(norm) || norm.includes(k)) return priceMap[k];
  }
  return null;
}

const docRow = (id, name = "", email = "") => ({
  id,
  name,
  email,
  created: 0,
  purchased: 0,
  purchasedProtocols: 0,
  revenue: 0,
  bottles: 0,
  earning: 0,
  commission: 0,
});

export async function clinicDashboard({
  clinic = "",
  days = 0,
  from: fromMs = 0,
  to: toMs = 0,
  status: statusFilter = "",
}) {
  clinic = String(clinic).trim();
  days = Number(days) || 0;
  fromMs = Number(fromMs) || 0;
  toMs = Number(toMs) || 0;
  statusFilter = String(statusFilter || "").trim();
  const cutoff = fromMs > 0 ? fromMs : days > 0 ? Date.now() - days * 86400000 : 0;
  const cutoffTo = toMs > 0 ? toMs : 0;
  if (!clinic) return { ok: false, error: "missing clinic id" };

  const out = {
    ok: true,
    mode: "clinic",
    clinic,
    days,
    totalPrescriptions: 0,
    pendingCheckouts: 0,
    activeOrders: 0,
    shippedOrders: 0,
    activeSubscriptions: 0,
    sales: { thisMonth: 0, lastMonth: 0, allTime: 0, orders: 0 },
    commission: { percent: 0, total: 0, paid: 0, pending: 0 },
    statuses: {},
    doctors: [],
    recent: [],
    topProducts: [],
    source: "db",
  };

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const byDoc = {};
  const recent = [];
  const prodCount = {};

  for (const d of await clinicDoctors(clinic)) byDoc[d.id] ||= docRow(d.id, d.name, d.email);

  const bucketSale = (amt, pAt) => {
    out.sales.allTime += amt;
    out.sales.orders++;
    if (pAt >= monthStart) out.sales.thisMonth += amt;
    else if (pAt >= lastMonthStart && pAt < monthStart) out.sales.lastMonth += amt;
  };

  /* ===== PURCHASED = the clinic's paid Rx orders ===== */
  let commissionAllTime = 0;
  const orders = await findOrders({ clinicId: clinic }, { fromMs: cutoff, toMs: cutoffTo });
  for (const o of orders) {
    const orderStatus = orderStatusLabel(o.fulfillmentStatus, o.deliveryStatus, !!o.trackingUrl);
    if (statusFilter && statusClass(orderStatus) !== statusFilter) continue;

    const docId = o.doctor || "(untagged)";
    const d = (byDoc[docId] ||= docRow(docId));
    const traced = !!o.rxId && !isAnonPatient(o.patientId);
    if (traced) d.created++;
    d.purchased++;
    if (traced) d.purchasedProtocols++;
    d.revenue += o.amount;
    d.bottles += o.qty;
    out.totalPrescriptions++;
    out.statuses["Purchased"] = (out.statuses["Purchased"] || 0) + 1;
    const pAt = new Date(o.ts);
    bucketSale(o.amount, pAt);
    d.earning += o.physicianCommission || 0;
    d.commission += o.clinicCommission || 0;
    commissionAllTime += o.clinicCommission || 0;

    if (pAt >= monthStart) {
      if (isDelivered(o.deliveryStatus)) out.shippedOrders++;
      else out.activeOrders++;
      if (o.subscription) out.activeSubscriptions++;
    }
    for (const li of o.items) {
      if (li.title) prodCount[li.title] = (prodCount[li.title] || 0) + (li.qty || 1);
    }
    recent.push({
      ts: o.ts,
      rxId: o.rxId,
      orderName: o.name || "",
      name: o.patient,
      doctor: docId,
      items: o.items.map((li) => `${li.title} ×${li.qty}`).join("; "),
      products: o.items.map((li) => ({
        name: li.title || "",
        qty: li.qty || 0,
        price: li.price || 0,
        earning: (li.price || 0) * (li.qty || 0),
        commission: li.clinicCommission || 0,
      })),
      productCount: o.items.length,
      totalItems: o.qty,
      status: orderStatus,
      total: o.amount,
      orderValue: o.qtyRevenue,
      earning: o.physicianCommission,
      clinicEarning: o.clinicCommission,
      subscription: o.subscription,
      subscriptionPlanName: o.subscriptionPlanName || "",
      deliveryStatus: o.deliveryStatus || "",
    });
  }

  /* ===== OPEN prescriptions (not purchased yet) ===== */
  await connectDb();
  const rxFilter = { clinicId: clinic, status: { $ne: "Purchased" } };
  if (cutoff || cutoffTo) {
    rxFilter.createdAt = {};
    if (cutoff) rxFilter.createdAt.$gte = new Date(cutoff);
    if (cutoffTo) rxFilter.createdAt.$lte = new Date(cutoffTo);
  }
  let rxs = await Prescription.find(rxFilter).sort({ createdAt: -1 }).limit(5000).lean();
  if (statusFilter) rxs = rxs.filter((r) => statusClass(r.status || "Created") === statusFilter);

  const names = [];
  const parsedById = new Map();
  for (const r of rxs) {
    const parsed = parseItems(r.items);
    parsedById.set(String(r._id), parsed);
    for (const p of parsed.products) if (p.name) names.push(p.name);
  }
  const priceMap = await estimatedPrices(names);

  for (const r of rxs) {
    const status = r.status || "Created";
    const docId = String(r.doctorId || "").trim() || "(untagged)";
    const d = (byDoc[docId] ||= docRow(docId));
    d.created++;
    out.totalPrescriptions++;
    if (!d.name && r.physician) d.name = String(r.physician).split(" - ")[0];
    out.statuses[status] = (out.statuses[status] || 0) + 1;

    const parsed = parsedById.get(String(r._id));
    for (const p of parsed.products) prodCount[p.name] = (prodCount[p.name] || 0) + p.qty;

    const rowTotal = parseAmount(r.total);
    const rowProducts = parsed.products.map((p) => {
      const est = lookupEstimatedPrice(priceMap, p.name);
      return {
        name: p.name,
        qty: p.qty || 0,
        price: est,
        earning: est != null ? est * (p.qty || 0) : null,
        priceEstimated: est != null,
      };
    });
    // Scale the catalogue estimates so they add up to the prescription total.
    const rawTotal = rowProducts.reduce((s, p) => s + (p.earning || 0), 0);
    if (rowTotal > 0 && rawTotal > 0 && rowProducts.length && rowProducts.every((p) => p.price != null)) {
      const scale = rowTotal / rawTotal;
      for (const p of rowProducts) {
        p.price *= scale;
        p.earning *= scale;
      }
    }

    recent.push({
      ts: r.createdAt ? r.createdAt.getTime() : 0,
      rxId: r.rxId,
      orderName: String(r.orderName || "").trim(),
      name: `${r.first || ""} ${r.last || ""}`.trim(),
      doctor: docId,
      items: r.items || "",
      products: rowProducts,
      productCount: parsed.products.length,
      totalItems: parsed.products.reduce((s, p) => s + (p.qty || 0), 0),
      status,
      total: rowTotal,
      orderValue: null,
      earning: null,
      clinicEarning: null,
      subscription: parsed.subscription,
    });
  }

  out.pendingCheckouts =
    (out.statuses["Checkout Started"] || 0) + (out.statuses["Abandoned"] || 0);

  out.doctors = Object.values(byDoc).sort((a, b) => b.revenue - a.revenue);
  const info = await doctorInfo(out.doctors.map((d) => d.id));
  for (const d of out.doctors) {
    const i = info[d.id];
    if (!i) continue;
    if (i.name) d.name = i.name;
    d.email = i.email || "";
  }

  out.topProducts = Object.entries(prodCount)
    .map(([name, qty]) => ({ name, qty }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 8);

  recent.sort((a, b) => b.ts - a.ts);
  out.recent = recent.slice(0, 30);

  out.commission.total = commissionAllTime;
  out.commission.paid = await payoutsPaid(clinic);
  out.commission.pending = Math.max(0, commissionAllTime - out.commission.paid);
  return out;
}
