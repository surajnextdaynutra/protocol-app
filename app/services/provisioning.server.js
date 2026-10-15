import { connectDb } from "../db.server";
import { Account, Counter, DemoAccount, SalesRep } from "../models/index.server";
import { removeAccount, roleFromTags, upsertAccount } from "./accounts.server";
import { ensurePracticeCopies, practiceCopiesStatus, removePracticeCopiesIfUnused } from "./catalog.server";
import { clearDemoCache, idsFromCustomerTags, tagVal } from "./ids.server";
import { kvGet, kvSet, logEvent } from "./log.server";
import { getSettings, isTrue, setSettings } from "./settings.server";
import {
  READ_ONLY,
  createCustomer,
  findCustomerByEmail,
  gid,
  gql,
  shapeCustomer,
  updateCustomer,
} from "./shopify-admin.server";
import { WELCOME_DEFAULT_BODY, WELCOME_DEFAULT_SUBJECT } from "./welcome-default.server";
import { welcomeLinkForRole } from "../components/welcome-link";

/* Creating portal accounts (was the "Customer details" sheet + Shopify
   Customer Sync script, and the "rxmaster id auto generator").

   An admin picks a role and fills in name / email / parent; this creates the
   Shopify customer with the right role tags, generates its ids, keeps the
   sales-rep assignment in step and schedules the welcome email. */

export const ROLES = [
  "Practice",
  "Practice + Doctor",
  "Master Clinic",
  "Clinic",
  "Physician",
  "Sales Rep",
  "Demo",
];

// id prefix per kind (rep ids really are "RAP…").
const PREFIX = { rep: "RAP", practice: "PRA", clinic: "CLN", doctor: "DOC" };
const ID_FIELD = { RAP: "repId", PRA: "practiceId", CLN: "clinicId", DOC: "doctorId" };

/** Highest number already in use for a prefix, across accounts and reps. */
async function highestExisting(prefix) {
  const field = ID_FIELD[prefix];
  const values = [
    ...(await Account.distinct(field, { [field]: new RegExp("^" + prefix + "\\d+$", "i") })),
    ...(prefix === "RAP" ? await SalesRep.distinct("repId", { repId: /^RAP\d+$/i }) : []),
  ];
  return values.reduce((max, v) => Math.max(max, Number(String(v).slice(prefix.length)) || 0), 0);
}

/**
 * Next sequential id, e.g. "PRA43216". The counter is created on first use
 * from the highest id already in the store, so numbering simply continues.
 */
export async function nextId(prefix) {
  await connectDb();
  if (!(await Counter.findById(prefix).lean())) {
    const start = await highestExisting(prefix);
    await Counter.updateOne({ _id: prefix }, { $setOnInsert: { seq: start } }, { upsert: true });
  }
  const row = await Counter.findOneAndUpdate({ _id: prefix }, { $inc: { seq: 1 } }, { new: true }).lean();
  return prefix + row.seq;
}

export async function listCounters() {
  await connectDb();
  const out = [];
  for (const prefix of Object.values(PREFIX)) {
    const row = await Counter.findById(prefix).lean();
    out.push({ prefix, seq: row ? row.seq : await highestExisting(prefix) });
  }
  return out;
}

export async function setCounter(prefix, seq) {
  await connectDb();
  await Counter.updateOne({ _id: prefix }, { $set: { seq: Number(seq) || 0 } }, { upsert: true });
}

/* ---------------------------- sales reps -------------------------------- */

export async function upsertSalesRep(repId, fields = {}) {
  await connectDb();
  const set = {};
  for (const k of ["name", "email", "phone", "customerId", "notes"]) {
    if (fields[k]) set[k] = fields[k];
  }
  await SalesRep.updateOne({ repId }, { $set: set, $setOnInsert: { assignedPracticeIds: [] } }, { upsert: true });
}

/**
 * A sales rep from what was typed / uploaded: RAP id (any case, "rep_id:"
 * prefix ok), the rep's email, or the rep's exact name. Looks at the
 * SalesRep list AND rep accounts (a rep made outside the app may only be a
 * tagged customer). Returns { repId, name, email } or null.
 */
export async function resolveSalesRep(value) {
  const s = String(value || "").trim().replace(/^rep_id:\s*/i, "");
  if (!s) return null;
  await connectDb();
  const lc = s.toLowerCase();
  const exact = new RegExp("^" + lc.replace(/[.*+?^${}()|[\]\\]/g, (ch) => "\\" + ch) + "$", "i");
  const rep = await SalesRep.findOne({ $or: [{ repId: exact }, { email: exact }, { name: exact }] }).lean();
  if (rep) return { repId: rep.repId, name: rep.name, email: rep.email };
  const acct = await Account.findOne({ repId: { $ne: "" }, $or: [{ repId: exact }, { email: exact }] }).lean()
    || (await Account.find({ repId: { $ne: "" } }, { repId: 1, first: 1, last: 1, email: 1 }).lean())
      .find((a) => `${a.first || ""} ${a.last || ""}`.trim().toLowerCase() === lc);
  return acct ? { repId: acct.repId, name: `${acct.first || ""} ${acct.last || ""}`.trim(), email: acct.email } : null;
}

