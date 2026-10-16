import { connectDb } from "../../db.server";
import { Banking, Prescription, SalesRep } from "../../models/index.server";
import { repCommissionPerUnit } from "../commission.server";
import { decryptJson, encryptJson } from "../crypto.server";
import { repAccounts } from "../directory.server";
import { monthKey, tagVal } from "../ids.server";
import { logEvent } from "../log.server";
import { getSettings } from "../settings.server";
import { csvToArr, findOrders, isDelivered, payoutHistory } from "./common.server";

/* Sales Rep Dashboard backend (was 5-rx-rep).

   A rep covers the practices / clinics assigned to them (SalesRep record)
   plus any account tagged rep_id:<rep>. Commission is a flat $ per unit on
   every PAID order of those accounts - Rx orders and wholesale-page orders
   alike. Everything is read from MongoDB, so changing a filter is a fresh,
   fast query (the old 2-minute cache is gone). */

const personName = (c) => [c.first, c.last].filter(Boolean).join(" ");

function orderStatusLabel(fulfillmentStatus, deliveryStatus, hasTracking) {
  if (isDelivered(deliveryStatus)) return "Delivered";
  if (String(fulfillmentStatus || "").toUpperCase() !== "FULFILLED") return "Unfulfilled";
  if (hasTracking || deliveryStatus) return "Tracking Added";
  return "Fulfilled";
}

/** Order view with the rep dashboard's own id rule: a wholesale-page order's
 *  wholesale ids stand in when the plain ones are blank. */
function repOrder(o) {
  return {
    ...o,
    units: o.qty,
    doctor: o.doctor || o.wsDoctor,
    clinic: o.clinic || o.wsClinic,
    practice: o.practice || o.wsPractice,
    fulfilled: String(o.fulfillmentStatus).toUpperCase() === "FULFILLED",
    orderStatus: orderStatusLabel(o.fulfillmentStatus, o.deliveryStatus, !!o.trackingUrl),
  };
}

export async function repAssignedPractices(repId) {
  await connectDb();
  const rep = await SalesRep.findOne({ repId }, { assignedPracticeIds: 1 }).lean();
  return rep?.assignedPracticeIds || [];
}

/** Payment records for the rep, from the payout summary - one row per
 *  payout record (a month paid and then earning more has two). */
async function repPayouts(repId) {
  const out = { total: 0, paid: 0, pending: 0, currentMonthPaidAmount: 0, rows: [] };
  const cfg = await getSettings();
  const current = monthKey(new Date(), cfg.TIMEZONE);
  for (const h of await payoutHistory("Rep", repId)) {
    if (!(h.amount > 0)) continue;
    out.total += h.amount;
    out.paid += h.paid;
    out.pending += h.due;
    if (h.key === current) out.currentMonthPaidAmount += h.paid;
    const [y, m] = h.key.split("-").map(Number);
    const monthTs = y && m ? new Date(y, m - 1, 1).getTime() : 0;
    out.rows.push({
      ts: (h.datePaid && Date.parse(h.datePaid)) || monthTs,
      amount: h.amount,
      note: h.period,
      periodRange: h.periodRange,
      method: "",
      reference: h.transactionNum,
      status: h.status,
    });
  }
  out.rows.sort((a, b) => b.ts - a.ts);
  return out;
}

function buildSeries(out, days, now, monthly, buckets) {
  const MN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n) => ("0" + n).slice(-2);
  if (monthly) {
    for (let i = 11; i >= 0; i--) {
      const md = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const b = buckets[`${md.getFullYear()}-${pad(md.getMonth() + 1)}`] || { sales: 0, orders: 0 };
      out.series.push({
        label: `${MN[md.getMonth()]} ${String(md.getFullYear()).slice(-2)}`,
        sales: b.sales,
        orders: b.orders,
      });
    }
  } else {
    for (let j = days - 1; j >= 0; j--) {
      const dd = new Date(now.getTime() - j * 86400000);
      const b = buckets[`${dd.getFullYear()}-${pad(dd.getMonth() + 1)}-${pad(dd.getDate())}`] || { sales: 0, orders: 0 };
      out.series.push({ label: `${dd.getDate()}/${dd.getMonth() + 1}`, sales: b.sales, orders: b.orders });
    }
  }
}

