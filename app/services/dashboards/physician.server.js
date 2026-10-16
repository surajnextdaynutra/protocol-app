import { connectDb } from "../../db.server";
import { Order, Prescription } from "../../models/index.server";
import { fillTemplate, sendEmail } from "../brevo.server";
import { clinicInfo, practiceInfo } from "../directory.server";
import { drName, monthKey, parseAmount } from "../ids.server";
import { getSettings, isTrue } from "../settings.server";
import {
  dateLabel,
  findOrders,
  isDelivered,
  parseItems,
  payoutHistory,
  payoutsPaid,
} from "./common.server";

/* Physician Dashboard backend (was 4-rx-physician).

   doctor mode: one physician's own prescriptions, orders and earnings.
   clinic mode: the same view for a clinic id (legacy; the Clinic Dashboard
   has its own backend).

   SOLO doctor: their practice has only this one physician and no separate
   Practice Master, so no per-product physician commission is ever set - the
   whole profit (sell - wholesale) is theirs, and they get their own Payment
   History. */

export async function physicianDashboard({
  clinic = "",
  doctor = "",
  days = 0,
  practice = "",
}) {
  clinic = String(clinic).trim();
  doctor = String(doctor).trim();
  practice = String(practice || "").trim();
  days = Number(days) || 0;
  const cutoff = days > 0 ? Date.now() - days * 86400000 : 0;
  if (!clinic && !doctor) return { ok: false, error: "missing clinic or doctor id" };

  // Fails open toward solo, like the page's own check for the same question.
  let pInfo = null;
  if (doctor && practice) {
    try {
      pInfo = await practiceInfo(practice);
    } catch {
      pInfo = { ok: false };
    }
  }
  const isSolo = pInfo ? (pInfo.ok ? !!pInfo.soloDoctor : true) : false;

  const out = {
    ok: true,
    mode: doctor ? "doctor" : "clinic",
    clinic,
    clinicName: clinic ? (await clinicInfo(clinic).catch(() => ({}))).name || "" : "",
    doctor,
    days,
    totalPrescriptions: 0,
    pendingCheckouts: 0,
    activeOrders: 0,
    shippedOrders: 0,
    activeSubscriptions: 0,
    sales: { thisMonth: 0, lastMonth: 0, allTime: 0, orders: 0, ordersThisMonth: 0 },
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
  let commissionAllTime = 0;

  const bucketSale = (amt, pAt) => {
    out.sales.allTime += amt;
    out.sales.orders++;
    if (pAt >= monthStart) {
      out.sales.thisMonth += amt;
      out.sales.ordersThisMonth++;
    } else if (pAt >= lastMonthStart && pAt < monthStart) {
      out.sales.lastMonth += amt;
    }
  };
  const doc = (id) => (byDoc[id] ||= { id, name: "", created: 0, purchased: 0, revenue: 0 });

  /* ===== PURCHASED = paid Rx orders ===== */
  const orders = await findOrders(doctor ? { doctorId: doctor } : { clinicId: clinic }, {
    fromMs: cutoff,
  });
  for (const o of orders) {
    if (clinic && o.clinic !== clinic) continue;
    if (doctor && o.doctor !== doctor) continue;

    const d = doc(o.doctor || "(untagged)");
    d.created++;
    d.purchased++;
    d.revenue += o.amount;
    out.totalPrescriptions++;
    out.statuses["Purchased"] = (out.statuses["Purchased"] || 0) + 1;
    const pAt = new Date(o.ts);
    bucketSale(o.amount, pAt);
    // Solo: the whole profit pool. Otherwise the physician's own per-product
    // cut, frozen on the order when it was paid.
    const myEarning = isSolo ? o.commission || 0 : o.physicianCommission || 0;
    commissionAllTime += myEarning;

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
      lastActivityTs: o.ts,
      rxId: o.rxId,
      patientId: o.patientId || "",
      name: o.patient,
      email: o.email || "",
      phone: o.phone || "",
      items: o.items.map((li) => `${li.title} ×${li.qty}`).join("; "),
      itemsList: o.items.map((li) => ({
        title: li.title,
        qty: li.qty,
        price: li.price,
        wholesale: li.wholesale,
        profit: li.profit,
        physicianCommission: li.physicianCommission,
        plan: li.plan,
      })),
      status: "Purchased",
      total: o.amount,
      subtotal: o.subtotal,
      commission: myEarning,
      commissionEligible: true,
      confirmed: true,
      subscription: o.subscription,
      subscriptionPlanName: o.subscriptionPlanName || "",
      fulfillmentStatus: o.fulfillmentStatus || "",
      financialStatus: o.financialStatus || "",
      deliveryStatus: o.deliveryStatus || "",
      estimatedDeliveryAt: o.estimatedDeliveryAt || 0,
      trackingCompany: o.trackingCompany || "",
      trackingUrl: o.trackingUrl || "",
      orderName: o.name || "",
      cartLink: "",
      expiresAt: 0,
    });
  }

  /* ===== OPEN prescriptions (not purchased yet) ===== */
  await connectDb();
  const rxFilter = { status: { $ne: "Purchased" } };
  if (clinic) rxFilter.clinicId = clinic;
  if (doctor) rxFilter.doctorId = doctor;
  if (cutoff) rxFilter.createdAt = { $gte: new Date(cutoff) };
  const rxs = await Prescription.find(rxFilter).sort({ createdAt: -1 }).limit(5000).lean();
  const ms = (d) => (d ? d.getTime() : 0);

  for (const r of rxs) {
    const d = doc(String(r.doctorId || "").trim() || "(untagged)");
    d.created++;
    out.totalPrescriptions++;
    if (!d.name && r.physician) d.name = String(r.physician).split(" - ")[0];

    const status = r.status || "Created";
    out.statuses[status] = (out.statuses[status] || 0) + 1;
    const parsed = parseItems(r.items);
    for (const p of parsed.products) prodCount[p.name] = (prodCount[p.name] || 0) + p.qty;

    const createdTs = ms(r.createdAt);
    recent.push({
      ts: createdTs,
      lastActivityTs: ms(r.checkoutAt) || ms(r.openedAt) || ms(r.emailSentAt) || createdTs,
      rxId: r.rxId,
      patientId: r.patientId || "",
      name: `${r.first || ""} ${r.last || ""}`.trim(),
      email: r.email || "",
      phone: r.phone || "",
      items: r.items || "",
      itemsList: parsed.products,
      status,
      total: parseAmount(r.total),
      subtotal: parseAmount(r.total),
      commission: 0,
      commissionEligible: false,
      confirmed: !!r.confirmed,
      subscription: parsed.subscription,
      subscriptionPlanName: "",
      fulfillmentStatus: "",
      financialStatus: "",
      deliveryStatus: "",
      estimatedDeliveryAt: 0,
      trackingCompany: "",
      trackingUrl: "",
      orderName: r.orderName || "",
      cartLink: r.link || "",
      expiresAt: ms(r.expiresAt),
    });
  }

  out.pendingCheckouts =
    (out.statuses["Checkout Started"] || 0) + (out.statuses["Abandoned"] || 0);
  out.doctors = Object.values(byDoc).sort((a, b) => b.revenue - a.revenue);
  out.topProducts = Object.entries(prodCount)
    .map(([name, qty]) => ({ name, qty }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 10);
  recent.sort((a, b) => b.ts - a.ts);
  out.recent = recent; // full list - the page paginates / filters itself

  out.commission.total = commissionAllTime;
  out.commission.paid = await payoutsPaid(doctor || clinic);
  out.commission.pending = Math.max(0, commissionAllTime - out.commission.paid);

  // Payment History - solo physician only; a doctor inside a larger practice
  // is paid by the practice.
  if (doctor && isSolo) {
    out.payouts = await doctorPayouts(doctor);
    out.payoutPaid = out.payouts.reduce((s, p) => s + (p.paid || 0), 0);
    out.payoutPending = out.payouts.reduce((s, p) => s + (p.due || 0), 0);
  }
  if (pInfo) {
    out.solo = isSolo;
    out.physicianCount = pInfo.ok ? pInfo.physicianCount : null;
  }
  return out;
}

