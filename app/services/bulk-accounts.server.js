import crypto from "node:crypto";
import { connectDb } from "../db.server";
import { Account, SalesRep } from "../models/index.server";
import { parseCsv } from "./catalog.server";
import { tagVal } from "./ids.server";
import { logEvent } from "./log.server";
import { ROLES, createPortalAccount } from "./provisioning.server";

/* Bulk account creation from a CSV (Accounts page → "Add bulk accounts").
   Every row goes through createPortalAccount - the same path as the single
   "Create an account" form - so ids, role tags, the sales-rep assignment,
   the practice's product copies and the welcome email all happen exactly
   as for one account.

   Columns (header names are flexible, case doesn't matter):
     Role, First Name, Last Name, Email          - required
     Sales Rep                                   - optional: RAP id, rep email or rep name
     Clinic Location                             - optional: shown as the clinic name
     Parent Practice                             - Clinic (required) / Master Clinic (optional):
                                                   PRA… id or the email of a Practice
     Parent Clinic                               - Physician (required): CLN… id or the
                                                   email of a Clinic
     Send Welcome                                - optional yes/no (else the popup's tick box)
   A parent or rep may be another row of the same file (by its email), so a
   whole practice -> clinic -> physician chain can be added in one upload. */

const COLUMNS = {
  role: ["role", "accounttype", "type"],
  firstName: ["firstname", "fname", "first"],
  lastName: ["lastname", "lname", "last", "surname"],
  email: ["email", "emailaddress"],
  rep: ["salesrep", "salesrepresentative", "rep", "repid", "salesrepid"],
  clinicLocation: ["cliniclocation", "location", "clinicname", "clinic"],
  parentPractice: ["parentpractice", "practice", "practiceid", "parentpracticeid"],
  parentClinic: ["parentclinic", "clinicid", "parentclinicid"],
  sendWelcome: ["sendwelcome", "welcome", "welcomeemail"],
};
export const BULK_TEMPLATE_HEADER = "Role,First Name,Last Name,Email,Sales Rep,Clinic Location,Parent Practice,Parent Clinic,Send Welcome";

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const ROLE_ALIASES = {
  practice: "Practice",
  practicedoctor: "Practice + Doctor", practiceanddoctor: "Practice + Doctor", practicephysician: "Practice + Doctor",
  masterclinic: "Master Clinic",
  clinic: "Clinic",
  physician: "Physician", doctor: "Physician", dr: "Physician",
  salesrep: "Sales Rep", rep: "Sales Rep", salesrepresentative: "Sales Rep",
  demo: "Demo",
};
const roleOf = (v) => ROLE_ALIASES[norm(v)] || ROLES.find((r) => norm(r) === norm(v)) || "";
const isEmail = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v || "").trim());
const yes = (v) => /^(y|yes|true|1)$/i.test(String(v || "").trim());
const no = (v) => /^(n|no|false|0)$/i.test(String(v || "").trim());

// Practices before clinics before physicians; reps first so rows can use them.
const ORDER = { "Sales Rep": 0, Practice: 1, "Practice + Doctor": 1, "Master Clinic": 2, Clinic: 3, Physician: 4 };
const PRACTICE_ROLES = new Set(["Practice", "Practice + Doctor"]);
// "Practice + Doctor" has its own clinic too, so it can be a physician's parent clinic
const CLINIC_ROLES = new Set(["Clinic", "Master Clinic", "Practice + Doctor"]);

/** CSV text -> rows (objects with the fields above) + header problems. */
function readRows(text) {
  const table = parseCsv(text);
  if (table.length < 2) return { rows: [], error: "The file has no rows under the header." };
  const head = table[0].map(norm);
  const at = {};
  for (const [field, names] of Object.entries(COLUMNS)) {
    const i = head.findIndex((h) => names.includes(h));
    if (i > -1) at[field] = i;
  }
  const missing = ["role", "firstName", "lastName", "email"].filter((f) => at[f] == null);
  if (missing.length) {
    return { rows: [], error: `Missing column(s): ${missing.map((f) => ({ role: "Role", firstName: "First Name", lastName: "Last Name", email: "Email" })[f]).join(", ")}. Expected: ${BULK_TEMPLATE_HEADER}` };
  }
  const rows = table.slice(1).map((cells, i) => {
    const get = (f) => (at[f] == null ? "" : String(cells[at[f]] ?? "").trim());
    return {
      line: i + 2, // the spreadsheet row number
      roleRaw: get("role"),
      role: roleOf(get("role")),
      firstName: get("firstName"),
      lastName: get("lastName"),
      email: get("email").toLowerCase(),
      rep: get("rep"),
      clinicLocation: get("clinicLocation"),
      parentPractice: get("parentPractice"),
      parentClinic: get("parentClinic"),
      sendWelcome: get("sendWelcome"),
    };
  });
  return { rows };
}

/**
 * Checks every row without creating anything. Each row comes back with
 * status "ready" | "update" (email already a customer) | "error", the error
 * text, and how its parent / rep resolved. Rows are in import order.
 */