export async function repDashboard({
  rep = "",
  days = 0,
  doctor = "",
  clinic = "",
  from: fromMs = 0,
  to: toMs = 0,
  practice: practiceFilter = "",
  status: statusFilter = "",
}) {
  rep = String(rep || "").trim();
  const doctorFilterArr = csvToArr(doctor);
  const clinicFilterArr = csvToArr(clinic);
  practiceFilter = String(practiceFilter || "").trim();
  statusFilter = String(statusFilter || "").trim();
  days = Number(days) || 0;
  fromMs = Number(fromMs) || 0;
  toMs = Number(toMs) || 0;
  if (!rep) return { ok: false, error: "missing rep id" };

  const cfg = await getSettings();
  const perUnit = await repCommissionPerUnit();
  const cutoff = fromMs > 0 ? fromMs : days > 0 ? Date.now() - days * 86400000 : 0;
  const cutoffTo = toMs > 0 ? toMs : 0;
  const now = new Date();
  const out = {
    ok: true,
    rep: { id: rep },
    days,
    totals: { orders: 0, sales: 0, units: 0, doctors: 0, clinics: 0 },
    doctors: [],
    clinics: [],
    practices: [],
    orders: [],
    series: [],
    doctorOptions: [],
    clinicOptions: [],
    practiceOptions: [],
    commission: { total: 0, paid: 0, pending: 0 },
  };

  const finishEmpty = async () => {
    buildSeries(out, days, now, days === 0 || days > 90, {});
    const pay = await repPayouts(rep);
    out.commission.paid = pay.paid;
    out.commission.open = 0;
    out.commission.processing = pay.pending;
    out.commission.payments = pay.rows;
    out.banking = await repBankingGet(rep);
    return out;
  };

  /* ===== Step 1: the rep's accounts ===== */
  const assigned = await repAssignedPractices(rep);
  const accounts = await repAccounts(rep, assigned);
  const clinicMasters = {}; // clinicId -> { name, email } from the clinic's own account
  const practiceMasters = {}; // practiceId -> { name, email } from the Practice Master
  const repDoctors = [];
  for (const c of accounts) {
    if (!c.doctorId) {
      const name = c.company || personName(c);
      if (c.clinicId) clinicMasters[c.clinicId] ||= { name: name || c.clinicId, email: c.email || "" };
      else if (c.practiceId) practiceMasters[c.practiceId] ||= { name: name || c.practiceId, email: c.email || "" };
      continue; // must have a doctor_id to attribute orders
    }
    repDoctors.push({
      doctorId: c.doctorId,
      clinicId: c.clinicId,
      practiceId: c.practiceId,
      clinicName: tagVal(c.tags, "clinic_location:") || tagVal(c.tags, "clinic_name:"),
      practiceName: tagVal(c.tags, "practice_location:"),
      name: personName(c) || c.doctorId,
      email: c.email || "",
      phone: c.phone || "",
    });
  }

  const clinicNameTags = {};
  const practiceNameTags = {};
  const practiceDoctorNames = {};
  for (const d of repDoctors) {
    if (d.clinicId && d.clinicName && !clinicNameTags[d.clinicId]) clinicNameTags[d.clinicId] = d.clinicName;
    const pid = d.practiceId || "";
    if (pid && d.practiceName && !practiceNameTags[pid]) practiceNameTags[pid] = d.practiceName;
    if (d.name && d.name !== d.doctorId) {
      const list = (practiceDoctorNames[pid] ||= []);
      if (!list.includes(d.name)) list.push(d.name);
    }
  }
  const clinicDisplayName = (id) =>
    id ? clinicMasters[id]?.name || clinicNameTags[id] || id : "";
  const practiceDisplayName = (id) =>
    (id && practiceMasters[id]?.name) ||
    practiceNameTags[id] ||
    (practiceDoctorNames[id || ""] || []).join(", ") ||
    id ||
    "";

  const seenClinic = new Set();
  const seenPractice = new Set();
  for (const d of repDoctors) {
    out.doctorOptions.push({ id: d.doctorId, name: d.name || d.doctorId, clinicId: d.clinicId || "", practiceId: d.practiceId || "" });
    if (d.clinicId && !seenClinic.has(d.clinicId)) {
      seenClinic.add(d.clinicId);
      out.clinicOptions.push({ id: d.clinicId, name: clinicDisplayName(d.clinicId), practiceId: d.practiceId || "" });
    }
    if (d.practiceId && !seenPractice.has(d.practiceId)) {
      seenPractice.add(d.practiceId);
      out.practiceOptions.push({ id: d.practiceId, name: practiceDisplayName(d.practiceId) });
    }
  }
  if (!repDoctors.length) return finishEmpty();

  const docInfo = {};
  const clinicOf = {};
  const doctorIds = [];
  for (const d of repDoctors) {
    if (doctorFilterArr.length && !doctorFilterArr.includes(d.doctorId)) continue;
    if (clinicFilterArr.length && !clinicFilterArr.includes(d.clinicId)) continue;
    if (practiceFilter && d.practiceId !== practiceFilter) continue;
    docInfo[d.doctorId] = d;
    clinicOf[d.doctorId] = d.clinicId || "";
    doctorIds.push(d.doctorId);
  }
  if (!doctorIds.length) return finishEmpty();
  const allDoctorIds = [...new Set(repDoctors.map((d) => d.doctorId))];

  /* ===== Step 2: orders of those doctors ===== */
  const range = { fromMs: cutoff, toMs: cutoffTo, limit: 20000 };
  const shopOrders = (await findOrders({ doctorId: { $in: allDoctorIds } }, range)).map(repOrder);

  const byDoctor = {};
  const byClinic = {};
  const ordersArr = [];
  let commissionAllTime = 0;
  let commissionOpen = 0;
  const openMonthKey = monthKey(now, cfg.TIMEZONE);
  const inOpenMonth = (ts) => !!ts && monthKey(new Date(ts), cfg.TIMEZONE) === openMonthKey;

  const doctorBucket = (id) => {
    if (!byDoctor[id]) {
      const info = docInfo[id] || {};
      byDoctor[id] = {
        doctorId: id,
        name: info.name || id,
        email: info.email || "",
        clinicId: info.clinicId || "",
        practiceId: info.practiceId || "",
        prescriptions: 0,
        orders: 0,
        purchasedProtocols: 0,
        units: 0,
        sales: 0,
        commission: 0,
      };
    }
    return byDoctor[id];
  };
  const clinicBucket = (id) =>
    (byClinic[id] ||= { clinicId: id, practiceId: "", name: id, email: "", prescriptions: 0, orders: 0, units: 0, sales: 0, commission: 0, doctors: {} });
  doctorIds.forEach(doctorBucket);

  const passes = (o) =>
    o.financialStatus === "PAID" && (!statusFilter || String(o.orderStatus || "Unfulfilled") === statusFilter);

  const orderRow = (o, extra) => ({
    ts: o.ts,
    order: o.name,
    amount: o.amount,
    units: o.units,
    commission: o.units * perUnit,
    patient: o.patient,
    email: o.email,
    patientId: o.patientId || "",
    subscription: o.subscription,
    fulfilled: o.fulfilled,
    fulfillmentStatus: o.fulfillmentStatus || "",
    deliveryStatus: o.deliveryStatus || "",
    orderStatus: o.orderStatus || "Unfulfilled",
    ...extra,
  });

  for (const o of shopOrders) {
    if (!passes(o)) continue;
    const docId = o.doctor;
    if (!docInfo[docId]) continue; // only this rep's (filtered) doctors
    const clinId = o.clinic || clinicOf[docId] || "";
    const orderCommission = o.units * perUnit;
    commissionAllTime += orderCommission;
    if (inOpenMonth(o.ts)) commissionOpen += orderCommission;
    out.totals.orders++;
    out.totals.sales += o.amount;
    out.totals.units += o.units;

    const db = doctorBucket(docId);
    db.orders++;
    db.units += o.units;
    db.sales += o.amount;
    db.commission += orderCommission;
    if (o.rxId) db.purchasedProtocols++;
    db.prescriptions = db.orders;

    if (clinId) {
      const cb = clinicBucket(clinId);
      cb.orders++;
      cb.units += o.units;
      cb.sales += o.amount;
      cb.commission += orderCommission;
      cb.prescriptions = cb.orders;
      cb.doctors[docId] = 1;
      if (!cb.email && docInfo[docId].email) cb.email = docInfo[docId].email;
      if (!cb.practiceId && docInfo[docId].practiceId) cb.practiceId = docInfo[docId].practiceId;
      if (cb.name === clinId && docInfo[docId].name) cb.name = docInfo[docId].name;
    }
    const pid = docInfo[docId].practiceId || "";
    ordersArr.push(
      orderRow(o, {
        doctorId: docId,
        doctorName: docInfo[docId].name || docId,
        clinicId: clinId,
        clinicName: clinicDisplayName(clinId),
        practiceId: pid,
        practiceName: practiceDisplayName(pid),
      }),
    );
  }

  /* ===== Orders a doctor_id match cannot see =====
     1) a Clinic / Practice Master's own wholesale order (no doctor id)
     2) an order carrying this rep's own rep_id: tag (older orders)
     3) a wholesale-page order (wholesale_*_id only)
     De-duplicated against the first pass by order name. */
  const repClinicIds = Object.keys(clinicMasters);
  const repPracticeIds = new Set(Object.keys(practiceMasters));
  for (const id of assigned) {
    if (/^CLN/i.test(id)) {
      if (!repClinicIds.includes(id)) repClinicIds.push(id);
    } else {
      repPracticeIds.add(id);
    }
  }
  const pIds = [...repPracticeIds];
  const seenOrderNames = new Set(shopOrders.map((o) => o.name));
  const extraOr = [{ tags: "rep_id:" + rep }, { wsDoctorId: { $in: allDoctorIds } }];
  if (repClinicIds.length) extraOr.push({ clinicId: { $in: repClinicIds } }, { wsClinicId: { $in: repClinicIds } });
  if (pIds.length) extraOr.push({ practiceId: { $in: pIds } }, { wsPracticeId: { $in: pIds } });
  const extraOrders = (await findOrders({ $or: extraOr }, range)).map(repOrder);

  const anyEntityFilter = !!(doctorFilterArr.length || clinicFilterArr.length || practiceFilter);
  const docOfRep = {};
  const practiceOfClinic = {};
  for (const d of repDoctors) {
    docOfRep[d.doctorId] ||= d;
    if (d.clinicId && d.practiceId) practiceOfClinic[d.clinicId] ||= d.practiceId;
  }
  const extraMatchesFilters = (o) => {
    if (!anyEntityFilter) return true;
    const d = o.doctor ? docOfRep[o.doctor] || {} : {};
    const clinicId = o.clinic || d.clinicId || "";
    const practiceId = o.practice || d.practiceId || practiceOfClinic[clinicId] || "";
    if (doctorFilterArr.length && !doctorFilterArr.includes(o.doctor || "")) return false;
    if (clinicFilterArr.length && !clinicFilterArr.includes(clinicId)) return false;
    if (practiceFilter && practiceId !== practiceFilter) return false;
    return true;
  };

  const extraPracticeOrders = [];
  const extraClinicOrders = [];
  for (const o of extraOrders) {
    if (seenOrderNames.has(o.name)) continue;
    seenOrderNames.add(o.name);
    if (!extraMatchesFilters(o) || !passes(o)) continue;
    const orderCommission = o.units * perUnit;
    commissionAllTime += orderCommission;
    if (inOpenMonth(o.ts)) commissionOpen += orderCommission;
    out.totals.orders++;
    out.totals.sales += o.amount;
    out.totals.units += o.units;

    const add = (b) => {
      b.orders++;
      b.units += o.units;
      b.sales += o.amount;
      b.commission += orderCommission;
      b.prescriptions = b.orders;
    };
    if (o.doctor) {
      add(doctorBucket(o.doctor));
      if (o.clinic) {
        const cb = clinicBucket(o.clinic);
        add(cb);
        cb.doctors[o.doctor] = 1;
      }
    } else if (o.clinic) {
      const cb = clinicBucket(o.clinic);
      add(cb);
      if (!cb.practiceId && o.practice) cb.practiceId = o.practice;
      extraClinicOrders.push(o);
    } else if (o.practice) {
      extraPracticeOrders.push(o);
    }

    let wholesaleLabel = "(Wholesale order - no physician)";
    if (o.wholesaleRole === "clinic") wholesaleLabel = "(Clinic wholesale order)";
    else if (o.wholesaleRole === "practice") wholesaleLabel = "(Practice wholesale order)";
    else if (o.wholesaleRole === "physician") wholesaleLabel = "(Physician wholesale order)";
    ordersArr.push(
      orderRow(o, {
        doctorId: o.doctor || "",
        doctorName: o.doctor ? docInfo[o.doctor]?.name || o.doctor : wholesaleLabel,
        clinicId: o.clinic || "",
        clinicName: clinicDisplayName(o.clinic),
        practiceId: o.practice || "",
        practiceName: practiceDisplayName(o.practice),
      }),
    );
  }

  for (const [cid, c] of Object.entries(byClinic)) {
    const master = clinicMasters[cid];
    if (master) {
      c.name = master.name;
      if (master.email) c.email = master.email;
    } else if (clinicNameTags[cid]) {
      c.name = clinicNameTags[cid];
    }
  }

  /* ===== Open (not yet purchased) protocols per doctor ===== */
  await connectDb();
  const rxQ = { doctorId: { $in: doctorIds }, status: { $ne: "Purchased" } };
  if (cutoff || cutoffTo) {
    rxQ.createdAt = {};
    if (cutoff) rxQ.createdAt.$gte = new Date(cutoff);
    if (cutoffTo) rxQ.createdAt.$lte = new Date(cutoffTo);
  }
  const openAgg = await Prescription.aggregate([
    { $match: rxQ },
    { $group: { _id: "$doctorId", n: { $sum: 1 } } },
  ]);
  const openCounts = Object.fromEntries(openAgg.map((r) => [r._id, r.n]));
  for (const d of Object.values(byDoctor)) {
    d.openProtocols = openCounts[d.doctorId] || 0;
    d.completedProtocols = d.purchasedProtocols;
    d.writtenProtocols = d.openProtocols + d.completedProtocols;
    d.conversion = d.writtenProtocols ? Math.round((d.completedProtocols / d.writtenProtocols) * 100) : 0;
  }

  out.doctors = Object.values(byDoctor).sort((a, b) => b.sales - a.sales);
  out.clinics = Object.values(byClinic)
    .map((c) => {
      c.doctorCount = Object.keys(c.doctors).length;
      delete c.doctors;
      return c;
    })
    .sort((a, b) => b.sales - a.sales);
  out.totals.doctors = out.doctors.length;
  out.totals.clinics = out.clinics.length;

  /* ===== Practice Performance: practice -> one row per clinic + physician ===== */
  const byPractice = {};
  const practiceBucket = (pid) =>
    (byPractice[pid] ||= {
      id: pid,
      name: practiceDisplayName(pid) || "Unassigned",
      email: practiceMasters[pid]?.email || "",
      openProtocols: 0,
      completedProtocols: 0,
      writtenProtocols: 0,
      orders: 0,
      units: 0,
      sales: 0,
      commission: 0,
      rows: [],
    });
  for (const d of Object.values(byDoctor)) {
    const pb = practiceBucket(d.practiceId || "");
    pb.openProtocols += d.openProtocols;
    pb.completedProtocols += d.completedProtocols;
    pb.writtenProtocols += d.writtenProtocols;
    pb.orders += d.orders;
    pb.units += d.units;
    pb.sales += d.sales;
    pb.commission += d.commission;
    pb.rows.push({
      clinicId: d.clinicId,
      clinicName: clinicDisplayName(d.clinicId),
      doctorId: d.doctorId,
      doctorName: d.name,
      doctorEmail: d.email,
      writtenProtocols: d.writtenProtocols,
      completedProtocols: d.completedProtocols,
      conversion: d.conversion,
      orders: d.orders,
      units: d.units,
      earnings: d.commission,
    });
  }
  const wholesaleRow = (pb, o, clinicId, label) => {
    const earnings = o.units * perUnit;
    pb.orders += 1;
    pb.units += o.units;
    pb.sales += o.amount;
    pb.commission += earnings;
    pb.rows.push({
      clinicId,
      clinicName: clinicDisplayName(clinicId),
      doctorId: "",
      doctorName: label,
      doctorEmail: "",
      writtenProtocols: 0,
      completedProtocols: 0,
      conversion: 0,
      orders: 1,
      units: o.units,
      earnings,
    });
  };
  for (const o of extraPracticeOrders) {
    wholesaleRow(practiceBucket(o.practice), o, "", "(Wholesale - practice-level order)");
  }
  for (const o of extraClinicOrders) {
    const pid = o.practice || byClinic[o.clinic]?.practiceId || practiceOfClinic[o.clinic] || "";
    wholesaleRow(practiceBucket(pid), o, o.clinic, "(Wholesale - clinic-level order)");
  }
  out.practices = Object.values(byPractice)
    .map((p) => {
      p.conversion = p.writtenProtocols ? Math.round((p.completedProtocols / p.writtenProtocols) * 100) : 0;
      p.rows.sort(
        (a, b) =>
          (a.clinicName || "").localeCompare(b.clinicName || "") ||
          (a.doctorName || "").localeCompare(b.doctorName || ""),
      );
      return p;
    })
    .sort((a, b) => b.commission - a.commission);

  /* ===== Revenue trend ===== */
  const monthly = days === 0 || days > 90;
  const pad = (n) => ("0" + n).slice(-2);
  const buckets = {};
  for (const o of ordersArr) {
    const d0 = new Date(o.ts);
    const key = monthly
      ? `${d0.getFullYear()}-${pad(d0.getMonth() + 1)}`
      : `${d0.getFullYear()}-${pad(d0.getMonth() + 1)}-${pad(d0.getDate())}`;
    const b = (buckets[key] ||= { sales: 0, orders: 0 });
    b.sales += o.amount;
    b.orders++;
  }
  buildSeries(out, days, now, monthly, buckets);

  ordersArr.sort((a, b) => b.ts - a.ts);
  out.orders = ordersArr.slice(0, 100);

  const pay = await repPayouts(rep);
  // this month's commission not paid yet - a payment made mid-month covers
  // only what was earned up to then
  const open = Math.max(0, Math.round((commissionOpen - pay.currentMonthPaidAmount) * 100) / 100);
  out.commission.total = commissionAllTime;
  out.commission.paid = pay.paid;
  out.commission.open = open;
  out.commission.pending = Math.max(0, commissionAllTime - pay.paid - open);
  out.commission.processing = pay.pending;
  out.commission.payments = pay.rows;
  out.banking = await repBankingGet(rep);
  return out;
}

