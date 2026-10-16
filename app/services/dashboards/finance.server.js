import { connectDb } from "../../db.server";
import {
  Account,
  Banking,
  FormEntry,
  MonthlyPayout,
  Order,
  Prescription,
  SalesRep,
} from "../../models/index.server";
import { payoutSplit, setPayoutRecordStatus } from "../commission.server";
import { decryptJson } from "../crypto.server";
import { demoIdSet } from "../ids.server";
import { kvGet, kvSet } from "../log.server";
import { gid, gql } from "../shopify-admin.server";
import { invalidateResponses } from "../response-cache.server";

/* Finance Dashboard backend (was 7-rx-finance-admin).

   Platform-wide: every physician / clinic / practice / rep, what each has
   earned, what has been paid, and the banking details to pay them with.
   Reads the commission ledger frozen on each order and the monthly payout
   summary; the only writes flip a payout row's Status / Date Paid /
   Transaction # - never its amount. Demo accounts are left out everywhere. */

const titleCase = (s) =>
  String(s || "unfulfilled")
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());

function fulfillmentStatusLabel(status) {
  const s = String(status || "").toUpperCase();
  if (s === "FULFILLED") return "Delivered";
  if (s === "PARTIALLY_FULFILLED" || s === "PARTIAL" || s === "IN_PROGRESS") return "Shipped";
  return "Not Shipped";
}

/** Stored banking fields (either dashboard's key style) -> the row shape the
 *  finance Banking tab reads. */
function bankFieldsToRow(f = {}) {
  const pick = (...keys) => {
    for (const k of keys) if (f[k]) return f[k];
    return "";
  };
  return {
    bankName: pick("bank_name", "bankName"),
    bankRoutingAch: pick("bank_routing_ach", "bankRouting"),
    bankHolderAccountNumber: pick("bank_holder_account_number", "accountNumber"),
    bankAddress1: pick("bank_address_1", "bankAddress1"),
    bankAddress2: pick("bank_address_2", "bankAddress2"),
    bankCity: pick("bank_city", "bankCity"),
    bankState: pick("bank_state", "bankState"),
    bankZipPostal: pick("bank_zip_postal", "bankZip"),
    accountHolderBusinessName: pick("account_holder_business_name", "holderBusinessName"),
    accountHolderAddress1: pick("account_holder_address_1", "holderAddress1"),
    accountHolderAddress2: pick("account_holder_address_2", "holderAddress2"),
    accountHolderCity: pick("account_holder_city", "holderCity"),
    accountHolderState: pick("account_holder_state", "holderState"),
    accountHolderZipPostal: pick("account_holder_zip_postal", "holderZip"),
    accountHolderPhone: pick("account_holder_phone", "holderPhone"),
  };
}

const ackKey = (type, id) => `bankack:${type}|${id}`;

/** Marks an entity's current banking details as reviewed by finance. */
export async function ackBankingChange(entityType, entityId, atTs) {
  await kvSet(ackKey(entityType, entityId), typeof atTs === "number" ? atTs : Date.now());
}

