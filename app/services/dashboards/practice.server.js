import { connectDb } from "../../db.server";
import { Order, Prescription } from "../../models/index.server";
import { doctorInfo, practiceStructure } from "../directory.server";
import { parseAmount } from "../ids.server";
import { getSettings } from "../settings.server";
import {
  OPEN_ONLY_STATUSES,
  csvToArr,
  dateLabel,
  findOrders,
  isAnonPatient,
  isDelivered,
  orderDisplayStatus,
  parseItems,
  payoutHistory,
  payoutsPaid,
} from "./common.server";

/* Practice Dashboard backend (was 3-rx-practice dashboardStats).

   Two sources, both local:
     - PURCHASED sales  -> the `orders` collection (paid, tagged Rx orders)
     - OPEN prescriptions (not purchased yet) -> the `prescriptions` collection
   plus the Clinic -> Doctor tree, so a clinic / doctor is listed the moment
   they are set up, even before their first sale.

   The response shape is unchanged from the Apps Script version - the
   dashboard page reads it as before. */

const docRow = (id, name = "") => ({
  id,
  name,
  created: 0,
  purchased: 0,
  purchasedProtocols: 0,
  revenue: 0,
  bottles: 0,
  earning: 0,
  physicianCommission: 0,
});
const clinicRow = (id, name = "", email = "") => ({
  ...docRow(id, name),
  email,
  clinicCommission: 0,
  practiceCommission: 0,
});

/**
 * clinic / doctor / practice scoped stats. `clinic` and `doctor` may be
 * comma-separated (the page's filters are multiselects); `practice` wins when
 * given. `statusFilter` narrows every count and total to one status.
 */