/**
 * A parent practice / clinic from what was picked, typed or uploaded: the id
 * (any case: PRA1, pra1), the tag (practice_id:PRA1 / clinic_id:CLN1), or the
 * email of an account that carries it - a Practice, a Clinic, or a
 * "Practice + Doctor" account (which has a practice AND a clinic id).
 * kind = "practice" | "clinic". Returns { id, practiceId, email } or null.
 */
export async function resolveParent(kind, value) {
  const field = kind === "clinic" ? "clinicId" : "practiceId";
  const s = String(value || "").trim().replace(/^(practice_id|clinic_id):\s*/i, "");
  if (!s) return null;
  await connectDb();
  const exact = new RegExp("^" + s.replace(/[.*+?^${}()|[\]\\]/g, (ch) => "\\" + ch) + "$", "i");
  const has = { [field]: { $ne: "" } };
  const acct = s.includes("@")
    ? await Account.findOne({ email: exact, ...has }).lean()
    // the clinic / practice account itself first, then any account under it
    : (await Account.findOne({ [field]: exact, doctorId: "" }).lean()) || (await Account.findOne({ [field]: exact }).lean());
  return acct ? { id: acct[field], practiceId: acct.practiceId || "", email: acct.email } : null;
}

/** Adds a practice_id (or a practice-less clinic's clinic_id) to a rep. */
export async function assignToRep(repId, assignId) {
  if (!repId || !assignId) return;
  await connectDb();
  // A rep who exists only as a Shopify customer (rep_id: tag - made by the
  // old scripts or in Shopify admin) has no SalesRep record yet: create it
  // from that account, or the assignment below would silently do nothing.
  if (!(await SalesRep.exists({ repId }))) {
    const acct = await Account.findOne({ repId }).lean();
    if (!acct) throw new Error(`sales rep ${repId} not found`);
    await upsertSalesRep(repId, {
      name: `${acct.first || ""} ${acct.last || ""}`.trim() || acct.email,
      email: acct.email,
      customerId: acct.customerId,
    });
  }
  // one practice belongs to one rep - take it off anyone else first
  await SalesRep.updateMany({ repId: { $ne: repId } }, { $pull: { assignedPracticeIds: assignId } });
  await SalesRep.updateOne({ repId }, { $addToSet: { assignedPracticeIds: assignId } });
}

/* ------------------------------ creation -------------------------------- */

/**
 * A physician (doctor_id + clinic_id + practice_id) is what gives a practice
 * its own product copies. Start that copy run now, in the background, rather
 * than leaving it to the next timed product sync - the admin's request
 * returns straight away either way.
 */
function startPracticeCopies(tags) {
  const practiceId = tagVal(tags, "practice_id:");
  if (!practiceId || !tagVal(tags, "doctor_id:") || !tagVal(tags, "clinic_id:")) return;
  // upsertAccount usually queued it already - ensure skips a queued practice
  ensurePracticeCopies(practiceId).catch((err) =>
    logEvent("error", "product-sync", `practice ${practiceId} copies after account create: ${err}`, null, false),
  );
}

/**
 * Role tags for an account, generating whichever ids the role needs.
 * `parent` = { practiceId, clinicId } of the chosen parent account.
 * `reuse` = ids the customer already owns (re-adding an existing customer) -
 * kept instead of generating new ones.
 */
async function buildTags(role, parent, reuse = {}) {
  const id = async (kind, field) => reuse[field] || nextId(PREFIX[kind]);
  switch (role) {
    case "Sales Rep":
      return [`rep_id:${await id("rep", "repId")}`, "wholesale_rep"];
    case "Practice":
      return [`practice_id:${await id("practice", "practiceId")}`, "wholesale"];
    case "Clinic": {
      if (!parent.practiceId) throw new Error("Choose the parent Practice for this clinic.");
      return [`clinic_id:${await id("clinic", "clinicId")}`, `practice_id:${parent.practiceId}`, "wholesale"];
    }
    case "Physician": {
      if (!parent.clinicId) throw new Error("Choose the parent Clinic for this physician.");
      const tags = [`clinic_id:${parent.clinicId}`, `doctor_id:${await id("doctor", "doctorId")}`];
      if (parent.practiceId) tags.push(`practice_id:${parent.practiceId}`);
      return [...tags, "wholesale"];
    }
    case "Practice + Doctor": {
      const practiceId = await id("practice", "practiceId");
      const clinicId = await id("clinic", "clinicId");
      const doctorId = await id("doctor", "doctorId");
      return [`clinic_id:${clinicId}`, `doctor_id:${doctorId}`, `practice_id:${practiceId}`, "wholesale"];
    }
    case "Master Clinic": {
      const tags = [`clinic_id:${await id("clinic", "clinicId")}`];
      if (parent.practiceId) tags.push(`practice_id:${parent.practiceId}`);
      return [...tags, "wholesale"];
    }
    default:
      throw new Error("Unknown role: " + role);
  }
}