export async function financeDashboard(p) {
  await connectDb();
  const fPractice = String(p.practice || "").trim();
  const fClinic = String(p.clinic || "").trim();
  const fDoctor = String(p.doctor || "").trim();
  const days = Number(p.days) || 0;
  const fromMs = Number(p.from) || 0;
  const toMs = Number(p.to) || 0;
  const cutoff = fromMs > 0 ? fromMs : days > 0 ? Date.now() - days * 86400000 : 0;
  const cutoffTo = toMs > 0 ? toMs : 0;

  // A payout row is a whole-month bucket: keep it when any day of its month
  // falls inside the window.
  const monthInWindow = (mKey) => {
    if (!cutoff && !cutoffTo) return true;
    const m = /^(\d{4})-(\d{1,2})/.exec(String(mKey || ""));
    if (!m) return true;
    const mStart = new Date(Number(m[1]), Number(m[2]) - 1, 1).getTime();
    const mEnd = new Date(Number(m[1]), Number(m[2]), 1).getTime() - 1;
    if (cutoff && mEnd < cutoff) return false;
    if (cutoffTo && mStart > cutoffTo) return false;
    return true;
  };

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
  const demo = await demoIdSet();
  const isDemoId = (...ids) => ids.some((id) => id && demo.has(String(id).trim().toLowerCase()));

  /* ---- roster: name / email / phone resolution ---- */
  const roster = (await Account.find({}).lean())
    .map((a) => ({
      name: `${a.first || ""} ${a.last || ""}`.trim(),
      company: String(a.company || "").trim(),
      email: a.email || "",
      phone: a.phone || "",
      doctorId: a.doctorId,
      clinicId: a.clinicId,
      practiceId: a.practiceId,
      repId: a.repId,
      tags: a.tags || [],
    }))
    .filter((c) => !isDemoId(c.doctorId, c.clinicId, c.practiceId));

  const doctorInfo = {};
  const clinicInfo = {};
  const practiceInfo = {};
  const repInfo = {};
  for (const c of roster) {
    if (c.repId) {
      repInfo[c.repId] = { name: c.name || c.repId, email: c.email, phone: c.phone };
    } else if (c.doctorId) {
      doctorInfo[c.doctorId] = { name: c.name, email: c.email, phone: c.phone, clinicId: c.clinicId, practiceId: c.practiceId, company: c.company, tags: c.tags };
    } else if (c.clinicId) {
      clinicInfo[c.clinicId] = { name: c.name || c.company || c.clinicId, practiceId: c.practiceId };
    } else if (c.practiceId) {
      practiceInfo[c.practiceId] = { name: c.name || c.company || c.practiceId };
    }
  }
  const salesReps = await SalesRep.find({}).lean();
  for (const r of salesReps) {
    repInfo[r.repId] ||= { name: r.name || r.repId, email: r.email || "", phone: r.phone || "" };
  }
  const repName = (id) => (id ? repInfo[id]?.name || id : "");

  // Fallback names for practices / clinics with no account of their own: the
  // company (then the personal name) of any account tagged with that id.
  const practiceNameByPid = {};
  const clinicNameByCid = {};
  for (const c of roster) {
    const label = c.company || c.name || "";
    if (!label) continue;
    if (c.practiceId && !practiceInfo[c.practiceId] && !practiceNameByPid[c.practiceId]) practiceNameByPid[c.practiceId] = label;
    if (c.clinicId && !clinicInfo[c.clinicId] && !clinicNameByCid[c.clinicId]) clinicNameByCid[c.clinicId] = label;
  }
  const practiceName = (id) => (id ? practiceInfo[id]?.name || practiceNameByPid[id] || id : "");
  const clinicName = (id) => (id ? clinicInfo[id]?.name || clinicNameByCid[id] || id : "");
  const clinicPracticeId = (clinicId) => clinicInfo[clinicId]?.practiceId || "";
  const doctorName = (id) => (id ? doctorInfo[id]?.name || id : "");

  /* ---- the transaction-level ledger ---- */
  const byDoc = {};
  const byClinic = {};
  const byPrac = {};
  const byRep = {};
  const orders = [];
  const totals = { revenueAllTime: 0, revenueThisMonth: 0, revenueLastMonth: 0, ordersAllTime: 0, ordersThisMonth: 0 };
  const money = () => ({ orders: 0, revenue: 0, earned: 0, paid: 0, pending: 0 });

  const ensureDoc = (id) => {
    if (!byDoc[id]) {
      const info = doctorInfo[id] || {};
      byDoc[id] = { id, name: info.name || id, email: info.email || "", phone: info.phone || "", clinicId: info.clinicId || "", practiceId: info.practiceId || "", ...money() };
    }
    return byDoc[id];
  };
  const ensureClinic = (id) =>
    (byClinic[id] ||= { id, name: clinicName(id), practiceId: clinicPracticeId(id), doctorSet: {}, ...money() });
  const ensurePrac = (id) =>
    (byPrac[id] ||= { id, name: practiceName(id), clinicSet: {}, doctorSet: {}, rowsMap: {}, ...money() });
  const ensureRep = (id) => (byRep[id] ||= { id, name: repName(id), practices: [], ...money() });

  const logged = await Order.find(
    { "commission.logged": true, "commission.status": { $ne: "Deleted" }, demo: { $ne: true } },
    { name: 1, orderCreatedAt: 1, commission: 1, deliveryStatus: 1, total: 1 },
  ).lean();
  const ledger = logged.filter(
    (o) => !isDemoId(o.commission.doctorId, o.commission.clinicId, o.commission.practiceId),
  );

  // Last-resort practice names: a solo practice takes its one physician's name.
  {
    const seen = {};
    for (const o of ledger) {
      const pid = o.commission.practiceId;
      if (!pid || practiceInfo[pid] || practiceNameByPid[pid]) continue;
      const s = (seen[pid] ||= { clinics: new Set(), doctors: new Set() });
      if (o.commission.clinicId) s.clinics.add(o.commission.clinicId);
      if (o.commission.doctorId) s.doctors.add(o.commission.doctorId);
    }
    for (const [pid, s] of Object.entries(seen)) {
      const cids = [...s.clinics];
      const dids = [...s.doctors];
      const soloClinic = cids.length === 0 || (cids.length === 1 && !clinicInfo[cids[0]]);
      if (soloClinic && dids.length === 1 && doctorInfo[dids[0]]?.name) {
        practiceNameByPid[pid] = doctorInfo[dids[0]].name;
      }
    }
  }

  const ledgerNames = new Set();
  for (const o of ledger) {
    ledgerNames.add(o.name);
    const ts = o.orderCreatedAt ? o.orderCreatedAt.getTime() : 0;
    if ((cutoff && ts < cutoff) || (cutoffTo && ts > cutoffTo)) continue;
    const c = o.commission;
    const { doctorId, clinicId, practiceId } = c;
    if (fPractice && practiceId !== fPractice) continue;
    if (fClinic && clinicId !== fClinic) continue;
    if (fDoctor && doctorId !== fDoctor) continue;
    const lineTotal = c.doctorAmt + c.clinicAmt + c.practiceAmt;

    totals.ordersAllTime++;
    totals.revenueAllTime += lineTotal;
    if (ts >= monthStart) {
      totals.ordersThisMonth++;
      totals.revenueThisMonth += lineTotal;
    } else if (ts >= lastMonthStart && ts < monthStart) {
      totals.revenueLastMonth += lineTotal;
    }

    if (doctorId) {
      const d = ensureDoc(doctorId);
      d.orders++;
      d.revenue += lineTotal;
      d.earned += c.doctorAmt;
      if (!d.clinicId && clinicId) d.clinicId = clinicId;
      if (!d.practiceId && practiceId) d.practiceId = practiceId;
    }
    if (clinicId) {
      const cl = ensureClinic(clinicId);
      cl.orders++;
      cl.revenue += lineTotal;
      cl.earned += c.clinicAmt;
      if (doctorId) cl.doctorSet[doctorId] = true;
    }
    if (practiceId) {
      const pr = ensurePrac(practiceId);
      pr.orders++;
      pr.revenue += lineTotal;
      pr.earned += c.practiceAmt;
      if (clinicId) pr.clinicSet[clinicId] = true;
      if (doctorId) pr.doctorSet[doctorId] = true;
      const rowKey = `${clinicId || "(none)"}|${doctorId || "(none)"}`;
      const row = (pr.rowsMap[rowKey] ||= {
        clinicId,
        clinicName: clinicId ? clinicName(clinicId) : "",
        doctorId,
        doctorName: doctorId ? doctorName(doctorId) : "",
        ...money(),
      });
      row.orders++;
      row.revenue += lineTotal;
      row.earned += c.doctorAmt;
    }
    if (c.repId) {
      const rp = ensureRep(c.repId);
      rp.orders++;
      rp.revenue += lineTotal;
      rp.earned += c.repAmt;
    }
    orders.push({
      order: o.name,
      ts,
      doctorId,
      doctorName: doctorName(doctorId),
      clinicId,
      clinicName: clinicId ? clinicName(clinicId) : "",
      practiceId,
      practiceName: practiceId ? practiceName(practiceId) : "",
      doctorAmount: c.doctorAmt,
      clinicAmount: c.clinicAmt,
      practiceAmount: c.practiceAmt,
      total: o.total || lineTotal,
      deliveryStatus: o.deliveryStatus || "Not Shipped",
    });
  }

  // Every roster physician / rep appears even with zero orders yet.
  for (const [id, info] of Object.entries(doctorInfo)) {
    if (fDoctor && id !== fDoctor) continue;
    if (fClinic && info.clinicId !== fClinic) continue;
    if (fPractice && info.practiceId !== fPractice) continue;
    ensureDoc(id);
  }
  Object.keys(repInfo).forEach(ensureRep);

  /* ---- monthly payout summary: paid / pending ---- */
  const commission = {
    total: 0, paid: 0, pending: 0,
    physicianTotal: 0, physicianPaid: 0, physicianPending: 0,
    clinicTotal: 0, clinicPaid: 0, clinicPending: 0,
    practiceTotal: 0, practicePaid: 0, practicePending: 0,
    repTotal: 0, repPaid: 0, repPending: 0,
  };
  const payouts = [];
  const bucketKey = { Doctor: "physician", Clinic: "clinic", Practice: "practice", Rep: "rep" };
  for (const r of await MonthlyPayout.find({}).lean()) {
    if (!monthInWindow(r.month)) continue;
    const role = String(r.role || "").trim();
    const id = String(r.entityId || "").trim();
    const amount = Number(r.amount) || 0;
    if (!id || !amount) continue;
    if (isDemoId(id)) continue;
    if (role === "Doctor" && fDoctor && id !== fDoctor) continue;
    if (role === "Clinic" && fClinic && id !== fClinic) continue;
    if (role === "Practice" && fPractice && id !== fPractice) continue;
    if (role === "Doctor" && fPractice && doctorInfo[id]?.practiceId !== fPractice) continue;
    if (role === "Clinic" && fPractice && clinicPracticeId(id) !== fPractice) continue;

    // each payout record is all paid or all owed; commission logged after
    // a month was paid sits on a new record of that month
    const { paid, due } = payoutSplit(r);
    if (role !== "Rep") {
      commission.total += amount;
      commission.paid += paid;
      commission.pending += due;
    }
    const k = bucketKey[role];
    if (k) {
      commission[k + "Total"] += amount;
      commission[k + "Paid"] += paid;
      commission[k + "Pending"] += due;
      const target =
        role === "Doctor" ? ensureDoc(id) : role === "Clinic" ? ensureClinic(id) : role === "Practice" ? ensurePrac(id) : ensureRep(id);
      target.paid += paid;
      target.pending += due;
    }
    const name =
      role === "Doctor" ? doctorName(id) : role === "Clinic" ? clinicName(id) : role === "Practice" ? practiceName(id) : role === "Rep" ? repName(id) : id;
    payouts.push({
      month: r.month,
      seq: r.seq || 0, // which record of that month - sent back on Mark paid / Undo
      role,
      id,
      name,
      amount,
      status: paid > 0 ? "Paid" : "Pending",
      datePaid: r.datePaid || "",
      confirmationNum: r.transactionNo || "",
    });
  }
  payouts.sort((a, b) => b.month.localeCompare(a.month) || b.seq - a.seq);

  /* ---- banking ---- */
  const bankByType = { practice: {}, clinic: {}, rep: {}, physician: {} };
  for (const b of await Banking.find({}).lean()) {
    if (isDemoId(b.ownerId)) continue;
    let fields = {};
    try {
      fields = decryptJson(b.data) || {};
    } catch {
      fields = {};
    }
    (bankByType[b.ownerType] ||= {})[b.ownerId] = {
      updatedAt: b.updatedAt ? b.updatedAt.toISOString() : "",
      fields,
    };
  }
  const banking = [];
  const practiceIds = new Set([
    ...Object.keys(byPrac),
    ...Object.keys(practiceInfo),
    ...Object.keys(bankByType.practice),
  ]);
  for (const pid of [...practiceIds].sort()) {
    if (fPractice && pid !== fPractice) continue;
    const m = bankByType.practice[pid];
    const base = { entityType: "Practice", role: "Practice", practiceId: pid, name: practiceName(pid), practiceName: practiceName(pid) };
    banking.push(m ? { ...base, found: true, updatedAt: m.updatedAt, source: "app", ...bankFieldsToRow(m.fields) } : { ...base, found: false });
  }
  for (const cid of Object.keys(bankByType.clinic).sort()) {
    if (fClinic && cid !== fClinic) continue;
    if (fPractice && clinicPracticeId(cid) !== fPractice) continue;
    const m = bankByType.clinic[cid];
    banking.push({
      entityType: "Clinic", role: "Clinic", clinicId: cid, practiceId: clinicPracticeId(cid),
      name: clinicName(cid), clinicName: clinicName(cid),
      found: true, updatedAt: m.updatedAt, source: "app", ...bankFieldsToRow(m.fields),
    });
  }
  if (!fPractice && !fClinic && !fDoctor) {
    for (const rid of Object.keys(bankByType.rep).sort()) {
      const m = bankByType.rep[rid];
      banking.push({
        entityType: "Rep", role: "Rep", repId: rid, name: repName(rid), repName: repName(rid),
        found: true, updatedAt: m.updatedAt, source: "app", ...bankFieldsToRow(m.fields),
      });
    }
  }

  // "Changed since finance last reviewed it". First sighting is recorded as
  // the baseline, so only later edits are flagged.
  const bankingChanges = { new: [], changed: [] };
  for (const b of banking) {
    if (!b.found || !b.updatedAt) continue;
    const ts = new Date(b.updatedAt).getTime();
    const eid = b.practiceId || b.clinicId || b.repId || "";
    if (isNaN(ts) || !eid) continue;
    const ackTs = await kvGet(ackKey(b.entityType, eid));
    if (ackTs == null) {
      await ackBankingChange(b.entityType, eid, ts);
      continue;
    }
    if (ackTs >= ts) continue;
    bankingChanges.changed.push({ entityId: eid, entityName: b.name || eid, entityType: b.entityType, fields: [] });
  }

  /* ---- still-open prescriptions, for the Conversion column ---- */
  const openByDoc = {};
  const openByClinic = {};
  const openByPrac = {};
  {
    const q = { status: { $ne: "Purchased" }, purchasedAt: null, demo: { $ne: true } };
    if (cutoff || cutoffTo) {
      q.createdAt = {};
      if (cutoff) q.createdAt.$gte = new Date(cutoff);
      if (cutoffTo) q.createdAt.$lte = new Date(cutoffTo);
    }
    if (fPractice) q.practiceId = fPractice;
    if (fClinic) q.clinicId = fClinic;
    if (fDoctor) q.doctorId = fDoctor;
    const rxs = await Prescription.find(q, { doctorId: 1, clinicId: 1, practiceId: 1 }).lean();
    for (const r of rxs) {
      if (isDemoId(r.doctorId, r.clinicId, r.practiceId)) continue;
      if (r.doctorId) openByDoc[r.doctorId] = (openByDoc[r.doctorId] || 0) + 1;
      if (r.clinicId) openByClinic[r.clinicId] = (openByClinic[r.clinicId] || 0) + 1;
      if (r.practiceId) openByPrac[r.practiceId] = (openByPrac[r.practiceId] || 0) + 1;
    }
  }

  /* ---- solo (physician-owned) practices: one physician, no Practice Master
     and no clinic with its own account - shown once, as a Practice ---- */
  const rosterDocsByPrac = {};
  const rosterClinicPracs = {};
  for (const [did, info] of Object.entries(doctorInfo)) {
    if (info.practiceId) (rosterDocsByPrac[info.practiceId] ||= {})[did] = true;
  }
  for (const info of Object.values(clinicInfo)) {
    if (info.practiceId) rosterClinicPracs[info.practiceId] = true;
  }
  const soloPracIds = {};
  const soloDocIds = {};
  const soloClinicIds = {};
  for (const [pid, pr] of Object.entries(byPrac)) {
    if (practiceInfo[pid] || rosterClinicPracs[pid]) continue;
    const dids = Object.keys({ ...(rosterDocsByPrac[pid] || {}), ...pr.doctorSet });
    if (dids.length !== 1) continue;
    const cids = Object.keys(pr.clinicSet);
    if (cids.some((cid) => !!clinicInfo[cid])) continue;
    soloPracIds[pid] = true;
    soloDocIds[dids[0]] = true;
    cids.forEach((cid) => (soloClinicIds[cid] = true));
    const ownCid = doctorInfo[dids[0]]?.clinicId;
    if (ownCid && !clinicInfo[ownCid]) soloClinicIds[ownCid] = true;
  }

  /* ---- assemble ---- */
  const physicians = Object.values(byDoc)
    .map((d) => ({
      id: d.id, name: d.name, email: d.email, phone: d.phone,
      clinicId: d.clinicId, clinicName: d.clinicId ? clinicName(d.clinicId) : "",
      practiceId: d.practiceId, practiceName: d.practiceId ? practiceName(d.practiceId) : "",
      orders: d.orders, revenue: d.revenue, earned: d.earned, paid: d.paid, pending: d.pending,
      purchasedProtocols: d.orders, created: d.orders + (openByDoc[d.id] || 0),
      inSoloPractice: !!soloDocIds[d.id],
    }))
    .sort((a, b) => b.earned - a.earned);

  const clinics = Object.values(byClinic)
    .map((c) => ({
      id: c.id, name: c.name, practiceId: c.practiceId,
      practiceName: c.practiceId ? practiceName(c.practiceId) : "",
      doctorCount: Object.keys(c.doctorSet).length,
      orders: c.orders, revenue: c.revenue, earned: c.earned, paid: c.paid, pending: c.pending,
      purchasedProtocols: c.orders, created: c.orders + (openByClinic[c.id] || 0),
      inSoloPractice: !!soloClinicIds[c.id],
    }))
    .sort((a, b) => b.earned - a.earned);

  const practices = Object.values(byPrac)
    .map((pr) => {
      const rows = Object.values(pr.rowsMap)
        .map((row) => {
          const src = row.doctorId ? byDoc[row.doctorId] : row.clinicId ? byClinic[row.clinicId] : null;
          row.paid = src ? src.paid : 0;
          row.pending = src ? src.pending : 0;
          return row;
        })
        .sort((a, b) => b.revenue - a.revenue);
      return {
        id: pr.id, name: pr.name,
        clinicCount: Object.keys(pr.clinicSet).length, doctorCount: Object.keys(pr.doctorSet).length,
        orders: pr.orders, revenue: pr.revenue, earned: pr.earned, paid: pr.paid, pending: pr.pending,
        rows, purchasedProtocols: pr.orders, created: pr.orders + (openByPrac[pr.id] || 0),
        isSolo: !!soloPracIds[pr.id],
      };
    })
    .sort((a, b) => b.revenue - a.revenue);

  const docsByPractice = {};
  for (const info of Object.values(doctorInfo)) {
    if (info.practiceId) docsByPractice[info.practiceId] = (docsByPractice[info.practiceId] || 0) + 1;
  }

  // New-client referrals submitted by each rep (Sales Referral form).
  const referrals = { byName: {}, byEmail: {} };
  {
    const q = { form: "referral" };
    if (cutoff || cutoffTo) {
      q.createdAt = {};
      if (cutoff) q.createdAt.$gte = new Date(cutoff);
      if (cutoffTo) q.createdAt.$lte = new Date(cutoffTo);
    }
    for (const f of await FormEntry.find(q, { data: 1 }).lean()) {
      const nm = String(f.data?.repName || "").trim().toLowerCase();
      const em = String(f.data?.repEmail || "").trim().toLowerCase();
      if (nm) referrals.byName[nm] = (referrals.byName[nm] || 0) + 1;
      if (em) referrals.byEmail[em] = (referrals.byEmail[em] || 0) + 1;
    }
  }
  const assignedByRep = Object.fromEntries(salesReps.map((r) => [r.repId, r.assignedPracticeIds || []]));
  const reps = Object.values(byRep)
    .map((rp) => {
      const repPractices = (assignedByRep[rp.id] || [])
        .filter((x) => !/^CLN/i.test(String(x)))
        .map((pid) => {
          const pr = byPrac[pid];
          const doctorCount = pr ? Object.keys(pr.doctorSet).length : 0;
          const clinicCount = pr ? Object.keys(pr.clinicSet).length : 0;
          return {
            id: pid, name: practiceName(pid),
            orders: pr ? pr.orders : 0, revenue: pr ? pr.revenue : 0,
            totalPhysicians: docsByPractice[pid] || 0,
            isPhysicianOwned: doctorCount === 1 && clinicCount === 0,
          };
        });
      const sum = (k) => repPractices.reduce((s, pr) => s + pr[k], 0);
      const repEmail = String(repInfo[rp.id]?.email || "").toLowerCase();
      return {
        id: rp.id, name: rp.name, orders: sum("orders"), revenue: sum("revenue"),
        newClients: referrals.byEmail[repEmail] || referrals.byName[String(rp.name || "").toLowerCase()] || 0,
        totalPhysicians: sum("totalPhysicians"),
        earned: rp.earned, paid: rp.paid, pending: rp.pending, practices: repPractices,
      };
    })
    .sort((a, b) => b.earned - a.earned);

  const totalsOut = {
    ...totals,
    physicianCount: physicians.length,
    clinicCount: clinics.length,
    practiceCount: practices.length,
    repCount: reps.length,
  };

  /* ---- every store order in the window (not only ledger ones) ---- */
  if (!fPractice && !fClinic && !fDoctor) {
    const q = { deletedAt: null, demo: { $ne: true }, tags: { $ne: "rx_demo" } };
    if (cutoff || cutoffTo) {
      q.orderCreatedAt = {};
      if (cutoff) q.orderCreatedAt.$gte = new Date(cutoff);
      if (cutoffTo) q.orderCreatedAt.$lte = new Date(cutoffTo);
    }
    const all = await Order.find(q, { name: 1, orderCreatedAt: 1, total: 1, fulfillmentStatus: 1 })
      .sort({ orderCreatedAt: -1 })
      .limit(5000)
      .lean();
    let revenue = 0;
    const inWindow = new Set(orders.map((o) => o.order));
    for (const o of all) {
      revenue += o.total || 0;
      if (inWindow.has(o.name) || ledgerNames.has(o.name)) continue;
      orders.push({
        order: o.name,
        ts: o.orderCreatedAt ? o.orderCreatedAt.getTime() : 0,
        doctorId: "", doctorName: "", clinicId: "", clinicName: "", practiceId: "", practiceName: "",
        doctorAmount: 0, clinicAmount: 0, practiceAmount: 0,
        total: o.total || 0,
        deliveryStatus: fulfillmentStatusLabel(o.fulfillmentStatus),
        notInLedger: true,
      });
    }
    totalsOut.ordersAllTime = all.length;
    totalsOut.shopifyOrdersCount = all.length;
    totalsOut.shopifyOrdersRevenue = revenue;
  }
  orders.sort((a, b) => b.ts - a.ts);

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    totals: totalsOut,
    commission,
    physicians,
    clinics,
    practices,
    reps,
    orders,
    payouts,
    banking,
    bankingChanges,
    doctorOptions: physicians.map((d) => ({ id: d.id, name: d.name, clinicId: d.clinicId, practiceId: d.practiceId })),
    clinicOptions: clinics.map((c) => ({ id: c.id, name: c.name, practiceId: c.practiceId })),
    practiceOptions: practices.map((x) => ({ id: x.id, name: x.name })),
  };
}

