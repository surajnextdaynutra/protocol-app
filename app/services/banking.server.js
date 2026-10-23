import { connectDb } from "../db.server";
import { Account, Banking } from "../models/index.server";
import { validateBanking } from "./account-validate.server";
import { decryptJson, encryptJson } from "./crypto.server";
import { logEvent } from "./log.server";
import { getSettings } from "./settings.server";
import { gql } from "./shopify-admin.server";

/* Banking details (was the practice_banking_details / clinic banking
   metaobjects and the plain-text rep banking columns).

   One encrypted record per owner. A practice's record is keyed by
   practice_id ALONE - shared by every physician and location of that
   practice. Updating an EXISTING record is locked on days 1-7 of the month
   (payout run); the very first save is allowed on any date. */

const LOCK_FROM_DAY = 1;
const LOCK_TO_DAY = 7;

// Field keys that may be stored (safety whitelist).
export const BANKING_KEYS = [
  "display_name",
  "clinic_id",
  "practice_id",
  "doctor_id",
  "rep_id",
  "bank_name",
  "bank_routing_ach",
  "bank_holder_account_number",
  "bank_address_1",
  "bank_address_2",
  "bank_city",
  "bank_state",
  "bank_zip_postal",
  "account_holder_business_name",
  "account_holder_address_1",
  "account_holder_address_2",
  "account_holder_city",
  "account_holder_state",
  "account_holder_zip_postal",
  "account_holder_phone",
];

const slug = (s) =>
  String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Day-of-month in the configured timezone. */
async function inLockWindow() {
  const tz = (await getSettings()).TIMEZONE;
  const d = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, day: "numeric" }).format(new Date()),
  );
  return d >= LOCK_FROM_DAY && d <= LOCK_TO_DAY;
}

// Old metaobject type per owner, for the one-time copy on first load.
const LEGACY_MO_TYPES = {
  practice: ["practice_banking_details", "banking_details"],
  clinic: ["clinic_banking_details"],
};

/** Copies a record saved before this app existed out of its Shopify
 *  metaobject. Best-effort; returns the fields or null. */
async function importLegacy(ownerType, ownerId) {
  try {
    let mo = null;
    for (const type of LEGACY_MO_TYPES[ownerType] || []) {
      const data = await gql(
        `#graphql
        query RxLegacyBanking($handle: MetaobjectHandleInput!) {
          metaobjectByHandle(handle: $handle) { id fields { key value } }
        }`,
        { handle: { type, handle: slug(ownerId) } },
      ).catch(() => ({}));
      if (data.metaobjectByHandle) {
        mo = data.metaobjectByHandle;
        break;
      }
    }
    if (!mo) return null;
    const fields = {};
    for (const f of mo.fields || []) if (f.value != null) fields[f.key] = f.value;
    await Banking.updateOne(
      { ownerType, ownerId },
      { $setOnInsert: { data: encryptJson(fields), updatedBy: "legacy-import" } },
      { upsert: true },
    );
    logEvent("job", `${ownerType}:${ownerId}`, "banking details imported from metaobject");
    return fields;
  } catch {
    return null;
  }
}

/** { found, handle, fields } - the same shape the dashboards already read. */
export async function loadBanking(ownerType, ownerId) {
  ownerId = String(ownerId || "").trim();
  if (!ownerId) return { error: `${ownerType}_id is required` };
  await connectDb();
  const row = await Banking.findOne({ ownerType, ownerId }).lean();
  let fields = row ? decryptJson(row.data) : await importLegacy(ownerType, ownerId);
  if (!fields) return { found: false, handle: slug(ownerId) };
  return { found: true, handle: slug(ownerId), fields, locked: await inLockWindow() };
}

/**
 * Upsert. `incoming` is the page's [{key, value}] list (or a plain object).
 * Returns { ok, created } or { error }.
 */
export async function saveBanking(ownerType, ownerId, incoming, updatedBy = "", { lock = true } = {}) {
  ownerId = String(ownerId || "").trim();
  if (!ownerId) return { error: `${ownerType}_id is required` };

  const fields = {};
  const list = Array.isArray(incoming)
    ? incoming
    : Object.entries(incoming || {}).map(([key, value]) => ({ key, value }));
  for (const f of list) {
    if (f && BANKING_KEYS.includes(f.key)) fields[f.key] = String(f.value == null ? "" : f.value).trim();
  }
  // Every field checked before anything is stored; each failure is keyed by
  // the form's field name so the page can show it under that field.
  const fieldErrors = validateBanking(fields);
  if (Object.keys(fieldErrors).length) {
    return { error: "Please fix the highlighted fields.", fieldErrors };
  }
  fields.bank_routing_ach = fields.bank_routing_ach.replace(/[\s-]/g, "");
  fields.bank_holder_account_number = fields.bank_holder_account_number.replace(/[\s-]/g, "");
  if (!fields.display_name) fields.display_name = ownerId;
  fields[`${ownerType === "physician" ? "doctor" : ownerType}_id`] = ownerId;

  await connectDb();
  let existing = await Banking.findOne({ ownerType, ownerId }, { _id: 1 }).lean();
  if (!existing && (await importLegacy(ownerType, ownerId))) existing = { _id: 1 };

  if (lock && existing && (await inLockWindow())) {
    return {
      error:
        "Editing is locked from the 1st to the 7th of every month. Please try again from the 8th onward.",
    };
  }
  await Banking.updateOne(
    { ownerType, ownerId },
    { $set: { data: encryptJson(fields), updatedBy: String(updatedBy || "") } },
    { upsert: true },
  );
  logEvent("job", `${ownerType}:${ownerId}`, `banking details ${existing ? "updated" : "created"} by ${updatedBy || "?"}`);
  return { ok: true, created: !existing, handle: slug(ownerId) };
}