/* --------------------------- re-adding a customer --------------------------- */

// Tags the role decides - replaced when an existing customer is re-added.
const ROLE_ID_TAG = /^(practice_id|clinic_id|doctor_id|rep_id|clinic_location):/i;
const ROLE_FLAG_TAGS = ["wholesale", "wholesale_rep"];

/**
 * Ids this customer OWNS, so re-adding them keeps their numbers. A doctor_id
 * / rep_id always belongs to its holder. A practice_id / clinic_id is only
 * theirs when they are that practice / clinic - a physician also carries
 * their parent's ids, which must never be treated as their own.
 */
async function ownedIds(customerId, tags, prevRole) {
  const ids = idsFromCustomerTags(tags);
  const reuse = { repId: ids.repId, doctorId: ids.doctorId };
  const others = { customerId: { $ne: String(customerId) } };
  if (ids.practiceId) {
    const owner = ["Practice", "Practice + Doctor"].includes(prevRole) ||
      // e.g. a Practice + Doctor made by the old scripts: no separate practice account
      (ids.doctorId && !(await Account.exists({ ...others, practiceId: ids.practiceId, clinicId: "", doctorId: "" })));
    if (owner) reuse.practiceId = ids.practiceId;
  }
  if (ids.clinicId) {
    const owner = ["Clinic", "Master Clinic", "Practice + Doctor"].includes(prevRole) ||
      (ids.doctorId && !(await Account.exists({ ...others, clinicId: ids.clinicId, doctorId: "" })));
    if (owner) reuse.clinicId = ids.clinicId;
  }
  return reuse;
}

/**
 * The email is already a Shopify customer: update that customer to the
 * requested role (name, role / id tags, clinic location) instead of failing,
 * keeping every other tag and the ids it already owns. Returns
 * { customerId, tags, previousRole }.
 */
async function reprovisionCustomer(existing, { role, parent, firstName, lastName, clinicLocation }) {
  const customerId = String(existing.id);
  const acct = await Account.findOne({ customerId }).lean();
  const previousRole = acct?.role || roleFromTags(existing.tags) || "customer";
  const roleTags = await buildTags(role, parent, await ownedIds(customerId, existing.tags, previousRole));
  if (clinicLocation) roleTags.push("clinic_location:" + clinicLocation.replace(/,/g, " "));
  const kept = (existing.tags || []).filter(
    (t) => !ROLE_ID_TAG.test(t) && !ROLE_FLAG_TAGS.includes(String(t).trim().toLowerCase()),
  );
  const tags = [...kept, ...roleTags];

  const result = await updateCustomer(customerId, { firstName, lastName, tags });
  if (!result.startsWith("ok")) throw new Error("Shopify customer update " + result);
  const fresh = await liveCustomer(customerId);
  await upsertAccount(fresh ? shapeCustomer(fresh) : { ...existing, first: firstName, last: lastName, tags });
  return { customerId, tags, previousRole };
}

async function createTaggedCustomer({ firstName, lastName, email, tags }) {
  const customerId = await createCustomer({ firstName, lastName, email, tags });
  await upsertAccount({ id: customerId, first: firstName, last: lastName, email, tags, state: "DISABLED" });
  return customerId;
}

/**
 * Creates one portal account. input: { role, firstName, lastName, email,
 * clinicLocation, repId, parentPracticeId, parentClinicId }.
 * Returns { ok, customerId, tags } or { ok: false, error }.
 */