/* ------------------------------ order detail ---------------------------- */

const attrMap = (list) => Object.fromEntries((list || []).filter((a) => a?.key).map((a) => [a.key, a.value]));
const amt = (set) => Number(set?.shopMoney?.amount) || 0;
const addr = (a) =>
  a && {
    name: a.name || "",
    address1: a.address1 || "",
    address2: a.address2 || "",
    city: a.city || "",
    province: a.province || a.provinceCode || "",
    zip: a.zip || "",
    country: a.country || "",
    phone: a.phone || "",
  };

/** The full order for the Orders tab's click-through popup. */
export async function financeOrderDetail(p) {
  let orderName = String(p.order || "").trim();
  if (!orderName) return { ok: false, error: "order is required" };
  if (orderName.charAt(0) !== "#") orderName = "#" + orderName;
  await connectDb();
  const doc = await Order.findOne({ name: orderName }).lean();
  if (!doc) return { ok: false, error: `Order ${orderName} not found.` };

  let o = null;
  try {
    const data = await gql(
      `#graphql
      query RxFinanceOrder($id: ID!) {
        order(id: $id) {
          name createdAt closedAt cancelledAt test note tags currencyCode
          displayFinancialStatus displayFulfillmentStatus
          customAttributes { key value }
          customer { firstName lastName email phone }
          shippingAddress { name address1 address2 city province provinceCode zip country phone }
          billingAddress { name address1 address2 city province provinceCode zip country phone }
          subtotalPriceSet { shopMoney { amount } }
          totalShippingPriceSet { shopMoney { amount } }
          totalTaxSet { shopMoney { amount } }
          totalPriceSet { shopMoney { amount } }
          totalOutstandingSet { shopMoney { amount } }
          lineItems(first: 100) {
            nodes { title sku quantity originalUnitPriceSet { shopMoney { amount } } customAttributes { key value } }
          }
          fulfillments(first: 10) {
            status displayStatus createdAt trackingInfo(first: 3) { number url company }
          }
        }
      }`,
      { id: gid.order(doc.orderId) },
    );
    o = data.order;
  } catch {
    o = null;
  }

  const c = doc.commission || {};
  const ledger = {
    doctorId: c.doctorId || doc.doctorId,
    clinicId: c.clinicId || doc.clinicId,
    practiceId: c.practiceId || doc.practiceId,
    doctorAmount: c.doctorAmt || 0,
    clinicAmount: c.clinicAmt || 0,
    practiceAmount: c.practiceAmt || 0,
    deliveryStatus: doc.deliveryStatus || "Not Shipped",
  };

  if (!o) {
    // Shopify could not return it (deleted, or older than the app may read):
    // show what is on record locally.
    return {
      ok: true,
      order: {
        name: doc.name,
        createdAt: doc.orderCreatedAt?.toISOString() || "",
        closed: false,
        cancelled: !!doc.cancelledAt,
        test: false,
        financialStatus: titleCase(doc.financialStatus),
        fulfillmentStatus: titleCase(doc.fulfillmentStatus),
        note: "",
        tags: doc.tags || [],
        attributes: doc.noteAttributes || {},
        customer: doc.customer?.id
          ? { name: [doc.customer.first, doc.customer.last].filter(Boolean).join(" "), email: doc.customer.email, phone: doc.customer.phone }
          : null,
        shippingAddress: null,
        billingAddress: null,
        currency: doc.currency,
        subtotal: doc.subtotal,
        shipping: doc.totalShipping,
        tax: doc.totalTax,
        total: doc.total,
        paid: doc.financialStatus === "paid" ? doc.total : 0,
        lineItems: (doc.lineItems || []).map((li) => ({
          title: li.title, sku: li.sku, quantity: li.quantity,
          unitPrice: li.price, total: li.price * li.quantity, properties: li.properties || {},
        })),
        fulfillments: [],
        ...ledger,
        summaryOnly: true,
        summaryReason: "Showing the copy on record in the portal database - the live Shopify order could not be loaded.",
      },
    };
  }

  const total = amt(o.totalPriceSet);
  return {
    ok: true,
    order: {
      name: o.name,
      createdAt: o.createdAt,
      closed: !!o.closedAt,
      cancelled: !!o.cancelledAt,
      test: !!o.test,
      financialStatus: titleCase(o.displayFinancialStatus),
      fulfillmentStatus: titleCase(o.displayFulfillmentStatus),
      note: o.note || "",
      tags: o.tags || [],
      attributes: attrMap(o.customAttributes),
      customer: o.customer
        ? { name: [o.customer.firstName, o.customer.lastName].filter(Boolean).join(" "), email: o.customer.email || "", phone: o.customer.phone || "" }
        : null,
      shippingAddress: addr(o.shippingAddress),
      billingAddress: addr(o.billingAddress),
      currency: o.currencyCode || "",
      subtotal: amt(o.subtotalPriceSet),
      shipping: amt(o.totalShippingPriceSet),
      tax: amt(o.totalTaxSet),
      total,
      paid: Math.max(0, total - amt(o.totalOutstandingSet)),
      lineItems: (o.lineItems?.nodes || []).map((li) => {
        const unit = amt(li.originalUnitPriceSet);
        return { title: li.title || "", sku: li.sku || "", quantity: li.quantity || 0, unitPrice: unit, total: unit * (li.quantity || 0), properties: attrMap(li.customAttributes) };
      }),
      fulfillments: (o.fulfillments || []).map((f) => ({
        status: titleCase(f.displayStatus || f.status),
        createdAt: f.createdAt || "",
        trackingNumber: f.trackingInfo?.[0]?.number || "",
        trackingUrl: f.trackingInfo?.[0]?.url || "",
        trackingCompany: f.trackingInfo?.[0]?.company || "",
      })),
      ...ledger,
    },
  };
}

