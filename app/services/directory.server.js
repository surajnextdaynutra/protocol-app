import { connectDb } from "../db.server";
import { Account } from "../models/index.server";
import { tagVal } from "./ids.server";
import { escQ, gql } from "./shopify-admin.server";

/* Who belongs to whom: the Practice -> Clinic -> Doctor tree and the display
   names of each. Read from the local `accounts` collection (kept current by
   the customers/* webhooks), so these are index lookups instead of a Shopify
   customer search on every dashboard load. Until the first account sync has
   run, falls back to asking Shopify directly. */

const personName = (c) => [c.first, c.last].filter(Boolean).join(" ");

let accountsReady = null;
let accountsReadyAt = 0;
async function hasAccounts() {
  if (accountsReady && Date.now() - accountsReadyAt < 60_000) return true;
  await connectDb();
  accountsReady = (await Account.estimatedDocumentCount()) > 0;
  accountsReadyAt = Date.now();
  return accountsReady;
}

/** Wholesale (portal) customers carrying one of the given role-id tags. */
async function wholesaleCustomers(field, ids) {
  ids = [...new Set((Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean))];
  if (!ids.length) return [];

  if (await hasAccounts()) {
    const key = field === "clinicId" ? { $or: [{ clinicId: { $in: ids } }, { clinicIds: { $in: ids } }] } : { [field]: { $in: ids } };
    const rows = await Account.find({ wholesale: true, ...key }).lean();
    return rows.map((a) => ({
      first: a.first,
      last: a.last,
      email: a.email,
      company: a.company || "",
      doctorId: a.doctorId,
      clinicId: a.clinicId,
      practiceId: a.practiceId,
      customerId: a.customerId,
    }));
  }

  const prefix = { doctorId: "doctor_id:", clinicId: "clinic_id:", practiceId: "practice_id:" }[field];
  const clause = ids.map((id) => `tag:'${prefix}${escQ(id)}'`).join(" OR ");
  const data = await gql(
    `#graphql
    query RxDirectory($q: String!) {
      customers(first: 250, query: $q) {
        nodes { legacyResourceId firstName lastName email tags defaultAddress { company } }
      }
    }`,
    { q: `tag:'wholesale' AND (${clause})` },
  );
  return (data.customers?.nodes || []).map((c) => ({
    first: c.firstName || "",
    last: c.lastName || "",
    email: c.email || "",
    company: c.defaultAddress?.company || "",
    doctorId: tagVal(c.tags, "doctor_id:"),
    clinicId: tagVal(c.tags, "clinic_id:"),
    practiceId: tagVal(c.tags, "practice_id:"),
    customerId: String(c.legacyResourceId),
  }));
}

/**
 * The practice's Clinic -> Doctor tree. A customer with clinic_id but NO
 * doctor_id is a clinic account; a customer with doctor_id is a doctor,
 * grouped under the clinic_id they also carry (clinic-less ones land in
 * `unassigned`). A clinic's display name prefers its business name over the
 * login's person name.
 */