/* ----------------------------- rep banking ------------------------------ */

const BANKING_FIELDS = [
  "bankName",
  "bankRouting",
  "accountNumber",
  "bankAddress1",
  "bankAddress2",
  "bankCity",
  "bankState",
  "bankZip",
  "holderBusinessName",
  "holderAddress1",
  "holderAddress2",
  "holderCity",
  "holderState",
  "holderZip",
  "holderPhone",
];
// Returned masked; a submitted mask never overwrites what is stored.
const BANKING_SECRET_FIELDS = ["accountNumber", "bankRouting"];
const BANKING_REQUIRED = [
  "bankName",
  "bankRouting",
  "accountNumber",
  "bankAddress1",
  "bankCity",
  "bankState",
  "bankZip",
  "holderBusinessName",
  "holderAddress1",
  "holderCity",
  "holderState",
  "holderZip",
  "holderPhone",
];
const MASK = "••••";

const BANKING_LABELS = {
  bankName: "Bank Name",
  bankRouting: "Bank Routing (ACH)",
  accountNumber: "Bank Holder Account Number",
  bankAddress1: "Bank Address 1",
  bankAddress2: "Bank Address 2",
  bankCity: "Bank City",
  bankState: "Bank State",
  bankZip: "Bank Zip / Postal",
  holderBusinessName: "Account Holder Business Name",
  holderAddress1: "Account Holder Address 1",
  holderAddress2: "Account Holder Address 2",
  holderCity: "Account Holder City",
  holderState: "Account Holder State",
  holderZip: "Account Holder Zip / Postal",
  holderPhone: "Account Holder Phone",
};