/* ---------------------------- payout status ----------------------------- */

const normMonthKey = (v) => {
  const m = /^(\d{4})-(\d{1,2})/.exec(String(v || "").trim());
  return m ? `${m[1]}-${("0" + m[2]).slice(-2)}` : String(v || "").trim();
};

/** Mark paid / Undo on ONE payout record (`seq` picks the record of that
 *  month; without it Paid = the open record, Pending = the latest paid
 *  one). Undo puts the record's whole amount back to Pending. */
export async function setPayoutStatus(body) {
  invalidateResponses();
  await connectDb();
  const month = normMonthKey(body.month);
  const role = String(body.role || "").trim();
  const id = String(body.id || "").trim();
  const status = String(body.status || "").trim();
  if (!month || !role || !id) return { ok: false, error: "month, role, and id are required" };
  if (status !== "Paid" && status !== "Pending") return { ok: false, error: "status must be Paid or Pending" };

  const res = await setPayoutRecordStatus({ month, role, entityId: id, seq: body.seq }, status, {
    datePaid: body.datePaid,
    transactionNo: body.confirmationNum,
  });
  if (!res.ok) return { ok: false, error: `${res.error} (${month} / ${role} / ${id})` };
  const row = res.row;
  const ackType = String(body.ackEntityType || "").trim();
  const ackId = String(body.ackEntityId || "").trim();
  if (status === "Paid" && ackType && ackId) await ackBankingChange(ackType, ackId);
  return { ok: true, month, role, id, seq: row.seq || 0, status: row.status, amount: row.amount, merged: !!res.merged };
}

