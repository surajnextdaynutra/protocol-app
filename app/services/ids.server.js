import { connectDb } from "../db.server";
import { DemoAccount } from "../models/index.server";
import { getSettings } from "./settings.server";

/* Attribution ids (rx / patient / doctor / clinic / practice) and the tag
   conventions shared by orders, customers and products. */

/** "a, b , c" or ["a","b"] -> trimmed array without blanks. */
export function tagList(tags) {
  const arr = Array.isArray(tags) ? tags : String(tags || "").split(",");
  return arr.map((t) => String(t).trim()).filter(Boolean);
}

/** Value of a "prefix:value" tag ('' when absent). Case-insensitive prefix. */
export function tagVal(tags, prefix) {
  const p = prefix.toLowerCase();
  for (const t of tagList(tags)) {
    if (t.toLowerCase().startsWith(p)) return t.slice(prefix.length).trim();
  }
  return "";
}

/** Master key of a PRACTICE COPY ('' for anything else). Copies are tagged
 *  practice_id:<id> + rxcopy:<key> (the base product - the master - is
 *  rxbase:<key>). Copies made earlier carry rxmaster:<key> or rxbase:<key>
 *  and still count until their next sync re-tags them. The base has no
 *  practice_id, so it is never a copy. */
export function copyMasterKey(tags) {
  if (!tagVal(tags, "practice_id:")) return "";
  return tagVal(tags, "rxcopy:") || tagVal(tags, "rxbase:") || tagVal(tags, "rxmaster:");
}

/** Every value of a repeated "prefix:value" tag. */
export function tagVals(tags, prefix) {
  const p = prefix.toLowerCase();
  return tagList(tags)
    .filter((t) => t.toLowerCase().startsWith(p))
    .map((t) => t.slice(prefix.length).trim())
    .filter(Boolean);
}

export function hasTag(tags, tag) {
  const l = String(tag).toLowerCase();
  return tagList(tags).some((t) => t.toLowerCase() === l);
}

/**
 * Replace (not append) any tag sharing this prefix with the one new value, so
 * a record only ever carries the id that currently applies. A blank value
 * leaves what is already there untouched. Mutates `tags`.
 */
export function setIdTag(tags, prefix, value) {
  if (!value) return;
  const lv = prefix.toLowerCase();
  for (let i = tags.length - 1; i >= 0; i--) {
    if (tags[i].toLowerCase().startsWith(lv)) tags.splice(i, 1);
  }
  tags.push(prefix + value);
}

/** Case-insensitive add (never 'subscription' next to 'Subscription'). */
export function addTag(tags, v) {
  if (!v) return;
  const lv = v.toLowerCase();
  if (!tags.some((t) => t.toLowerCase() === lv)) tags.push(v);
}

export function tagsFingerprint(tags) {
  return tags.slice().sort().join(",").toLowerCase();
}

/** The role ids carried by a portal user's customer tags. */
export function idsFromCustomerTags(tags) {
  const list = tagList(tags);
  return {
    doctorId: tagVal(list, "doctor_id:"),
    clinicId: tagVal(list, "clinic_id:"),
    clinicIds: tagVals(list, "clinic_id:"),
    practiceId: tagVal(list, "practice_id:"),
    repId: tagVal(list, "rep_id:"),
    patientId: tagVal(list, "patient_id:"),
    wholesale: hasTag(list, "wholesale"),
    patient: hasTag(list, "patient"),
    // Finance admins carry BOTH an admin id and the finance_admin flag.
    finance: hasTag(list, "finance_admin") && !!tagVal(list, "admin_id:"),
    adminId: tagVal(list, "admin_id:"),
    demo: hasTag(list, "rx_demo"),
  };
}

/* ------------------------------ demo ids -------------------------------- */

let demoCache = null;
let demoAt = 0;

/** Lower-cased set of every demo practice / clinic / doctor id. */
export async function demoIdSet() {
  if (demoCache && Date.now() - demoAt < 60_000) return demoCache;
  const set = new Set();
  const add = (id) => {
    id = String(id || "").trim();
    if (id) set.add(id.toLowerCase());
  };
  const cfg = await getSettings();
  String(cfg.DEMO_IDS || "").split(/[,\s]+/).forEach(add);
  try {
    await connectDb();
    const rows = await DemoAccount.find({}).lean();
    rows.forEach((r) => [r.practiceId, r.clinicId, r.doctorId].forEach(add));
  } catch {
    // a read failure never breaks the caller
  }
  demoCache = set;
  demoAt = Date.now();
  return set;
}

export function clearDemoCache() {
  demoCache = null;
  // the theme reads the demo trio from the shop metafield - keep it current
  import("./demo-sync.server.js").then((m) => m.scheduleDemoSync()).catch(() => {});
}