export async function createPortalAccount(input) {
  await connectDb();
  const role = String(input.role || "").trim();
  const firstName = String(input.firstName || "").trim();
  const lastName = String(input.lastName || "").trim();
  const email = String(input.email || "").trim().toLowerCase();

  const missing = [];
  if (!role) missing.push("Role");
  if (!firstName) missing.push("First Name");
  if (!lastName && role !== "Demo") missing.push("Last Name");
  if (!email || !email.includes("@")) missing.push("Email");
  if (missing.length) return { ok: false, error: "Missing - " + missing.join(", ") };
  if (!ROLES.includes(role)) return { ok: false, error: "Unknown role: " + role };

  if (role === "Demo") return createDemoTrio({ firstName, email });

  // The parent's ids come from the stored parent account, never from typing.
  const parent = { practiceId: "", clinicId: "" };
  // id, tag or email of the parent account all work (see resolveParent)
  if (input.parentClinicId) {
    const clinic = await resolveParent("clinic", input.parentClinicId);
    if (!clinic) return { ok: false, error: "Parent Clinic not found: " + input.parentClinicId };
    parent.clinicId = clinic.id;
    parent.practiceId = clinic.practiceId;
  }
  if (input.parentPracticeId) {
    const practice = await resolveParent("practice", input.parentPracticeId);
    if (!practice) return { ok: false, error: "Parent Practice not found: " + input.parentPracticeId };
    parent.practiceId = practice.id;
  }

  // Optional free text shown on the storefront as the clinic name.
  const clinicLocation = String(input.clinicLocation || "").trim();

  // Already a Shopify customer (added before, or by the old scripts): update
  // it - and its database record - instead of failing or duplicating it.
  let existing;
  try {
    existing = await findCustomerByEmail(email);
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }

  let customerId;
  let tags;
  let previousRole = "";
  try {
    if (existing) {
      ({ customerId, tags, previousRole } = await reprovisionCustomer(existing, {
        role, parent, firstName, lastName, clinicLocation,
      }));
    } else {
      tags = await buildTags(role, parent);
      if (clinicLocation) tags.push("clinic_location:" + clinicLocation.replace(/,/g, " "));
      customerId = await createTaggedCustomer({ firstName, lastName, email, tags });
    }
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }

  // Shopify allows one customer per email, so any other record with this
  // email belongs to a customer that no longer exists - drop it.
  await Account.deleteMany({ email, customerId: { $ne: String(customerId) } });

  // "Send welcome email" unticked: nothing is scheduled; Re-send on the row
  // still sends it later. A re-added account that already got its welcome
  // email isn't sent another.
  const cfg = await getSettings();
  const delayMin = Number(cfg.WELCOME_EMAIL_DELAY_MINUTES);
  const sendWelcome = String(input.sendWelcome ?? "true") !== "false";
  const before = await Account.findOne({ customerId }, { provisionedAt: 1, welcomeEmailSentAt: 1 }).lean();
  const welcome = before?.welcomeEmailSentAt
    ? {}
    : {
        welcomeDueAt: sendWelcome ? new Date(Date.now() + (delayMin >= 0 ? delayMin : 30) * 60000) : null,
        welcomeResult: sendWelcome ? "" : "Not sent (unticked)",
      };
  await Account.updateOne(
    { customerId },
    { $set: { role, provisionedAt: before?.provisionedAt || new Date(), ...welcome } },
  );
  if (welcome.welcomeDueAt) {
    // a few seconds after it is due, so the row is found by the due query
    sendDueWelcomeEmailsSoon(welcome.welcomeDueAt.getTime() - Date.now() + 3000);
    logEvent("email", email, `welcome email scheduled for ${welcome.welcomeDueAt.toISOString()}`);
  } else if (!before?.welcomeEmailSentAt) {
    logEvent("email", email, "welcome email not scheduled (Send welcome email was unticked)");
  }

  // Sales-rep bookkeeping. Failures here never undo the created customer.
  try {
    if (role === "Sales Rep") {
      await upsertSalesRep(tagVal(tags, "rep_id:"), { name: `${firstName} ${lastName}`.trim(), email, customerId });
    } else if (input.repId) {
      // an id or the rep's email both work
      const rep = await resolveSalesRep(input.repId);
      if (!rep) throw new Error(`sales rep "${input.repId}" not found`);
      input.repId = rep.repId;
      const assignId = tagVal(tags, "practice_id:") || tagVal(tags, "clinic_id:");
      await assignToRep(String(input.repId).trim(), assignId);
    }
  } catch (err) {
    logEvent("error", email, "sales rep assignment: " + err, null, false);
  }

  logEvent("sync", email, existing ? `account updated (was ${previousRole}, now ${role})` : `account created (${role})`,
    { customerId, tags });
  startPracticeCopies(tags);
  return { ok: true, customerId, tags, updated: !!existing, previousRole, welcomeAlreadySent: !!before?.welcomeEmailSentAt };
}

/**
 * The shared demo trio (Practice / Clinic / Physician) every sales rep
 * demos the portal with. One email in, three customers out
 * (name+practice@…, name+clinic@…, and the address itself as the physician).
 */