/* Format rules per field. Mirrors BK_RULES in the rep dashboard section
   (theme sections/rx-rep-dashboard.liquid) - keep both in step. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 &.,'()/-]*$/;
const ADDR_RE = /^[A-Za-z0-9][A-Za-z0-9 #&.,'/-]*$/;
const PLACE_RE = /^[A-Za-z][A-Za-z .'-]*$/;
const ZIP_RE = /^(\d{5}(-\d{4})?|[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d)$/;
const NAME_MSG = "Use letters, numbers, spaces and & . , ' - ( ) / only.";
const ADDR_MSG = "Use letters, numbers, spaces and # & . , ' - / only.";
const PLACE_MSG = "Use letters, spaces and . ' - only.";
const ZIP_MSG = "Enter a valid ZIP (12345 or 12345-6789) or postal code (A1A 1A1).";

function checkText(v, min, max, re, msg, needLetter = false) {
  if (v.length < min) return `Must be at least ${min} characters.`;
  if (v.length > max) return `Must be ${max} characters or fewer.`;
  if (!re.test(v)) return msg;
  if (needLetter && !/[A-Za-z]/.test(v)) return "Must include at least one letter.";
  return "";
}

function checkRouting(v) {
  if (!/^\d{9}$/.test(v)) return "Routing number must be exactly 9 digits.";
  const d = v.split("").map(Number);
  const sum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
  return sum % 10 === 0 ? "" : "This is not a valid ABA routing number. Please check it.";
}

function checkPhone(v) {
  if (!/^[0-9 ()+.-]+$/.test(v)) return "Use numbers and ( ) - + . only.";
  const digits = v.replace(/\D/g, "");
  if (digits.length === 10 || (digits.length === 11 && digits[0] === "1")) return "";
  return "Enter a valid 10-digit phone number.";
}

const BANKING_RULES = {
  bankName: (v) => checkText(v, 2, 100, NAME_RE, NAME_MSG, true),
  bankRouting: checkRouting,
  accountNumber: (v) => (/^\d{4,17}$/.test(v) ? "" : "Account number must be 4-17 digits (numbers only)."),
  bankAddress1: (v) => checkText(v, 3, 100, ADDR_RE, ADDR_MSG, true),
  bankAddress2: (v) => checkText(v, 1, 100, ADDR_RE, ADDR_MSG),
  bankCity: (v) => checkText(v, 2, 50, PLACE_RE, PLACE_MSG),
  bankState: (v) => checkText(v, 2, 50, PLACE_RE, PLACE_MSG),
  bankZip: (v) => (ZIP_RE.test(v) ? "" : ZIP_MSG),
  holderBusinessName: (v) => checkText(v, 2, 100, NAME_RE, NAME_MSG, true),
  holderAddress1: (v) => checkText(v, 3, 100, ADDR_RE, ADDR_MSG, true),
  holderAddress2: (v) => checkText(v, 1, 100, ADDR_RE, ADDR_MSG),
  holderCity: (v) => checkText(v, 2, 50, PLACE_RE, PLACE_MSG),
  holderState: (v) => checkText(v, 2, 50, PLACE_RE, PLACE_MSG),
  holderZip: (v) => (ZIP_RE.test(v) ? "" : ZIP_MSG),
  holderPhone: checkPhone,
};

/** {field: message} for every filled value that fails its format rule.
 *  `kept` = secret fields whose mask was swapped for the stored number -
 *  validated when first saved, so not re-checked. */