/**
 * Bulk sibling of setPayoutStatus: the edited rows of the Payouts tab's CSV
 * download. Row identity = Month + Role + ID; every other column is ignored.
 * Per row: 'updated', 'not_found' or 'skipped' (missing key / no readable
 * status - such a row is left exactly as it was).
 */
export async function uploadPayoutsCsv(body) {
  await connectDb();
  const rows = body?.rows || [];
  if (!rows.length) return { ok: false, error: "no rows in upload" };
  const results = [];
  for (const r of rows) {
    const period = normMonthKey(r.period);
    const role = String(r.role || "").trim();
    const id = String(r.id || "").trim();
    const rec = { period, role, id, result: "skipped" };
    results.push(rec);
    if (!period || !role || !id) continue;
    let status = String(r.status || "").trim().toLowerCase();
    if (status === "paid") status = "Paid";
    else if (status === "pending") status = "Pending";
    else continue;
    const row = await MonthlyPayout.findOne({ month: period, role: new RegExp(`^${role}$`, "i"), entityId: id }, { role: 1 }).lean();
    if (!row) {
      rec.result = "not_found";
      continue;
    }
    // same as the Mark paid / Undo buttons; Seq (when the CSV has it) picks the record
    const res = await setPayoutRecordStatus({ month: period, role: row.role, entityId: id, seq: r.seq }, status, {
      datePaid: r.datePaid,
      transactionNo: r.confirmationNum,
    });
    rec.result = res.ok ? "updated" : "not_found";
  }
  return { ok: true, results };
}