export async function previewBulkAccounts(text) {
  await connectDb();
  const { rows, error } = readRows(text);
  if (error) return { ok: false, error };

  const emails = rows.map((r) => r.email).filter(Boolean);
  const [existing, repList, repAccounts, practices, clinics] = await Promise.all([
    Account.find({ email: { $in: emails } }, { email: 1, role: 1 }).lean(),
    SalesRep.find({}, { repId: 1, name: 1, email: 1 }).lean(),
    // a rep made outside the app may only be a tagged customer, not in the list
    Account.find({ repId: { $ne: "" } }, { repId: 1, first: 1, last: 1, email: 1 }).lean(),
    // every account carrying the id - incl. "Practice + Doctor" (practice AND clinic)
    Account.find({ practiceId: { $ne: "" } }, { email: 1, practiceId: 1, doctorId: 1 }).lean(),
    Account.find({ clinicId: { $ne: "" } }, { email: 1, clinicId: 1, doctorId: 1 }).lean(),
  ]);
  const existingByEmail = new Map(existing.map((a) => [a.email, a]));
  const reps = [...repList];
  for (const a of repAccounts) {
    if (!a.repId) continue;
    if (!reps.some((r) => r.repId.toLowerCase() === a.repId.toLowerCase())) {
      reps.push({ repId: a.repId, name: `${a.first || ""} ${a.last || ""}`.trim(), email: a.email });
    }
  }
  const fileByEmail = new Map();
  const seen = new Set();

  for (const r of rows) {
    const errs = [];
    if (!r.role) errs.push(r.roleRaw ? `unknown role "${r.roleRaw}" (use ${ROLES.filter((x) => x !== "Demo").join(", ")})` : "role is empty");
    if (r.role === "Demo") errs.push("Demo accounts can't be added in bulk - use the single form");
    if (!r.firstName) errs.push("first name is empty");
    if (!r.lastName) errs.push("last name is empty");
    if (!isEmail(r.email)) errs.push(r.email ? `"${r.email}" is not a valid email` : "email is empty");
    else if (seen.has(r.email)) errs.push("this email is in the file twice");
    if (r.sendWelcome && !yes(r.sendWelcome) && !no(r.sendWelcome)) errs.push(`Send Welcome "${r.sendWelcome}" - use yes or no`);
    if (isEmail(r.email)) seen.add(r.email);
    r.errors = errs;
    if (r.email && !errs.length) fileByEmail.set(r.email, r);
  }

  const findRep = (v) => {
    const s = String(v || "").trim().replace(/^rep_id:\s*/i, "");
    if (!s) return { id: "" };
    const lc = s.toLowerCase();
    const hit = reps.find((x) => String(x.repId || "").toLowerCase() === lc || (x.email || "").toLowerCase() === lc || (x.name || "").toLowerCase() === lc);
    if (hit) return { id: hit.repId, label: `${hit.name || hit.repId} (${hit.repId})` };
    const row = fileByEmail.get(lc);
    if (row && row.role === "Sales Rep") return { fromFile: lc, label: `${row.firstName} ${row.lastName} (new, row ${row.line})` };
    return { error: `sales rep "${s}" not found` };
  };
  // id (any case), tag (practice_id:… / clinic_id:…) or the email of an
  // account that carries it - same rules as resolveParent in provisioning
  const findParent = (v, kind) => {
    const s = String(v || "").trim().replace(/^(practice_id|clinic_id):\s*/i, "");
    const lc = s.toLowerCase();
    const list = kind === "practice" ? practices : clinics;
    const idField = kind === "practice" ? "practiceId" : "clinicId";
    const byId = list.find((a) => String(a[idField]).toLowerCase() === lc && !a.doctorId)
      || list.find((a) => String(a[idField]).toLowerCase() === lc);
    if (byId) return { id: byId[idField], label: byId[idField] };
    const byEmail = list.find((a) => (a.email || "").toLowerCase() === lc);
    if (byEmail) return { id: byEmail[idField], label: `${byEmail[idField]} (${byEmail.email})` };
    const row = fileByEmail.get(lc);
    const okRoles = kind === "practice" ? PRACTICE_ROLES : CLINIC_ROLES;
    if (row && okRoles.has(row.role)) return { fromFile: lc, label: `${row.firstName} ${row.lastName} (new, row ${row.line})` };
    return { error: `parent ${kind} "${s}" not found (use its ${kind === "practice" ? "PRA" : "CLN"}… id, ${kind}_id: tag, or the email of that ${kind}'s account)` };
  };

  for (const r of rows) {
    if (r.role && r.role !== "Sales Rep" && r.role !== "Demo") {
      const rep = findRep(r.rep);
      if (rep.error) r.errors.push(rep.error);
      r.repResolved = rep;
    } else r.repResolved = { id: "" };

    r.parentResolved = null;
    if (r.role === "Clinic" || (r.role === "Master Clinic" && r.parentPractice)) {
      if (!r.parentPractice) r.errors.push("a Clinic needs a Parent Practice");
      else {
        const p = findParent(r.parentPractice, "practice");
        if (p.error) r.errors.push(p.error);
        r.parentResolved = { kind: "practice", ...p };
      }
    } else if (r.role === "Physician") {
      if (!r.parentClinic) r.errors.push("a Physician needs a Parent Clinic");
      else {
        const p = findParent(r.parentClinic, "clinic");
        if (p.error) r.errors.push(p.error);
        r.parentResolved = { kind: "clinic", ...p };
      }
    }
    r.status = r.errors.length ? "error" : existingByEmail.has(r.email) ? "update" : "ready";
    if (r.status === "update") r.note = `already a customer (${existingByEmail.get(r.email).role || "no role"}) - will be updated`;
  }

  // a row whose parent / rep row has an error can't be created either
  for (const r of rows) {
    for (const ref of [r.parentResolved?.fromFile, r.repResolved?.fromFile].filter(Boolean)) {
      const dep = rows.find((x) => x.email === ref);
      if (dep && dep.status === "error" && r.status !== "error") {
        r.status = "error";
        r.errors.push(`depends on row ${dep.line}, which has an error`);
      }
    }
  }

  rows.sort((a, b) => (ORDER[a.role] ?? 9) - (ORDER[b.role] ?? 9) || a.line - b.line);
  return {
    ok: true,
    rows: rows.map((r) => ({
      line: r.line, role: r.role || r.roleRaw, name: `${r.firstName} ${r.lastName}`.trim(), email: r.email,
      parent: r.parentResolved ? (r.parentResolved.label || r.parentResolved.error || "") : "",
      rep: r.repResolved?.label || r.rep || "",
      clinicLocation: r.clinicLocation,
      sendWelcome: r.sendWelcome,
      status: r.status, message: r.errors.join("; ") || r.note || "",
      // what the import needs
      _raw: r,
    })),
    counts: {
      ready: rows.filter((r) => r.status === "ready").length,
      update: rows.filter((r) => r.status === "update").length,
      error: rows.filter((r) => r.status === "error").length,
    },
  };
}