/** True when ANY id on this order / prescription is a demo id. */
export async function isDemoIds(ids) {
  if (!ids) return false;
  const set = await demoIdSet();
  return [
    ids.doctorId,
    ids.clinicId,
    ids.practiceId,
    ids.wsDoctorId,
    ids.wsClinicId,
    ids.wsPracticeId,
  ].some((v) => v && set.has(String(v).trim().toLowerCase()));
}

/* ----------------------- ids carried by an order ------------------------ */

/** note_attributes of a REST-shaped order as a { name: value } map. */
export function orderAttrs(o) {
  const a = {};
  for (const x of o.note_attributes || []) if (x && x.name) a[x.name] = x.value;
  return a;
}

/** Line item properties merged across every line item. */
export function lineItemAttrs(o) {
  const a = {};
  for (const li of o.line_items || []) {
    for (const p of li.properties || []) if (p.value) a[p.name] = p.value;
  }
  return a;
}

/**
 * Attribution ids of a paid order, from its note attributes (rx-builder link
 * flow) or line item properties (product-page physician selector). The
 * wholesale page stamps its own "Wholesale …" attributes, kept under separate
 * ws* fields so a wholesale order stays out of the clinical dashboards' own
 * totals while still being owed in the commission ledger.
 *
 * `customerTags` (the buyer's current tags) powers the "Buy again" fallback:
 * Shopify's Buy again button rebuilds the cart with products only - no ids -
 * so a real patient's order inherits the ids on their customer record.
 */
export function attrIds(o, customerTags) {
  const a = orderAttrs(o);
  const li = lineItemAttrs(o);
  const pick = (key) => String(a[key] || li[key] || "").trim();
  const ids = {
    rxId: pick("Rx ID"),
    patientId: pick("Patient ID"),
    doctorId: pick("Doctor ID"),
    clinicId: pick("Clinic ID"),
    practiceId: pick("Practice ID"),
    wholesaleRole: pick("Wholesale Role").toLowerCase(),
    wsDoctorId: pick("Wholesale Doctor ID"),
    wsClinicId: pick("Wholesale Clinic ID"),
    wsPracticeId: pick("Wholesale Practice ID"),
    subscription: /subscription/i.test(tagList(o.tags).join(",")),
  };

  if (ids.rxId || ids.doctorId || ids.clinicId || ids.practiceId) return ids;
  if (ids.wholesaleRole || ids.wsDoctorId || ids.wsClinicId || ids.wsPracticeId) return ids;
  if (a["Rep ID"] || a["Wholesale Role"]) return ids;

  const ctags = tagList(customerTags ?? o.customer?.tags);
  const patientId = tagVal(ctags, "patient_id:");
  if (!hasTag(ctags, "patient") || !patientId) return ids;

  ids.patientId = ids.patientId || patientId;
  ids.doctorId = tagVal(ctags, "doctor_id:");
  ids.clinicId = tagVal(ctags, "clinic_id:");
  ids.practiceId = tagVal(ctags, "practice_id:");
  return ids;
}

/** True when the ids make this "one of ours" (an Rx / wholesale order). */
export function isAttributable(ids) {
  return !!(
    ids.rxId ||
    ids.doctorId ||
    ids.clinicId ||
    ids.practiceId ||
    ids.wholesaleRole
  );
}

/**
 * True when the builder's Items text has at least one line on a REAL selling
 * plan - a trailing "(...)" that isn't "(One time)". A product name such as
 * "Vitamin D (5000 IU)" must not count.
 */
export function itemsHaveRealPlan(itemsText) {
  return String(itemsText || "")
    .split(";")
    .some((seg) => {
      seg = seg.replace(/\s*[-–—]\s*Physician Note:.*$/i, "").trim();
      const m = seg.match(/\(([^()]*)\)\s*$/);
      return !!m && !/^\s*one[\s-]?time\s*$/i.test(m[1]);
    });
}

/** "₹2,50,000.00" / "$45.99" / 45.99 -> number */
export function parseAmount(v) {
  if (typeof v === "number") return v;
  return Number(String(v || "").replace(/[^0-9.]/g, "")) || 0;
}

/** The physician's display name for [doctor_name]: drops a "- Clinic" suffix
 *  and a leading "Dr"/"Dr." (the templates already write "Dr [doctor_name]"). */
export function drName(raw) {
  let s = String(raw == null ? "" : raw);
  s = s.split("-")[0].trim();
  s = s.replace(/^dr\.?\s+/i, "").trim();
  return s || "your physician";
}

/** yyyy-MM of a date in the configured timezone. */
export function monthKey(date, timeZone = "America/New_York") {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  return `${y}-${m}`;
}