/**
 * A solo doctor's Payment History. The amount per month is the FULL profit
 * of that month's logged orders (Doctor + Clinic + Practice amounts - for a
 * solo doctor all of it sits in the Doctor amount); status / date paid /
 * transaction # come from the finance admin's payout rows.
 */
export async function doctorPayouts(doctorId) {
  await connectDb();
  const cfg = await getSettings();
  const history = await payoutHistory("Doctor", doctorId); // one line per payout record

  const orders = await Order.find(
    { "commission.logged": true, "commission.doctorId": doctorId },
    { orderCreatedAt: 1, commission: 1 },
  ).lean();
  const profitByMonth = {};
  for (const o of orders) {
    const key = monthKey(o.orderCreatedAt, cfg.TIMEZONE);
    const c = o.commission;
    profitByMonth[key] = (profitByMonth[key] || 0) + c.doctorAmt + c.clinicAmt + c.practiceAmt;
  }
  const current = monthKey(new Date(), cfg.TIMEZONE);
  // a month with no payout record yet shows its orders' total as owed
  const owed = (key) => Math.round((profitByMonth[key] || 0) * 100) / 100;
  const lines = history.map((h) => (h.placeholder ? { ...h, amount: owed(h.key), due: owed(h.key) } : h));
  const months = new Set(history.map((h) => h.key));
  for (const key of Object.keys(profitByMonth)) {
    if (months.has(key)) continue;
    const [y, m] = key.split("-").map(Number);
    lines.push({
      period: new Date(y, m - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" }),
      key,
      seq: 0,
      status: key === current ? "Open" : "Pending",
      amount: owed(key),
      paid: 0,
      due: owed(key),
      datePaid: "",
      transactionNum: "",
    });
  }
  return lines
    .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : (b.seq || 0) - (a.seq || 0)))
    .map((h) => ({
      period: h.period,
      key: h.key,
      status: h.status,
      amount: h.amount,
      paid: h.paid,
      due: h.due,
      datePaid: h.datePaid,
      transactionNum: h.transactionNum,
    }));
}

