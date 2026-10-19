import { loadAbout, saveAbout, uploadAboutImage } from "../services/about.server";
import { getAccount, orderHistory, updateAccount } from "../services/account.server";
import { loadBanking, saveBanking } from "../services/banking.server";
import {
  ApiError,
  canSeeClinic,
  canSeeDoctor,
  canSeePractice,
  canSeeRep,
  isOwnId,
  requireLogin,
  requireScope,
} from "../services/caller.server";
import { csvToArr } from "../services/dashboards/common.server";
import { clinicDashboard } from "../services/dashboards/clinic.server";
import {
  financeDashboard,
  financeOrderDetail,
  setPayoutStatus,
  uploadPayoutsCsv,
} from "../services/dashboards/finance.server";
import {
  doctorPeriodOrders,
  physicianDashboard,
  sendCheckoutLink,
} from "../services/dashboards/physician.server";
import { practiceDashboard, practicePeriodOrders } from "../services/dashboards/practice.server";
import { repBankingSave, repDashboard } from "../services/dashboards/rep.server";
import {
  clinicDoctors,
  clinicInfo,
  practiceAccountInfo,
  practiceInfo,
  practiceStructure,
} from "../services/directory.server";
import { productEarnings, saveProductEarnings } from "../services/earnings.server";
import { saveContact, saveReferral } from "../services/forms.server";
import { connectDb } from "../db.server";
import { Account } from "../models/index.server";
import {
  confirmRx,
  guardCheckEmail,
  patientHistory,
  searchPatients,
  sendRx,
  trackEvent,
} from "../services/prescriptions.server";
import {
  listPracticeProducts,
  updateProductCommission,
  updateProductPrice,
} from "../services/products.server";

/* resource -> action -> handler({ p, caller, ... }).
   `p` is the merged query + JSON body. Ids in `p` are what the page asked
   for; every handler checks them against `caller` before answering. */

const ping = (app) => () => ({ ok: true, app, at: new Date().toISOString() });

/** Is this clinic / doctor inside that practice (or clinic)? */
async function belongs(ownerId, kind, id) {
  if (kind === "clinic-doctor") {
    return (await clinicDoctors(ownerId)).some((d) => d.id === id);
  }
  const tree = await practiceStructure(ownerId);
  if (kind === "clinic") return tree.clinics.some((c) => c.id === id);
  return (
    tree.unassigned.some((d) => d.id === id) ||
    tree.clinics.some((c) => c.doctors.some((d) => d.id === id))
  );
}

/** The provider ids a prescriber may act as: their own, or the demo trio
 *  for a sales rep. Anything else the page sent is ignored. */
function prescriberScope(caller, p) {
  requireLogin(caller);
  const doctor = String(p.doctor ?? p.doctorId ?? "").trim();
  const clinic = String(p.clinic ?? p.clinicId ?? "").trim();
  const practice = String(p.practiceId ?? p.practice ?? "").trim();
  // Membership is what matters here: the ids must be the caller's own.
  if (doctor && !isOwnId(caller, "doctor", doctor)) throw new ApiError("You do not have access to this physician.", 403);
  if (clinic && !isOwnId(caller, "clinic", clinic)) throw new ApiError("You do not have access to this clinic.", 403);
  if (practice && !isOwnId(caller, "practice", practice)) throw new ApiError("You do not have access to this practice.", 403);
  if (!caller.isWholesale && !caller.isRep && !caller.isFinance) {
    throw new ApiError("This account cannot write prescriptions.", 403);
  }
  return { doctor, clinic, practice };
}

/** Any member of the practice (names, physician count, product list). */
function requireMember(caller, practiceId) {
  requireLogin(caller);
  if (!isOwnId(caller, "practice", practiceId)) throw new ApiError("You do not have access to this practice.", 403);
}

/* ------------------------- prescription builder ------------------------- */
const builder = {
  ping: ping("rx-builder"),
  search: ({ p, caller }) => {
    const s = prescriberScope(caller, p);
    return searchPatients(p.q, s.doctor, s.clinic, p.limit);
  },
  patientHistory: ({ p, caller }) => {
    const s = prescriberScope(caller, p);
    return patientHistory(p.patientId, p.email, s.doctor, s.clinic);
  },
  guardcheck: ({ p, caller }) => {
    prescriberScope(caller, p);
    return guardCheckEmail(p.email);
  },
  confirm: ({ p, caller }) => {
    prescriberScope(caller, p);
    return confirmRx(p);
  },
  send: ({ p, caller }) => {
    prescriberScope(caller, p);
    return sendRx(p);
  },
};

/* ---------------------------- prescription cart ------------------------- */
// The patient opening a prescription link is often not logged in, so tracking
// is open - it can only stamp opened / checkout on an existing Rx ID.
const cart = {
  ping: ping("rx-cart"),
  track: ({ p }) => trackEvent(p),
};