/* Practice / clinic records use snake_case keys, sales rep records camelCase. */
const pick = (f, ...keys) => keys.map((k) => f[k]).find((v) => v != null && String(v).trim() !== "") || "";

/* Every field of the Banking Details forms, in the forms' own order and
   sections: [label, snake_case key (practice / clinic), camelCase key (rep)]. */
const BANKING_SECTIONS = [
  ["Account", [
    ["Display name", "display_name"],
    ["Practice ID", "practice_id"],
    ["Clinic ID", "clinic_id"],
    ["Doctor ID", "doctor_id"],
    ["Rep ID", "rep_id"],
  ]],
  ["Bank information", [
    ["Bank name", "bank_name", "bankName"],
    ["Bank routing (ACH)", "bank_routing_ach", "bankRouting"],
    ["Bank holder account number", "bank_holder_account_number", "accountNumber"],
    ["Bank address 1", "bank_address_1", "bankAddress1"],
    ["Bank address 2", "bank_address_2", "bankAddress2"],
    ["Bank city", "bank_city", "bankCity"],
    ["Bank state", "bank_state", "bankState"],
    ["Bank zip / postal", "bank_zip_postal", "bankZip"],
  ]],
  ["Account holder", [
    ["Account holder business name", "account_holder_business_name", "holderBusinessName"],
    ["Account holder address 1", "account_holder_address_1", "holderAddress1"],
    ["Account holder address 2", "account_holder_address_2", "holderAddress2"],
    ["Account holder city", "account_holder_city", "holderCity"],
    ["Account holder state", "account_holder_state", "holderState"],
    ["Account holder zip / postal", "account_holder_zip_postal", "holderZip"],
    ["Account holder phone", "account_holder_phone", "holderPhone"],
  ]],
];
const KNOWN_KEYS = new Set(BANKING_SECTIONS.flatMap(([, fields]) => fields.flatMap(([, ...keys]) => keys)));

/** One banking record as sections of { label, value } - every field the form
 *  has (blank ones too, so a missing value is visible), plus any extra key a
 *  record carries under "Other". Identity fields that don't apply are left out. */
export function bankingSections(f = {}) {
  const sections = BANKING_SECTIONS.map(([title, fields]) => ({
    title,
    rows: fields
      .map(([label, ...keys]) => ({ label, value: pick(f, ...keys) }))
      .filter((r) => title !== "Account" || r.value),
  })).filter((s) => s.rows.length);
  const other = Object.keys(f)
    .filter((k) => !KNOWN_KEYS.has(k) && f[k] != null && String(f[k]).trim() !== "")
    .map((k) => ({ label: k, value: String(f[k]) }));
  if (other.length) sections.push({ title: "Other", rows: other });
  return sections;
}


/**
 * The banking record a payout row is paid to (Payouts page "Bank details").
 * Practice / Clinic / Rep -> their own record. Doctor -> their practice's
 * record: physician banking is saved on the practice (keyed by practice_id).
 * Returns { found, owner, note?, rows } or { found: false, owner, note }.
 */
export async function bankingForPayout(role, entityId) {
  entityId = String(entityId || "").trim();
  await connectDb();
  let ownerType = { Practice: "practice", Clinic: "clinic", Rep: "rep" }[role] || "";
  let ownerId = entityId;
  let note = "";
  if (role === "Doctor") {
    const acct = await Account.findOne({ doctorId: entityId }, { practiceId: 1 }).lean();
    if (!acct?.practiceId) return { found: false, owner: `Doctor ${entityId}`, note: "This physician's practice could not be found, so there is no banking record to show." };
    ownerType = "practice";
    ownerId = acct.practiceId;
    note = `Physician banking is saved on their practice (${ownerId}).`;
  }
  if (!ownerType || !ownerId) return { found: false, owner: `${role} ${entityId}`, note: "Unknown payout role." };
  const owner = `${ownerType} ${ownerId}`;
  let res;
  try {
    res = await loadBanking(ownerType, ownerId);
  } catch (err) {
    return { found: false, owner, note: `Could not read the banking record (${err.message || err}) - ENCRYPTION_KEY changed?` };
  }
  if (!res?.found) return { found: false, owner, note };
  const row = await Banking.findOne({ ownerType, ownerId }, { updatedAt: 1, updatedBy: 1 }).lean();
  logEvent("job", owner, `banking details viewed on the Payouts page (${role} ${entityId})`);
  return { found: true, owner, note, sections: bankingSections(res.fields || {}), updatedAt: row?.updatedAt || null };
}

/** Admin view: every record, decrypted, for the finance team. */
export async function listBanking() {
  await connectDb();
  const rows = await Banking.find({}).sort({ ownerType: 1, ownerId: 1 }).lean();
  return rows.map((r) => {
    let fields = {};
    try {
      fields = decryptJson(r.data) || {};
    } catch {
      fields = { error: "could not decrypt - ENCRYPTION_KEY changed?" };
    }
    return { ownerType: r.ownerType, ownerId: r.ownerId, fields, updatedAt: r.updatedAt, updatedBy: r.updatedBy };
  });
}