export async function practiceDashboard({
  clinic = "",
  doctor = "",
  practice = "",
  days = 0,
  commission: commissionOverride = 0,
  from: fromMs = 0,
  to: toMs = 0,
  status: statusFilter = "",
}) {
  clinic = String(clinic).trim();
  doctor = String(doctor).trim();
  practice = String(practice).trim();
  statusFilter = String(statusFilter || "").trim();
  days = Number(days) || 0;
  fromMs = Number(fromMs) || 0;
  toMs = Number(toMs) || 0;
  const clinicArr = csvToArr(clinic);
  const doctorArr = csvToArr(doctor);
  // A custom date range wins over the days preset.
  const cutoff = fromMs > 0 ? fromMs : days > 0 ? Date.now() - days * 86400000 : 0;
  const cutoffTo = toMs > 0 ? toMs : 0;
  if (!clinicArr.length && !doctorArr.length && !practice) {
    return { ok: false, error: "missing clinic, doctor, or practice id" };
  }

  const out = {
    ok: true,
    mode: practice ? "practice" : clinicArr.length ? "clinic" : "doctor",
    clinic,
    doctor,
    practice,
    days,
    totalPrescriptions: 0,
    pendingCheckouts: 0,
    activeOrders: 0,
    shippedOrders: 0,
    activeSubscriptions: 0,
    sales: { thisMonth: 0, lastMonth: 0, allTime: 0, orders: 0 },
    commission: { percent: 0, total: 0, paid: 0, pending: 0 },
    physicianCommissionTotal: 0,
    clinicCommissionTotal: 0,
    practiceCommissionTotal: 0,
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
  const byClinic = {};
  const recent = [];
  const prodCount = {};

  // PRACTICE mode: seed every clinic + doctor of the practice, respecting the
  // filters so an unselected clinic does not show as a zero-activity row.
  const structure = practice ? await practiceStructure(practice) : null;
  if (structure) {
    for (const cl of structure.clinics) {
      if (clinicArr.length && !clinicArr.includes(cl.id)) continue;
      byClinic[cl.id] ||= clinicRow(cl.id, cl.name, cl.email || "");
      for (const doc of cl.doctors) {
        if (doctorArr.length && !doctorArr.includes(doc.id)) continue;
        byDoc[doc.id] ||= docRow(doc.id, doc.name);
        byDoc[doc.id].clinicId = cl.id;
      }
    }
    for (const doc of structure.unassigned) {
      if (clinicArr.length) continue;
      if (doctorArr.length && !doctorArr.includes(doc.id)) continue;
      byDoc[doc.id] ||= docRow(doc.id, doc.name);
    }
  }

  const bucketSale = (amt, pAt) => {
    out.sales.allTime += amt;
    out.sales.orders++;
    if (pAt >= monthStart) out.sales.thisMonth += amt;
    else if (pAt >= lastMonthStart && pAt < monthStart) out.sales.lastMonth += amt;
  };

  /* ===== PURCHASED = paid Rx orders ===== */
  const filter = practice
    ? { practiceId: practice }
    : clinicArr.length
      ? { clinicId: { $in: clinicArr } }
      : { doctorId: { $in: doctorArr } };
  const orders =
    statusFilter && OPEN_ONLY_STATUSES.has(statusFilter)
      ? []
      : await findOrders(filter, { fromMs: cutoff, toMs: cutoffTo });

  for (const o of orders) {
    if (clinicArr.length && !clinicArr.includes(o.clinic)) continue;
    if (doctorArr.length && !doctorArr.includes(o.doctor)) continue;
    const displayStatus = orderDisplayStatus(o);
    if (statusFilter && statusFilter !== displayStatus) continue;

    const docId = o.doctor || "(untagged)";
    const d = (byDoc[docId] ||= docRow(docId));
    // Written / Purchased Protocols count only orders that trace back to a
    // written protocol: an rx id AND a non-anonymous patient. A direct
    // patient order is a real sale but was never a protocol.
    const traced = !!o.rxId && !isAnonPatient(o.patientId);
    if (traced) d.created++;
    d.purchased++;
    if (traced) d.purchasedProtocols++;
    d.revenue += o.amount;
    d.bottles += o.qty;
    d.earning += o.qtyRevenue;
    d.physicianCommission += o.physicianCommission || 0;
    out.physicianCommissionTotal += o.physicianCommission || 0;
    out.clinicCommissionTotal += o.clinicCommission || 0;
    out.practiceCommissionTotal += o.practiceCommission || 0;
    out.totalPrescriptions++;
    out.statuses[displayStatus] = (out.statuses[displayStatus] || 0) + 1;

    if (practice) {
      const cid = o.clinic || "(untagged)";
      const oc = (byClinic[cid] ||= clinicRow(cid));
      if (traced) oc.created++;
      oc.purchased++;
      if (traced) oc.purchasedProtocols++;
      oc.revenue += o.amount;
      oc.bottles += o.qty;
      oc.earning += o.qtyRevenue;
      oc.physicianCommission += o.physicianCommission || 0;
      oc.clinicCommission += o.clinicCommission || 0;
      oc.practiceCommission += o.practiceCommission || 0;
    }

    const pAt = new Date(o.ts);
    // product total only - Sales KPIs do not count shipping / tax
    bucketSale(o.qtyRevenue, pAt);

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
      orderName: o.name,
      name: o.patient,
      items: o.items.map((li) => `${li.title} ×${li.qty}`).join("; "),
      itemsList: o.items.map((li) => ({
        title: li.title,
        qty: li.qty,
        price: li.price,
        profit: li.profit,
        physicianCommission: li.physCommission,
        clinicCommission: li.clinicCommission,
      })),
      status: "Purchased",
      total: o.amount,
      subtotal: o.qtyRevenue,
      commission: o.commission || 0,
      commissionEligible: true,
      physicianCommission: o.physicianCommission,
      clinicCommission: o.clinicCommission,
      subscription: o.subscription,
      deliveryStatus: o.deliveryStatus || "",
    });
  }

  /* ===== OPEN prescriptions (not purchased yet) ===== */
  await connectDb();
  const rxFilter = { status: { $ne: "Purchased" } };
  if (practice) rxFilter.practiceId = practice;
  if (clinicArr.length) rxFilter.clinicId = { $in: clinicArr };
  if (doctorArr.length) rxFilter.doctorId = { $in: doctorArr };
  if (cutoff || cutoffTo) {
    rxFilter.createdAt = {};
    if (cutoff) rxFilter.createdAt.$gte = new Date(cutoff);
    if (cutoffTo) rxFilter.createdAt.$lte = new Date(cutoffTo);
  }
  if (statusFilter) rxFilter.status = statusFilter === "Purchased" ? "__none__" : statusFilter;
  const rxs = await Prescription.find(rxFilter).sort({ createdAt: -1 }).limit(5000).lean();

  for (const r of rxs) {
    const status = r.status || "Created";
    const docId = String(r.doctorId || "").trim() || "(untagged)";
    const d = (byDoc[docId] ||= docRow(docId));
    d.created++;
    out.totalPrescriptions++;
    if (!d.name && r.physician) d.name = String(r.physician).split(" - ")[0];

    if (practice) {
      const cid = String(r.clinicId || "").trim() || "(untagged)";
      (byClinic[cid] ||= clinicRow(cid)).created++;
    }
    out.statuses[status] = (out.statuses[status] || 0) + 1;

    const parsed = parseItems(r.items);
    for (const p of parsed.products) prodCount[p.name] = (prodCount[p.name] || 0) + p.qty;

    recent.push({
      ts: r.createdAt ? r.createdAt.getTime() : 0,
      rxId: r.rxId,
      name: `${r.first || ""} ${r.last || ""}`.trim(),
      items: r.items || "",
      status,
      total: parseAmount(r.total),
      physicianCommission: null,
      clinicCommission: null,
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
    if (!d.name && i.name) d.name = i.name;
    d.email = i.email || "";
  }

  if (practice) {
    out.clinics = Object.values(byClinic).sort((a, b) => b.revenue - a.revenue);
    for (const c of out.clinics) {
      c.doctors = out.doctors
        .filter((d) => d.clinicId === c.id)
        .sort((a, b) => b.revenue - a.revenue);
    }
    out.unassignedDoctors = out.doctors.filter((d) => !d.clinicId);
  }

  out.topProducts = Object.entries(prodCount)
    .map(([name, qty]) => ({ name, qty }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 8);

  recent.sort((a, b) => b.ts - a.ts);
  out.recent = recent.slice(0, 50);

  let pct = Number(commissionOverride) || 0;
  if (!(pct > 0)) pct = Number((await getSettings()).COMMISSION_PERCENT) || 0;
  out.commission.percent = pct;
  out.commission.total = (out.sales.allTime * pct) / 100;
  const paidIds = practice ? [practice] : clinicArr.length ? clinicArr : doctorArr;
  let paid = 0;
  for (const id of paidIds) paid += await payoutsPaid(id);
  out.commission.paid = paid;
  out.commission.pending = Math.max(0, out.commission.total - out.commission.paid);

  // Whole Practice view: Paid = every paid period; Open = the current,
  // still-running month; Pending = finished months still unpaid.
  if (practice) {
    out.payouts = await payoutHistory("Practice", practice);
    // paid = money actually paid; open / pending = what is still owed
    const due = (st) => out.payouts.reduce((s, p) => s + (p.status === st ? p.due : 0), 0);
    out.commission.paid = out.payouts.reduce((s, p) => s + p.paid, 0);
    out.commission.open = due("Open");
    out.commission.pending = due("Pending");
  }

  return out;
}

/**
 * Every order logged for the practice within [fromMs, toMs], with doctor /
 * clinic names resolved - the Payment History table's per-period CSV export.
 * totals = one sum per Physician / Clinic / Practice commission.
 */
export async function practicePeriodOrders(practiceId, fromMs, toMs) {
  await connectDb();
  const cfg = await getSettings();
  const out = { rows: [], totals: { doctor: 0, clinic: 0, practice: 0, total: 0 } };

  const structure = await practiceStructure(practiceId);
  const doctorNameById = {};
  const clinicNameById = {};
  for (const c of structure.clinics) {
    clinicNameById[c.id] = c.name;
    for (const d of c.doctors) doctorNameById[d.id] = d.name;
  }
  for (const d of structure.unassigned) doctorNameById[d.id] = d.name;

  const q = { "commission.logged": true, "commission.practiceId": practiceId };
  if (fromMs || toMs) {
    q.orderCreatedAt = {};
    if (fromMs) q.orderCreatedAt.$gte = new Date(Number(fromMs));
    if (toMs) q.orderCreatedAt.$lte = new Date(Number(toMs));
  }
  const orders = await Order.find(q).sort({ orderCreatedAt: 1 }).lean();
  for (const o of orders) {
    const c = o.commission;
    const total = c.doctorAmt + c.clinicAmt + c.practiceAmt;
    out.rows.push({
      orderName: o.name,
      ts: o.orderCreatedAt.getTime(),
      dateLabel: dateLabel(o.orderCreatedAt, cfg.TIMEZONE),
      doctorId: c.doctorId,
      doctorName: doctorNameById[c.doctorId] || c.doctorId || "",
      clinicId: c.clinicId,
      clinicName: clinicNameById[c.clinicId] || c.clinicId || "",
      doctorAmount: c.doctorAmt,
      clinicAmount: c.clinicAmt,
      practiceAmount: c.practiceAmt,
      total,
      orderStatus: c.status,
    });
    out.totals.doctor += c.doctorAmt;
    out.totals.clinic += c.clinicAmt;
    out.totals.practice += c.practiceAmt;
    out.totals.total += total;
  }
  return out;
}