/* --------------------------- practice dashboard ------------------------- */
const practice = {
  ping: ping("rx-practice"),
  dashboard: async ({ p, caller }) => {
    await requireScope(
      caller,
      { practice: String(p.practice || "").trim(), clinics: csvToArr(p.clinic), doctors: csvToArr(p.doctor) },
      belongs,
    );
    return practiceDashboard(p);
  },
  products: async ({ p, caller }) => {
    const practiceId = String(p.practice_id || "").trim();
    const clinicId = String(p.clinic_id || "").trim();
    const doctorId = String(p.doctor_id || "").trim();
    requireLogin(caller);
    const ok =
      (practiceId && isOwnId(caller, "practice", practiceId)) ||
      (!practiceId && clinicId && isOwnId(caller, "clinic", clinicId)) ||
      (!practiceId && !clinicId && doctorId && isOwnId(caller, "doctor", doctorId));
    if (!ok) throw new ApiError("You do not have access to these products.", 403);
    // whose earnings the table shows: this physician, else this clinic, else the practice's defaults
    const viewer = {
      doctorId: doctorId && isOwnId(caller, "doctor", doctorId) ? doctorId : "",
      clinicId: clinicId && isOwnId(caller, "clinic", clinicId) ? clinicId : "",
    };
    return listPracticeProducts(doctorId, clinicId, practiceId, viewer);
  },
  // Product Pricing Management -> one product's clinic / physician earnings
  earnings: ({ p, caller }) => {
    requireLogin(caller);
    return productEarnings(caller, String(p.productId || "").trim());
  },
  saveEarnings: ({ p, caller }) => {
    requireLogin(caller);
    return saveProductEarnings(caller, String(p.productId || "").trim(), p.entries);
  },
  practiceInfo: async ({ p, caller }) => {
    const id = String(p.practice || "").trim();
    if (!id) return { ok: false, error: "missing practice id" };
    requireMember(caller, id);
    return practiceInfo(id);
  },
  // Business names only - shown to patients on storefront pages, who are
  // often not logged in.
  clinicInfo: async ({ p }) => {
    const id = String(p.clinic || "").trim();
    if (!id) return { ok: false, error: "missing clinic id" };
    return clinicInfo(id);
  },
  practiceAccountInfo: async ({ p }) => {
    const id = String(p.practice || "").trim();
    if (!id) return { ok: false, error: "missing practice id" };
    return practiceAccountInfo(id);
  },
  payoutOrders: async ({ p, caller }) => {
    const id = String(p.practice || "").trim();
    if (!id) return { ok: false, error: "missing practice id" };
    await requireScope(caller, { practice: id });
    return practicePeriodOrders(id, Number(p.from) || 0, Number(p.to) || 0);
  },
  load: async ({ p, caller }) => {
    await requireScope(caller, { practice: String(p.practice_id || "").trim() });
    return loadBanking("practice", p.practice_id);
  },
  save: async ({ p, caller }) => {
    const fields = Array.isArray(p.fields) ? p.fields : [];
    const practiceId = String((fields.find((f) => f && f.key === "practice_id") || {}).value || "").trim();
    if (!practiceId) return { error: "practice_id is required" };
    await requireScope(caller, { practice: practiceId });
    return saveBanking("practice", practiceId, fields, caller.customerId);
  },
  getAccount: ({ caller }) => {
    requireLogin(caller);
    return getAccount(caller.customerId);
  },
  updateAccount: ({ p, caller }) => {
    requireLogin(caller);
    return updateAccount(caller.customerId, p);
  },
  updatePrice: async ({ p, caller }) => {
    requireLogin(caller);
    return updateProductPrice(p, caller);
  },
  updateCommission: async ({ p, caller }) => {
    requireLogin(caller);
    return updateProductCommission(p, caller);
  },
};

/* ------------------------------ my account ------------------------------ */
const account = {
  ping: ping("account"),
  getAccount: practice.getAccount,
  updateAccount: practice.updateAccount,
  orderHistory: ({ p, caller }) => {
    requireLogin(caller);
    return orderHistory(caller.customerId, {
      limit: parseInt(p.limit, 10) || 20,
      wholesaleOnly: String(p.wholesaleOnly || "") === "1",
    });
  },
};

/* --------------------------- physician dashboard ------------------------ */
/**
 * Access for the physician dashboard. With a doctor id the figures are that
 * doctor's own and a clinic id only narrows them - so the clinic just has to
 * be that doctor's clinic (a physician inside a clinic may not see the
 * clinic's own figures, but does send its id). Without one, the clinic's
 * figures need clinic-level access.
 */