/* Imports run in the background (each account is several Shopify calls);
   the page polls bulkJobStatus(id) for progress. */
const jobs = new Map();

export function bulkJobStatus(id) {
  const j = jobs.get(String(id));
  return j ? { ok: true, ...j } : { ok: false, error: "This import is no longer running - see the account list and Sync & logs." };
}

/** Starts the import of every row that previews as ready / update. */
export async function startBulkImport(text, { sendWelcome = true } = {}) {
  const preview = await previewBulkAccounts(text);
  if (!preview.ok) return preview;
  const todo = preview.rows.filter((r) => r.status !== "error");
  if (!todo.length) return { ok: false, error: "No rows can be imported - fix the errors first." };

  const id = crypto.randomUUID();
  const job = { id, total: todo.length, done: 0, created: 0, updated: 0, failed: 0, finished: false, results: [] };
  jobs.set(id, job);

  (async () => {
    const madeIds = new Map(); // email -> { practiceId, clinicId, repId } of rows created in this run
    for (const row of todo) {
      const r = row._raw;
      const input = {
        role: r.role, firstName: r.firstName, lastName: r.lastName, email: r.email,
        clinicLocation: r.clinicLocation,
        sendWelcome: String(r.sendWelcome ? yes(r.sendWelcome) : sendWelcome),
      };
      const rp = r.repResolved || {};
      input.repId = rp.fromFile ? madeIds.get(rp.fromFile)?.repId || "" : rp.id || "";
      const pp = r.parentResolved;
      if (pp?.kind === "practice") input.parentPracticeId = pp.fromFile ? madeIds.get(pp.fromFile)?.practiceId || "" : pp.id;
      if (pp?.kind === "clinic") input.parentClinicId = pp.fromFile ? madeIds.get(pp.fromFile)?.clinicId || "" : pp.id;

      let res;
      if ((pp?.fromFile && !input.parentPracticeId && !input.parentClinicId)) {
        res = { ok: false, error: `its parent (row for ${pp.fromFile}) was not created` };
      } else {
        try {
          res = await createPortalAccount(input);
        } catch (err) {
          res = { ok: false, error: String(err.message || err) };
        }
      }
      if (res.ok) {
        madeIds.set(r.email, {
          practiceId: tagVal(res.tags, "practice_id:"),
          clinicId: tagVal(res.tags, "clinic_id:"),
          repId: tagVal(res.tags, "rep_id:"),
        });
        res.updated ? job.updated++ : job.created++;
      } else job.failed++;
      job.done++;
      job.results.push({
        line: r.line, email: r.email, role: r.role,
        ok: !!res.ok,
        message: res.ok
          ? `${res.updated ? "Updated" : "Created"} - ${res.tags.filter((t) => /_id:/.test(t)).join(", ")}`
          : res.error,
      });
    }
    job.finished = true;
    logEvent("sync", "bulk-accounts", `bulk import finished: ${job.created} created, ${job.updated} updated, ${job.failed} failed`, null, !job.failed);
    setTimeout(() => jobs.delete(id), 60 * 60 * 1000); // kept an hour for the page to read
  })();

  return { ok: true, jobId: id, total: todo.length };
}