async function createDemoTrio({ firstName, email }) {
  const at = email.indexOf("@");
  if (at < 1) return { ok: false, error: "Invalid email" };
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const practiceEmail = `${local}+practice${domain}`;
  const clinicEmail = `${local}+clinic${domain}`;
  for (const e of [practiceEmail, clinicEmail, email]) {
    if (await findCustomerByEmail(e)) return { ok: false, error: `Email already exists in Shopify (${e})` };
  }
  const practiceId = await nextId(PREFIX.practice);
  const clinicId = await nextId(PREFIX.clinic);
  const doctorId = await nextId(PREFIX.doctor);
  const trio = [
    { last: "Practice", email: practiceEmail, tags: [`practice_id:${practiceId}`, "wholesale", "rx_demo"] },
    { last: "Clinic", email: clinicEmail, tags: [`clinic_id:${clinicId}`, `practice_id:${practiceId}`, "wholesale", "rx_demo"] },
    { last: "Physician", email, tags: [`clinic_id:${clinicId}`, `doctor_id:${doctorId}`, `practice_id:${practiceId}`, "wholesale", "rx_demo"] },
  ];
  let physicianCustomerId = "";
  for (let j = 0; j < trio.length; j++) {
    try {
      const id = await createTaggedCustomer({ firstName, lastName: trio[j].last, email: trio[j].email, tags: trio[j].tags });
      await Account.updateOne({ customerId: id }, { $set: { role: "Demo", demo: true } });
      if (trio[j].last === "Physician") physicianCustomerId = id;
    } catch (err) {
      return {
        ok: false,
        error:
          `${trio[j].last} not created - ${err.message || err}` +
          (j ? " (earlier demo customers WERE created - delete them in Shopify before retrying)" : ""),
      };
    }
  }
  await DemoAccount.create({ customerId: physicianCustomerId, email, practiceId, clinicId, doctorId, label: firstName });
  clearDemoCache();
  logEvent("sync", email, "demo trio created", { practiceId, clinicId, doctorId });
  startPracticeCopies(trio[2].tags);
  return { ok: true, customerId: physicianCustomerId, tags: trio[2].tags, demo: { practiceId, clinicId, doctorId } };
}

/* --------------------------- edit / delete ------------------------------ */

/* Tags that make the account what it is - ids, role and portal access. They
   come from the live customer on every save and are never taken from the
   form, so editing can't change someone's role or ids by accident.
   clinic_location: has its own field. */
const SYSTEM_TAG_PREFIX = /^(practice_id|clinic_id|doctor_id|rep_id|clinic_location):/i;
const SYSTEM_TAGS = ["wholesale", "wholesale_rep", "rx_demo", "finance_admin"];
const isSystemTag = (t) => SYSTEM_TAG_PREFIX.test(t) || SYSTEM_TAGS.includes(String(t).trim().toLowerCase());

const CUSTOMER_DETAIL = `#graphql
  query RxCustomerDetail($id: ID!) {
    customer(id: $id) {
      id legacyResourceId firstName lastName email phone note state taxExempt tags
      defaultAddress {
        id company address1 address2 city province provinceCode zip country countryCodeV2 phone
      }
    }
  }`;

async function liveCustomer(customerId) {
  const data = await gql(CUSTOMER_DETAIL, { id: gid.customer(customerId) });
  return data.customer || null;
}

/** The practice (or practice-less clinic) id a sales rep is assigned by. */
const repAssignId = (acct) => (acct && acct.role !== "Sales Rep" ? acct.practiceId || acct.clinicId || "" : "");

/** Everything the Edit popup shows, read live from Shopify. */
export async function getAccountDetail(customerId) {
  await connectDb();
  const c = await liveCustomer(customerId);
  if (!c) return { ok: false, error: "Customer not found in Shopify - it may already be deleted." };
  const acct = await Account.findOne({ customerId: String(customerId) }).lean();
  const tags = c.tags || [];
  const assignId = repAssignId(acct);
  const rep = assignId ? await SalesRep.findOne({ assignedPracticeIds: assignId }, { repId: 1 }).lean() : null;
  const a = c.defaultAddress || {};
  return {
    ok: true,
    detail: {
      customerId: String(customerId),
      role: acct?.role || "",
      state: c.state || "",
      first: c.firstName || "",
      last: c.lastName || "",
      email: c.email || "",
      phone: c.phone || "",
      note: c.note || "",
      taxExempt: !!c.taxExempt,
      systemTags: tags.filter((t) => isSystemTag(t) && !/^clinic_location:/i.test(t)),
      otherTags: tags.filter((t) => !isSystemTag(t)).join(", "),
      clinicLocation: tagVal(tags, "clinic_location:"),
      assignId,
      repId: rep?.repId || "",
      address: {
        company: a.company || "",
        address1: a.address1 || "",
        address2: a.address2 || "",
        city: a.city || "",
        provinceCode: a.provinceCode || "",
        zip: a.zip || "",
        countryCode: a.countryCodeV2 || "US",
        phone: a.phone || "",
      },
    },
  };
}

const userErrorText = (errs) => errs.map((e) => e.message).join("; ");

/**
 * Saves the Edit popup to the Shopify customer (name, email, phone, note,
 * tax, tags, default address), then the sales-rep assignment, then refreshes
 * the local account mirror. Returns { ok } or { ok: false, error }.
 */