async function requirePhysicianScope(caller, doctorId, clinicId) {
  if (!doctorId) {
    await requireScope(caller, { clinics: clinicId ? [clinicId] : [] }, belongs);
    return;
  }
  await requireScope(caller, { doctors: [doctorId] }, belongs);
  if (clinicId && !isOwnId(caller, "clinic", clinicId) && !(await belongs(clinicId, "clinic-doctor", doctorId))) {
    throw new ApiError("You do not have access to this clinic.", 403);
  }
}

const physician = {
  ping: ping("rx-physician"),
  dashboard: async ({ p, caller }) => {
    await requirePhysicianScope(caller, String(p.doctor || "").trim(), String(p.clinic || "").trim());
    return physicianDashboard(p);
  },
  sendLink: async ({ p, caller }) => {
    const clinicId = String(p.clinic || "").trim();
    const doctorId = String(p.doctor || "").trim();
    if (!clinicId && !doctorId) return { ok: false, error: "missing clinic or doctor id" };
    await requirePhysicianScope(caller, doctorId, clinicId);
    return sendCheckoutLink(p.rxId, doctorId, clinicId);
  },
  // public: the storefront's physician / clinic bar shows this to patients
  clinicName: async ({ p }) => {
    const id = String(p.clinic || "").trim();
    if (!id) return { ok: false, error: "missing clinic id" };
    return { ok: true, clinic: id, clinicName: (await clinicInfo(id)).name || "" };
  },
  practiceInfo: async ({ p, caller }) => {
    const id = String(p.practice || "").trim();
    if (!id) return { ok: false, error: "missing practice id" };
    requireMember(caller, id);
    const info = await practiceInfo(id);
    // the physician page's own "solo" rule (see directory.practiceInfo)
    return {
      ok: true,
      practiceId: id,
      physicianCount: info.physicianCount,
      practiceMaster: info.practiceMaster,
      solo: info.soloDoctor,
    };
  },
  payoutOrders: async ({ p, caller }) => {
    const id = String(p.doctor || "").trim();
    if (!id) return { ok: false, error: "missing doctor id" };
    await requireScope(caller, { doctors: [id] }, belongs);
    return doctorPeriodOrders(id, Number(p.from) || 0, Number(p.to) || 0);
  },
  // Banking Details + pricing on a solo physician's own dashboard are the
  // practice's record.
  load: practice.load,
  save: practice.save,
  products: practice.products,
  updatePrice: practice.updatePrice,
  getAccount: practice.getAccount,
  updateAccount: practice.updateAccount,
};

/* ----------------------------- clinic dashboard ------------------------- */
const clinic = {
  ping: ping("rx-clinic"),
  dashboard: async ({ p, caller }) => {
    const id = String(p.clinic || "").trim();
    if (!id) return { ok: false, error: "missing clinic id" };
    await requireScope(caller, { clinics: [id] }, belongs);
    return clinicDashboard(p);
  },
  bankingLoad: async ({ p, caller }) => {
    const id = String(p.clinic || "").trim();
    if (!id) return { ok: false, error: "missing clinic id" };
    await requireScope(caller, { clinics: [id] }, belongs);
    const res = await loadBanking("clinic", id);
    return { ok: true, found: !!res.found, fields: res.fields };
  },
  // clinic_id always comes from the verified clinic id, never from the fields.
  bankingSave: async ({ p, caller }) => {
    const id = String(p.clinic || "").trim();
    if (!id) return { ok: false, error: "missing clinic id" };
    await requireScope(caller, { clinics: [id] }, belongs);
    const fields = p.fields && typeof p.fields === "object" ? { ...p.fields } : {};
    delete fields.clinic_id;
    const res = await saveBanking("clinic", id, fields, caller.customerId, { lock: false });
    return res.error ? { ok: false, error: res.error } : { ok: true, handle: res.handle };
  },
  getAccount: practice.getAccount,
  updateAccount: practice.updateAccount,
};

/* ---------------------------- sales rep dashboard ----------------------- */
function requireRep(caller, p) {
  requireLogin(caller);
  if (!canSeeRep(caller, String(p.rep || "").trim())) {
    throw new ApiError("You do not have access to this sales rep account.", 403);
  }
}
const rep = {
  ping: ping("rx-rep"),
  repdash: ({ p, caller }) => {
    requireRep(caller, p);
    return repDashboard(p);
  },
  banking: ({ p, caller }) => {
    requireRep(caller, p);
    return repBankingSave(p, caller.customerId);
  },
};