/** Logged orders of one doctor within [fromMs, toMs] - the per-period CSV. */
export async function doctorPeriodOrders(doctorId, fromMs, toMs) {
  await connectDb();
  const cfg = await getSettings();
  const out = { rows: [], totals: { doctor: 0, clinic: 0, practice: 0, total: 0 } };
  const q = { "commission.logged": true, "commission.doctorId": doctorId };
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
      doctorAmount: c.doctorAmt,
      clinicAmount: c.clinicAmt,
      practiceAmount: c.practiceAmt,
      total,
    });
    out.totals.doctor += c.doctorAmt;
    out.totals.clinic += c.clinicAmt;
    out.totals.practice += c.practiceAmt;
    out.totals.total += total;
  }
  return out;
}

/**
 * "Send Link" on the dashboard: re-sends the checkout-link email for one
 * prescription. Email and link are read from the stored prescription, never
 * from the page, and the prescription must belong to the caller's own
 * doctor / clinic id.
 */
export async function sendCheckoutLink(rxId, doctor, clinic) {
  const cfg = await getSettings();
  if (isTrue(cfg.EMAIL_DISABLED)) {
    return { ok: false, error: "Email sending is temporarily disabled (EMAIL_DISABLED)." };
  }
  rxId = String(rxId || "").trim();
  if (!rxId) return { ok: false, error: "missing rxId" };
  await connectDb();
  const r = await Prescription.findOne({ rxId }).lean();
  if (!r) return { ok: false, error: "prescription not found" };
  if (clinic && String(r.clinicId).trim() !== clinic) {
    return { ok: false, error: "not authorized for this prescription" };
  }
  if (doctor && String(r.doctorId).trim() !== doctor) {
    return { ok: false, error: "not authorized for this prescription" };
  }
  const email = String(r.email || "").trim();
  const link = String(r.link || "").trim();
  if (!email) return { ok: false, error: "no email on file for this patient" };
  if (!link) return { ok: false, error: "no checkout link on file" };

  const patientName = String(r.first || "").trim() || `${r.first || ""} ${r.last || ""}`.trim() || "there";
  const doctorName = drName(r.physician);
  const values = {
    name: patientName,
    link,
    validity: String(r.validity || "").trim(),
    doctor_name: doctorName,
  };
  try {
    await sendEmail({
      to: email,
      subject: String(cfg.CONFIRMED_SUBJECT || "Your prescription order link"),
      htmlBody: fillTemplate(cfg.CONFIRMED_BODY, values),
      params: { NAME: patientName, LINK: link, VALIDITY: values.validity, DOCTOR_NAME: doctorName },
      templateId: cfg.CONFIRMED_TEMPLATE_ID,
    });
  } catch (err) {
    return { ok: false, error: "email failed: " + String(err) };
  }
  return { ok: true };
}