export async function updatePortalAccount(customerId, input) {
  await connectDb();
  customerId = String(customerId || "");
  const first = String(input.first || "").trim();
  const last = String(input.last || "").trim();
  const email = String(input.email || "").trim().toLowerCase();
  const phone = String(input.phone || "").trim();
  if (!first) return { ok: false, error: "First name is required." };
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: "Enter a valid email." };

  const c = await liveCustomer(customerId);
  if (!c) return { ok: false, error: "Customer not found in Shopify - it may already be deleted." };
  if (email !== String(c.email || "").toLowerCase()) {
    const taken = await findCustomerByEmail(email);
    if (taken && String(taken.id) !== customerId) return { ok: false, error: "Another customer already uses " + email };
  }

  // Role / id tags from the live record; only the free tags come from the form.
  const tags = (c.tags || []).filter((t) => isSystemTag(t) && !/^clinic_location:/i.test(t));
  const clinicLocation = String(input.clinicLocation || "").trim();
  if (clinicLocation) tags.push("clinic_location:" + clinicLocation.replace(/,/g, " "));
  for (const t of String(input.otherTags || "").split(",")) {
    const s = t.trim();
    if (s && !isSystemTag(s) && !tags.includes(s)) tags.push(s);
  }

  const upd = await gql(
    `#graphql
    mutation RxAccountUpdate($input: CustomerInput!) {
      customerUpdate(input: $input) { customer { id } userErrors { field message } }
    }`,
    {
      input: {
        id: c.id,
        firstName: first,
        lastName: last,
        email,
        phone: phone || null,
        note: String(input.note || ""),
        taxExempt: String(input.taxExempt) === "true",
        tags,
      },
    },
  );
  const errs = upd.customerUpdate?.userErrors || [];
  if (errs.length) return { ok: false, error: "Shopify: " + userErrorText(errs) };

  // Default address - updated in place, or created when there is none yet.
  const ad = {
    company: String(input.company || "").trim(),
    address1: String(input.address1 || "").trim(),
    address2: String(input.address2 || "").trim(),
    city: String(input.city || "").trim(),
    provinceCode: String(input.provinceCode || "").trim().toUpperCase(),
    zip: String(input.zip || "").trim(),
    countryCode: String(input.countryCode || "").trim().toUpperCase(),
    phone: String(input.addressPhone || "").trim(),
  };
  const hasAddress = Object.entries(ad).some(([k, v]) => k !== "countryCode" && v);
  const warnings = [];
  if (hasAddress || c.defaultAddress) {
    const address = { firstName: first, lastName: last, ...ad };
    for (const k of Object.keys(address)) if (address[k] === "") address[k] = null;
    const res = c.defaultAddress
      ? await gql(
          `#graphql
          mutation RxAddressUpdate($customerId: ID!, $addressId: ID!, $address: MailingAddressInput!) {
            customerAddressUpdate(customerId: $customerId, addressId: $addressId, address: $address, setAsDefault: true) {
              address { id } userErrors { field message }
            }
          }`,
          { customerId: c.id, addressId: c.defaultAddress.id, address },
        ).then((d) => d.customerAddressUpdate)
      : await gql(
          `#graphql
          mutation RxAddressCreate($customerId: ID!, $address: MailingAddressInput!) {
            customerAddressCreate(customerId: $customerId, address: $address, setAsDefault: true) {
              address { id } userErrors { field message }
            }
          }`,
          { customerId: c.id, address },
        ).then((d) => d.customerAddressCreate);
    const aErrs = res?.userErrors || [];
    if (aErrs.length) warnings.push("address not saved - " + userErrorText(aErrs));
  }

  // Sales rep: one rep per practice, so this changes it for the whole practice.
  const acct = await Account.findOne({ customerId }).lean();
  const assignId = repAssignId(acct);
  if (assignId && input.repId !== undefined) {
    const repId = String(input.repId || "").trim();
    if (repId) await assignToRep(repId, assignId);
    else await SalesRep.updateMany({}, { $pull: { assignedPracticeIds: assignId } });
  }

  // Refresh the mirror now rather than waiting for the customers/update webhook.
  const fresh = await liveCustomer(customerId);
  if (fresh) await upsertAccount(shapeCustomer(fresh));

  logEvent("sync", email, "account edited from the Accounts page", { customerId, tags });
  return { ok: true, message: warnings.length ? "Saved, but " + warnings.join("; ") : "Saved to Shopify." };
}

/**
 * Deletes the Shopify customer and everything the app keeps for it (account
 * mirror, sales-rep record, demo record). Shopify refuses to delete a
 * customer who has orders - that message is passed back as-is.
 */