/* ----------------------------- finance dashboard ------------------------ */
function requireFinance(caller) {
  requireLogin(caller);
  if (!caller.isFinance) throw new ApiError("This dashboard is only available to finance admins.", 403);
}
const finance = {
  ping: ping("rx-finance-admin"),
  admindash: ({ p, caller }) => {
    requireFinance(caller);
    return financeDashboard(p);
  },
  orderDetail: ({ p, caller }) => {
    requireFinance(caller);
    return financeOrderDetail(p);
  },
  setPayoutStatus: ({ p, caller }) => {
    requireFinance(caller);
    return setPayoutStatus(p);
  },
  uploadPayoutsCsv: ({ p, caller }) => {
    requireFinance(caller);
    return uploadPayoutsCsv(p);
  },
};

/* -------------------------- About Us page editor ------------------------ */
// A physician edits their own page; clinic / practice staff the pages of
// their own clinic / practice.
async function requireAboutScope(caller, ids) {
  requireLogin(caller);
  const ok =
    isOwnId(caller, "doctor", ids.doctor_id) ||
    canSeeClinic(caller, ids.clinic_id) ||
    canSeePractice(caller, ids.practice_id);
  if (!ok) throw new ApiError("You do not have access to this About Us page.", 403);
}
const about = {
  ping: () => ({ ok: true }),
  aboutUsLoad: async ({ p, caller }) => {
    await requireAboutScope(caller, p);
    return loadAbout(p);
  },
  aboutUsSave: async ({ p, caller }) => {
    const fields = Array.isArray(p.fields) ? p.fields : [];
    const val = (k) => String((fields.find((x) => x && x.key === k) || {}).value || "").trim();
    await requireAboutScope(caller, { doctor_id: val("doctor_id"), clinic_id: val("clinic_id"), practice_id: val("practice_id") });
    return saveAbout(fields);
  },
  aboutUsUploadImage: ({ p, caller }) => {
    requireLogin(caller);
    if (!caller.isWholesale && !caller.isRep && !caller.isFinance) {
      throw new ApiError("This account cannot upload images.", 403);
    }
    return uploadAboutImage(p);
  },
};

/* --------------------------------- forms -------------------------------- */
// New Client / Sales Referral form (rep dashboard) + the public contact form.
const form = {
  save: ({ p, caller }) => {
    if (p.mo === "referral") {
      requireLogin(caller);
      return saveReferral(p.fields, p.repName, p.repEmail, { customerId: caller.customerId });
    }
    if (p.mo === "contact") return saveContact(p.fields, { customerId: caller.customerId });
    return { error: "Unknown action" };
  },
};
const support = {
  ping: () => ({ ok: true, app: "contact-support-form", at: new Date().toISOString() }),
  save: ({ p, caller }) => {
    if (p.mo !== "contact") return { error: "Unknown action" };
    return saveContact(p.fields, { customerId: caller.customerId });
  },
};

/* ----------------------------- physician list --------------------------- */
// Public: the storefront's physician selector needs names + ids. Email and
// phone are NOT included (the old endpoint exposed them to anyone).
const PUBLIC_TAG = /^(doctor_id|clinic_id|practice_id|clinic_location|clinic_name|practice_location):/i;
const physicians = {
  ping: ping("rx-physician-list"),
  customers: async () => {
    await connectDb();
    const rows = await Account.find({ wholesale: true, demo: { $ne: true } }).lean();
    const seen = new Set();
    const out = [];
    for (const c of rows) {
      const key = c.doctorId || c.clinicId || c.practiceId
        ? `${c.doctorId}|${c.clinicId}|${c.practiceId}`
        : c.customerId;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: "gid://shopify/Customer/" + c.customerId,
        first_name: c.first || "",
        last_name: c.last || "",
        name: `${c.first || ""} ${c.last || ""}`.trim(),
        doctor_id: c.doctorId,
        clinic_id: c.clinicId,
        practice_id: c.practiceId,
        company: c.company || "",
        tags: ["wholesale", ...(c.tags || []).filter((t) => PUBLIC_TAG.test(t))],
      });
    }
    // Plain array -> the server's response cache (cleared on every account
    // write) serves repeats, sent no-store. The old 5-minute browser cache
    // kept showing a clinic location after it was changed in the app.
    return out;
  },
};

/* ---------------- physician portal banking form + pricing ---------------- */
// Same practice-level record the Practice Dashboard edits.
const banking = { ping: () => ({ ok: true }), load: practice.load, save: practice.save };

// "Product Price Management": the request carries no action name and the
// page expects { status: "success" | "error" }.
const pricing = {
  ping: ping("product-price-management"),
  default: async ({ p, caller }) => {
    requireLogin(caller);
    const res = await updateProductPrice(p, caller);
    return res.ok
      ? { status: "success", productId: res.productId, newPrice: res.newPrice, updatedVariants: res.updatedVariants, message: res.message }
      : { status: "error", message: res.error };
  },
};

export const resources = {
  about,
  form,
  support,
  physicians,
  banking,
  pricing, builder, cart, practice, physician, clinic, rep, finance, account };