export async function practiceStructure(practiceId) {
  const nodes = await wholesaleCustomers("practiceId", practiceId).catch(() => []);
  const clinicsById = {};
  const doctors = [];
  for (const c of nodes) {
    if (c.doctorId) {
      doctors.push({
        id: c.doctorId,
        name: personName(c) || c.doctorId,
        email: c.email || "",
        clinicId: c.clinicId || "",
      });
    } else if (c.clinicId && !clinicsById[c.clinicId]) {
      clinicsById[c.clinicId] = {
        id: c.clinicId,
        name: c.company || personName(c) || c.clinicId,
        email: c.email || "",
        doctors: [],
      };
    }
  }
  const clinics = Object.values(clinicsById);
  const index = Object.fromEntries(clinics.map((c, i) => [c.id, i]));
  const unassigned = [];
  for (const d of doctors) {
    if (d.clinicId) {
      if (!(d.clinicId in index)) {
        clinics.push({ id: d.clinicId, name: d.clinicId, email: "", doctors: [] });
        index[d.clinicId] = clinics.length - 1;
      }
      clinics[index[d.clinicId]].doctors.push({ id: d.id, name: d.name, email: d.email });
    } else {
      unassigned.push({ id: d.id, name: d.name, email: d.email });
    }
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  clinics.sort(byName);
  clinics.forEach((c) => c.doctors.sort(byName));
  unassigned.sort(byName);
  return { clinics, unassigned };
}

/** Distinct physicians sharing this practice. `solo` (<= 1) decides whether a
 *  doctor gets the practice-level tools (pricing, banking) themselves. */
export async function practiceInfo(practiceId) {
  const nodes = await wholesaleCustomers("practiceId", practiceId);
  const seen = new Set();
  const doctors = [];
  let practiceMaster = false;
  for (const c of nodes) {
    // A real Practice Master carries practice_id ALONE (no doctor / clinic id).
    if (!c.doctorId && !c.clinicId) practiceMaster = true;
    if (!c.doctorId || seen.has(c.doctorId)) continue;
    seen.add(c.doctorId);
    doctors.push({ id: c.doctorId, name: personName(c) || c.doctorId });
  }
  doctors.sort((a, b) => a.name.localeCompare(b.name));
  return {
    ok: true,
    practiceId,
    physicianCount: doctors.length,
    practiceMaster,
    solo: doctors.length <= 1,
    // The physician dashboard's stricter rule: one doctor alone is not solo
    // while a separate Practice Master manages the practice.
    soloDoctor: doctors.length <= 1 && !practiceMaster,
    doctors,
  };
}

/** The clinic's own business name ('' when nothing real is on file). */
export async function clinicInfo(clinicId) {
  const nodes = await wholesaleCustomers("clinicId", clinicId);
  // The clinic account itself carries no doctor_id - a doctor under it does.
  const node = nodes.find((c) => !c.doctorId);
  if (!node) return { ok: true, name: "" };
  return { ok: true, name: node.company || personName(node) || "" };
}

/** The Practice Master's business name: the account under this practice_id
 *  that carries neither clinic_id nor doctor_id. */
export async function practiceAccountInfo(practiceId) {
  const nodes = await wholesaleCustomers("practiceId", practiceId);
  const node = nodes.find((c) => !c.doctorId && !c.clinicId);
  if (!node) return { ok: true, name: "" };
  return { ok: true, name: node.company || personName(node) || "" };
}

/** { doctorId: { name, email } } for a set of doctor ids, in one lookup. */
export async function doctorInfo(doctorIds) {
  const ids = doctorIds.filter((id) => id && id !== "(untagged)");
  if (!ids.length) return {};
  const nodes = await wholesaleCustomers("doctorId", ids).catch(() => []);
  const map = {};
  for (const c of nodes) {
    if (c.doctorId) map[c.doctorId] = { name: personName(c), email: c.email || "", clinicId: c.clinicId };
  }
  return map;
}

/** { clinicId: name } for a set of clinic ids. */
export async function clinicNames(clinicIds) {
  const ids = clinicIds.filter((id) => id && id !== "(untagged)");
  if (!ids.length) return {};
  const nodes = await wholesaleCustomers("clinicId", ids).catch(() => []);
  const map = {};
  for (const c of nodes) {
    if (c.doctorId || !c.clinicId || map[c.clinicId]) continue;
    map[c.clinicId] = c.company || personName(c) || c.clinicId;
  }
  return map;
}

/** Doctors assigned to a clinic: [{ id, name, email }]. */
export async function clinicDoctors(clinicId) {
  const nodes = await wholesaleCustomers("clinicId", clinicId).catch(() => []);
  const seen = new Set();
  const out = [];
  for (const c of nodes) {
    if (!c.doctorId || seen.has(c.doctorId)) continue;
    seen.add(c.doctorId);
    out.push({ id: c.doctorId, name: personName(c) || c.doctorId, email: c.email || "" });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every wholesale account a sales rep covers: tagged rep_id:<rep>, or inside
 * one of the practices / clinics assigned to the rep. Returns raw rows with
 * tags, so the caller can split doctors from clinic / practice masters.
 */
export async function repAccounts(repId, assignedIds = []) {
  const practiceIds = assignedIds.filter((id) => !/^CLN/i.test(id));
  const clinicIds = assignedIds.filter((id) => /^CLN/i.test(id));

  if (await hasAccounts()) {
    const or = [{ repId }];
    if (practiceIds.length) or.push({ practiceId: { $in: practiceIds } });
    if (clinicIds.length) or.push({ clinicId: { $in: clinicIds } }, { clinicIds: { $in: clinicIds } });
    const rows = await Account.find({ wholesale: true, $or: or }).lean();
    return rows.map((a) => ({
      first: a.first,
      last: a.last,
      email: a.email,
      phone: a.phone || "",
      company: a.company || "",
      doctorId: a.doctorId,
      clinicId: a.clinicId,
      practiceId: a.practiceId,
      tags: a.tags || [],
    }));
  }

  const clauses = [`tag:'rep_id:${escQ(repId)}'`];
  for (const id of practiceIds) clauses.push(`tag:'practice_id:${escQ(id)}'`);
  for (const id of clinicIds) clauses.push(`tag:'clinic_id:${escQ(id)}'`);
  const data = await gql(
    `#graphql
    query RxRepAccounts($q: String!) {
      customers(first: 250, query: $q) {
        nodes { firstName lastName email phone tags defaultAddress { company } }
      }
    }`,
    { q: `tag:'wholesale' AND (${clauses.join(" OR ")})` },
  );
  return (data.customers?.nodes || []).map((c) => ({
    first: c.firstName || "",
    last: c.lastName || "",
    email: c.email || "",
    phone: c.phone || "",
    company: c.defaultAddress?.company || "",
    doctorId: tagVal(c.tags, "doctor_id:"),
    clinicId: tagVal(c.tags, "clinic_id:"),
    practiceId: tagVal(c.tags, "practice_id:"),
    tags: c.tags || [],
  }));
}