export async function deletePortalAccount(customerId) {
  await connectDb();
  customerId = String(customerId || "");
  const acct = await Account.findOne({ customerId }).lean();
  const res = await gql(
    `#graphql
    mutation RxCustomerDelete($input: CustomerDeleteInput!) {
      customerDelete(input: $input) { deletedCustomerId userErrors { field message } }
    }`,
    { input: { id: gid.customer(customerId) } },
  );
  const errs = res.customerDelete?.userErrors || [];
  // Already gone in Shopify -> still clean up here.
  if (errs.length && !/not.*found|does not exist/i.test(userErrorText(errs))) {
    return { ok: false, error: "Shopify: " + userErrorText(errs) };
  }
  // removeAccount also drops the sales rep record (by customer id or rep id)
  await removeAccount(customerId, { cleanupProducts: false });
  const demo = await DemoAccount.deleteMany({ customerId });
  if (demo.deletedCount) clearDemoCache();
  logEvent("sync", acct?.email || customerId, `account deleted (${acct?.role || "?"})`, { customerId });
  const who = acct ? `${acct.first} ${acct.last}`.trim() || acct.email : customerId;

  // Practice left without a physician -> its product copies go now, not on
  // the next timed run.
  let message = `Deleted ${who} from Shopify.`;
  if (acct?.practiceId) {
    const res = await removePracticeCopiesIfUnused(acct.practiceId, { except: customerId });
    if (res.deleted) {
      message = `Deleted ${who} and ${res.deleted} product${res.deleted === 1 ? "" : "s"} of practice ${acct.practiceId} from Shopify.`;
    } else if (res.kept === "could not check physicians") {
      message += ` Practice ${acct.practiceId}'s products were kept: Shopify could not be checked - see Sync & logs.`;
    }
  }
  return { ok: true, message };
}

/* ---------------------------- welcome email ----------------------------- */

// [Link] -> login, then the role's own dashboard (see components/welcome-link.js).

/* One welcome template for every role, as in the Apps Script version: the
   WELCOME_EMAIL_SUBJECT / BODY settings. Left empty, the built-in Protocol
   Therapeutics template (welcome-default.server.js) is used. */
export const WELCOME_PLACEHOLDERS = ["First Name", "Last Name", "Name", "Email", "Role", "Link"];

/** { subject, body, custom } - custom is false while the built-in default is in use. */
export async function getWelcomeTemplate(cfg) {
  cfg = cfg || (await getSettings({ fresh: true }));
  const subject = cfg.WELCOME_EMAIL_SUBJECT || "";
  const body = cfg.WELCOME_EMAIL_BODY || "";
  return {
    subject: subject || WELCOME_DEFAULT_SUBJECT,
    body: body || WELCOME_DEFAULT_BODY,
    custom: !!(subject || body),
  };
}

/** Saving the built-in text (or blanks) stores blanks, so the default keeps tracking the code. */
export async function saveWelcomeTemplate({ subject, body }) {
  subject = String(subject || "");
  body = String(body || "");
  if (subject.trim() === WELCOME_DEFAULT_SUBJECT) subject = "";
  if (body.trim() === WELCOME_DEFAULT_BODY.trim()) body = "";
  await setSettings({ WELCOME_EMAIL_SUBJECT: subject, WELCOME_EMAIL_BODY: body });
  logEvent("sync", "welcome-template", subject || body ? "welcome template saved" : "welcome template reset to default");
}

/**
 * Sends the welcome email once per address. Placeholders (case / space
 * insensitive): [First Name] [Last Name] [Name] [Email] [Role] [Link].
 * `test` skips the once-per-address rule and marks the subject.
 * Returns 'sent', 'already' or 'failed: …' / 'skipped: …'.
 */
export async function sendWelcomeEmail({ firstName, lastName, email, role, test = false }) {
  email = String(email || "").trim();
  if (!email) return "skipped: no email";
  const dedupeKey = "welcome_sent:" + email.toLowerCase();
  if (!test && (await kvGet(dedupeKey))) return "already";

  const cfg = await getSettings();
  if (READ_ONLY) return "skipped: read-only mode";
  if (isTrue(cfg.EMAIL_DISABLED)) return "skipped: email disabled";
  if (!cfg.BREVO_API_KEY) return "skipped: BREVO_API_KEY not set";
  const tpl = await getWelcomeTemplate(cfg);
  const subjectTpl = tpl.subject;
  const bodyTpl = tpl.body;

  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  const tokens = {
    firstname: firstName || "",
    lastname: lastName || "",
    name: fullName || String(firstName || "there"),
    email,
    role: role || "",
    link: welcomeLinkForRole(cfg.WELCOME_EMAIL_LINK, role),
  };
  const fill = (s) =>
    String(s || "").replace(/\[([^\]]+)\]/g, (whole, token) => {
      const k = token.replace(/[\s_-]+/g, "").toLowerCase();
      return Object.prototype.hasOwnProperty.call(tokens, k) ? tokens[k] : whole;
    });
  const body = fill(bodyTpl);
  const isHtml = /<[a-z][\s\S]*>/i.test(body);
  const subject = (test ? "[Test] " : "") + (fill(subjectTpl) || "Welcome");

  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": cfg.BREVO_API_KEY, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        sender: {
          email: cfg.BREVO_SENDER_EMAIL || "no-reply@protocoltherapeutics.com",
          name: cfg.BREVO_SENDER_NAME || "Protocol Therapeutics",
        },
        to: [{ email, name: fullName || email }],
        subject,
        ...(isHtml ? { htmlContent: body } : { textContent: body }),
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return `failed: Brevo HTTP ${res.status} ${(await res.text()).slice(0, 200)}`;
    if (test) {
      logEvent("email", email, "welcome email TEST sent");
      return "sent";
    }
    await kvSet(dedupeKey, new Date().toISOString());
    logEvent("email", email, "welcome email sent");
    return "sent";
  } catch (err) {
    return "failed: " + err;
  }
}