export function validateRepBanking(values, kept = {}) {
  const errors = {};
  for (const key of BANKING_FIELDS) {
    const v = values[key];
    if (!v || kept[key]) continue;
    const err = BANKING_RULES[key] ? BANKING_RULES[key](v) : "";
    if (err) errors[key] = err;
  }
  return errors;
}

const labelList = (keys) => keys.map((k) => BANKING_LABELS[k] || k).join(", ");

function mask(v) {
  const s = String(v || "").replace(/\s/g, "");
  if (!s) return "";
  return s.length <= 4 ? s : MASK + s.slice(-4);
}

async function repBankingRaw(rep) {
  await connectDb();
  const row = await Banking.findOne({ ownerType: "rep", ownerId: rep }).lean();
  if (!row) return null;
  return { fields: decryptJson(row.data) || {}, updatedAt: row.updatedAt };
}

/** The rep's banking details with account / routing numbers masked. */
export async function repBankingGet(rep) {
  rep = String(rep || "").trim();
  if (!rep) return null;
  try {
    const raw = await repBankingRaw(rep);
    if (!raw) return null;
    const rec = { updatedAt: raw.updatedAt ? raw.updatedAt.getTime() : 0 };
    for (const key of BANKING_FIELDS) {
      const v = String(raw.fields[key] || "");
      rec[key] = BANKING_SECRET_FIELDS.includes(key) ? mask(v) : v;
    }
    return rec;
  } catch (err) {
    logEvent("error", rep, "rep banking read: " + err, null, false);
    return null;
  }
}

