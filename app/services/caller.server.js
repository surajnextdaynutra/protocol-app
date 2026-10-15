import { connectDb } from "../db.server";
import { Account } from "../models/index.server";
import { authenticate } from "../shopify.server";
import { practiceInfo } from "./directory.server";
import { demoIdSet, hasTag, idsFromCustomerTags, tagList } from "./ids.server";
import { getCustomerTags } from "./shopify-admin.server";

/* Who is calling the storefront API.

   Every /apps/rx/* request comes through Shopify's App Proxy: Shopify signs
   it and adds the logged-in customer's id. That signature - not a shared
   secret printed in the page - is what the API trusts. The ids a page sends
   (doctor=…, practice=…) are only ever *requests*; `scope*` below decides
   what this customer may actually see. */

export class ApiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const tagCache = new Map(); // customerId -> { at, tags }
const TAG_TTL = 60_000;

/** Called by the customers/update webhook so a role change applies at once. */
export function forgetCustomer(customerId) {
  tagCache.delete(String(customerId));
}

async function customerTags(customerId) {
  const hit = tagCache.get(customerId);
  if (hit && Date.now() - hit.at < TAG_TTL) return hit.tags;
  let tags = null;
  await connectDb();
  const acct = await Account.findOne({ customerId }, { tags: 1 }).lean();
  if (acct) tags = acct.tags;
  if (!tags) tags = await getCustomerTags(customerId); // patients, or accounts not synced yet
  tags = tagList(tags || []);
  tagCache.set(customerId, { at: Date.now(), tags });
  return tags;
}

/**
 * Verifies the App Proxy signature and resolves the caller.
 * Returns { customerId, tags, doctorId, clinicId, clinicIds, practiceId,
 *           repId, isRep, isFinance, isWholesale, demoIds } - customerId is
 * '' for a logged-out visitor.
 */
export async function getCaller(request) {
  await authenticate.public.appProxy(request); // throws a 401 Response on a bad signature
  const url = new URL(request.url);
  const customerId = String(url.searchParams.get("logged_in_customer_id") || "");
  const caller = {
    customerId,
    tags: [],
    doctorId: "",
    clinicId: "",
    clinicIds: [],
    practiceId: "",
    repId: "",
    isRep: false,
    isFinance: false,
    isWholesale: false,
    demoIds: await demoIdSet(),
  };
  if (!customerId) return caller;

  const tags = await customerTags(customerId);
  const ids = idsFromCustomerTags(tags);
  Object.assign(caller, {
    tags,
    doctorId: ids.doctorId,
    clinicId: ids.clinicId,
    clinicIds: ids.clinicIds,
    practiceId: ids.practiceId,
    repId: ids.repId,
    isRep: !!ids.repId || hasTag(tags, "wholesale_rep"),
    isFinance: ids.finance,
    isWholesale: ids.wholesale,
  });
  // A practice-level account: practice_id alone.
  caller.isPracticeMaster = !!caller.practiceId && !caller.doctorId && !caller.clinicId;
  // A clinic's own account: clinic_id, no doctor_id.
  caller.isClinicAccount = caller.clinicIds.length > 0 && !caller.doctorId;
  // A solo owner-operator is physician, clinic and practice in one account:
  // the only doctor of a practice that has no separate Practice Master.
  caller.isSolo = false;
  if (caller.doctorId && caller.practiceId) {
    try {
      caller.isSolo = !!(await practiceInfo(caller.practiceId)).soloDoctor;
    } catch {
      caller.isSolo = false;
    }
  }
  return caller;
}

export function requireLogin(caller) {
  if (!caller.customerId) throw new ApiError("Please log in to continue.", 401);
}

const isDemo = (caller, id) => !!id && caller.demoIds.has(String(id).toLowerCase());

/** A sales rep viewing the shared demo Practice / Clinic / Physician. */
const repOnDemo = (caller, ...ids) =>
  caller.isRep && ids.filter(Boolean).length > 0 && ids.filter(Boolean).every((id) => isDemo(caller, id));

/* Each `can*` answers: may this customer see data for that id?
   Sharing a practice_id is NOT enough - a physician inside a practice must
   not see a colleague's figures, the clinic's or the practice's. Finance
   admins may see everything. */

/** Practice-level data: the Practice Master, or a solo owner-operator. */
export function canSeePractice(caller, practiceId) {
  if (!practiceId) return false;
  if (caller.isFinance) return true;
  if (caller.practiceId === practiceId && (caller.isPracticeMaster || caller.isSolo)) return true;
  return repOnDemo(caller, practiceId);
}

/** Clinic-level data: the clinic's own account, or a solo owner-operator. */
export function canSeeClinic(caller, clinicId) {
  if (!clinicId) return false;
  if (caller.isFinance) return true;
  if (caller.clinicIds.includes(clinicId) && (caller.isClinicAccount || caller.isSolo)) return true;
  return repOnDemo(caller, clinicId);
}

export function canSeeDoctor(caller, doctorId) {
  if (!doctorId) return false;
  if (caller.isFinance) return true;
  if (caller.doctorId && caller.doctorId === doctorId) return true;
  return repOnDemo(caller, doctorId);
}

export function canSeeRep(caller, repId) {
  if (!repId) return false;
  return caller.isFinance || (caller.repId && caller.repId === repId);
}

/** Membership only: the id is one of the caller's own tags. Enough to WRITE
 *  a prescription under those ids or read a practice's name / product list;
 *  never enough to read someone else's money. */
export function isOwnId(caller, kind, id) {
  if (!id) return false;
  if (caller.isFinance || repOnDemo(caller, id)) return true;
  if (kind === "doctor") return caller.doctorId === id;
  if (kind === "clinic") return caller.clinicIds.includes(id);
  if (kind === "practice") return caller.practiceId === id;
  return false;
}

/**
 * Throws unless the caller may see every id requested. A practice member may
 * also drill into the clinics / doctors of their own practice - `belongs`
 * (optional async fn) confirms a clinic / doctor is inside that practice.
 */
export async function requireScope(caller, { practice, clinics = [], doctors = [] }, belongs) {
  requireLogin(caller);
  if (practice && !canSeePractice(caller, practice)) {
    throw new ApiError("You do not have access to this practice.", 403);
  }
  // A Practice Master (or solo owner) may drill into its own clinics / doctors.
  const viaPractice = async (kind, id) =>
    !!belongs &&
    !!caller.practiceId &&
    canSeePractice(caller, caller.practiceId) &&
    (await belongs(caller.practiceId, kind, id));

  for (const c of clinics) {
    if (canSeeClinic(caller, c) || (await viaPractice("clinic", c))) continue;
    throw new ApiError("You do not have access to this clinic.", 403);
  }
  for (const d of doctors) {
    if (canSeeDoctor(caller, d) || (await viaPractice("doctor", d))) continue;
    // a clinic's own account may see the doctors assigned to that clinic
    if (belongs && caller.isClinicAccount && (await anyClinicHas(caller, d, belongs))) continue;
    throw new ApiError("You do not have access to this physician.", 403);
  }
}

async function anyClinicHas(caller, doctorId, belongs) {
  for (const c of caller.clinicIds) {
    if (await belongs(c, "clinic-doctor", doctorId)) return true;
  }
  return false;
}