/** Scheduler job: welcome emails whose delay has passed. */
export async function sendDueWelcomeEmails() {
  await connectDb();
  const due = await Account.find({
    welcomeDueAt: { $ne: null, $lte: new Date() },
    welcomeEmailSentAt: null,
    welcomeResult: { $in: ["", null] },
  }).lean();
  let sent = 0;
  let waiting = 0;
  for (const a of due) {
    // A physician's welcome waits until their practice's products exist, so
    // they log in to a complete catalogue. Capped: never held more than
    // WELCOME_WAIT_MAX_MS past the due time (e.g. a product keeps failing).
    if (a.doctorId && a.clinicId && a.practiceId) {
      const st = await practiceCopiesStatus(a.practiceId);
      if (!st.done) {
        const waitedMs = Date.now() - new Date(a.welcomeDueAt).getTime();
        if (waitedMs < WELCOME_WAIT_MAX_MS) {
          waiting++;
          if (!waitingLogged.has(String(a._id))) {
            waitingLogged.add(String(a._id));
            // the fallback must fire even with the background scheduler off
            sendDueWelcomeEmailsSoon(WELCOME_WAIT_MAX_MS - waitedMs + 5000);
            logEvent("email", a.email,
              `welcome email waiting for practice ${a.practiceId} products ` +
              `(${st.finished}/${st.masters} done${st.inProgress ? ", creating now" : ""}) - sends as soon as they are complete`);
          }
          continue;
        }
        logEvent("email", a.email,
          `welcome email sent without waiting longer: practice ${a.practiceId} products still ${st.finished}/${st.masters} after ${Math.round(waitedMs / 60000)} min`,
          null, false);
      }
    }
    waitingLogged.delete(String(a._id));
    let result;
    try {
      result = await sendWelcomeEmail({ firstName: a.first, lastName: a.last, email: a.email, role: a.role });
    } catch (err) {
      result = "failed: " + (err?.message || err);
    }
    await Account.updateOne(
      { _id: a._id },
      { $set: { welcomeResult: result, ...(result === "sent" ? { welcomeEmailSentAt: new Date() } : {}) } },
    );
    if (result === "sent") sent++;
    // every attempt is logged - sent, skipped (and why) or failed (and why)
    logEvent("email", a.email, `welcome email: ${result}`, { role: a.role }, result === "sent" || result === "already");
  }
  if (due.length) logEvent("job", "welcome-emails", `due=${due.length} sent=${sent} waitingForProducts=${waiting}`);
  return { due: due.length, sent, waitingForProducts: waiting };
}

// Longest a physician's welcome email is held back for their products.
const WELCOME_WAIT_MAX_MS = 60 * 60 * 1000;
// accounts whose "waiting for products" line is already in the log
const waitingLogged = new Set();

/* Welcome emails must not depend on the background scheduler alone (it is
   off under `shopify app dev`): a timer is armed when an account is created,
   Re-send sends at once, and the Accounts page sends anything already due. */
let welcomeRunning = false;
export function sendDueWelcomeEmailsSoon(delayMs = 0) {
  const t = setTimeout(async () => {
    if (welcomeRunning) return;
    welcomeRunning = true;
    try {
      await sendDueWelcomeEmails();
    } catch (err) {
      logEvent("error", "welcome-emails", String(err?.message || err), null, false);
    } finally {
      welcomeRunning = false;
    }
  }, Math.max(0, delayMs));
  t.unref?.();
}

/** True when some account's welcome email is due now (cheap - for page loads). */
export async function hasDueWelcomeEmails() {
  await connectDb();
  return !!(await Account.exists({
    welcomeDueAt: { $ne: null, $lte: new Date() },
    welcomeEmailSentAt: null,
    welcomeResult: { $in: ["", null] },
  }));
}

/** Clears the result so the next run tries again (admin "Retry"). */
export async function retryWelcomeEmail(customerId) {
  await connectDb();
  const acct = await Account.findOne({ customerId: String(customerId) }, { email: 1 }).lean();
  if (acct?.email) await kvSet("welcome_sent:" + acct.email.toLowerCase(), null);
  await Account.updateOne(
    { customerId: String(customerId) },
    { $set: { welcomeResult: "", welcomeEmailSentAt: null, welcomeDueAt: new Date() } },
  );
  logEvent("email", acct?.email || String(customerId), "welcome email re-send requested");
  sendDueWelcomeEmailsSoon(500);
}