export async function repBankingSave(d, updatedBy = "") {
  const rep = String(d.rep || "").trim();
  if (!rep) return { ok: false, error: "missing rep id" };
  const existing = await repBankingRaw(rep);
  const values = {};
  const kept = {};
  for (const key of BANKING_FIELDS) {
    let v = String(d[key] || "").trim();
    if (BANKING_SECRET_FIELDS.includes(key) && v.startsWith(MASK) && existing) {
      v = String(existing.fields[key] || ""); // unchanged mask -> keep the stored value
      kept[key] = true;
    }
    values[key] = v;
  }
  const missing = BANKING_REQUIRED.filter((k) => !values[k]);
  if (missing.length) {
    const fields = Object.fromEntries(missing.map((k) => [k, "This field is required."]));
    return { ok: false, fields, error: "Missing required field(s): " + labelList(missing) };
  }
  // `fields` lets the dashboard mark each offending input, not just show one message.
  const invalid = validateRepBanking(values, kept);
  const badKeys = Object.keys(invalid);
  if (badKeys.length) return { ok: false, fields: invalid, error: "Please correct: " + labelList(badKeys) };

  await Banking.updateOne(
    { ownerType: "rep", ownerId: rep },
    { $set: { data: encryptJson(values), updatedBy: String(updatedBy) } },
    { upsert: true },
  );
  logEvent("job", "rep:" + rep, `banking details ${existing ? "updated" : "created"}`);
  return { ok: true, banking: await repBankingGet(rep) };
}
