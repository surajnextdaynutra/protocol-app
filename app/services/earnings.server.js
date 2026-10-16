import { connectDb } from "../db.server";
import { EarningOverride, Product } from "../models/index.server";
import { ApiError, canSeePractice } from "./caller.server";
import { clinicDoctors, practiceStructure } from "./directory.server";
import { legacyId } from "./shopify-admin.server";

/* Per clinic / per physician earnings.

   Every practice product carries a DEFAULT physician and clinic earning
   (custom.physician_commission / custom.clinic_commission, set on Product
   Pricing Management). The practice may give one clinic or one physician
   its own $ per unit on a product instead - an EarningOverride. The
   commission split, and the earnings a clinic / physician sees on their own
   Product Pricing page, use the override when there is one and the default
   otherwise. */

/** Stable key for one practice product: its master key (the same across a
 *  re-created copy), else its product id. */
export const productKey = (p) => (p?.masterKey ? `m:${p.masterKey}` : `p:${legacyId(p?.productId || "")}`);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Overrides that apply to one order / viewer: { productKey: { physician?, clinic? } }.
 * A key is only present for a role when that doctor / clinic has an override.
 */
export async function overridesFor(practiceId, { doctorId = "", clinicId = "" }, keys) {
  const out = {};
  keys = [...new Set((keys || []).filter(Boolean))];
  if (!practiceId || !keys.length || (!doctorId && !clinicId)) return out;
  await connectDb();
  const or = [];
  if (doctorId) or.push({ role: "physician", entityId: doctorId });
  if (clinicId) or.push({ role: "clinic", entityId: clinicId });
  const rows = await EarningOverride.find({ practiceId, productKey: { $in: keys }, $or: or }).lean();
  for (const r of rows) (out[r.productKey] ||= {})[r.role] = r.amount;
  return out;
}

/**
 * Fills in what the viewer of a Product Pricing table earns on each row
 * (`list` = listPracticeProducts rows, each with `_key`, `_practiceId`):
 *   physician -> physicianCommission / clinicCommission = their own amounts
 *   clinic    -> clinicCommission = its own; physicianMin / physicianMax =
 *                the range across the clinic's physicians
 *   practice  -> customEarnings = how many clinics / physicians have their own
 * Defaults stay on physicianDefault / clinicDefault.
 */
export async function applyViewerEarnings(list, viewer) {
  for (const p of list) {
    p.physicianDefault = p.physicianCommission;
    p.clinicDefault = p.clinicCommission;
  }
  const practiceId = list.find((p) => p._practiceId)?._practiceId || "";
  if (!practiceId || !list.length) return list;
  await connectDb();
  const keys = list.map((p) => p._key);

  if (viewer.doctorId) {
    const own = await overridesFor(practiceId, { doctorId: viewer.doctorId, clinicId: viewer.clinicId }, keys);
    for (const p of list) {
      const o = own[p._key] || {};
      if (o.physician != null) p.physicianCommission = o.physician;
      if (o.clinic != null) p.clinicCommission = o.clinic;
    }
    return list;
  }

  if (viewer.clinicId) {
    const own = await overridesFor(practiceId, { clinicId: viewer.clinicId }, keys);
    const doctorIds = (await clinicDoctors(viewer.clinicId)).map((d) => d.id);
    const rows = doctorIds.length
      ? await EarningOverride.find({ practiceId, productKey: { $in: keys }, role: "physician", entityId: { $in: doctorIds } }).lean()
      : [];
    const byKey = {};
    for (const r of rows) (byKey[r.productKey] ||= {})[r.entityId] = r.amount;
    for (const p of list) {
      const o = own[p._key] || {};
      if (o.clinic != null) p.clinicCommission = o.clinic;
      const amounts = doctorIds.length
        ? doctorIds.map((id) => byKey[p._key]?.[id] ?? p.physicianDefault)
        : [p.physicianDefault];
      p.physicianMin = Math.min(...amounts);
      p.physicianMax = Math.max(...amounts);
    }
    return list;
  }

  const counts = await EarningOverride.aggregate([
    { $match: { practiceId, productKey: { $in: keys } } },
    { $group: { _id: "$productKey", n: { $sum: 1 } } },
  ]);
  const n = Object.fromEntries(counts.map((c) => [c._id, c.n]));
  for (const p of list) p.customEarnings = n[p._key] || 0;
  return list;
}

/** The product, checked to be a practice product the caller manages. */
async function managedProduct(caller, productId) {
  await connectDb();
  const p = await Product.findOne({ productId: legacyId(productId) }).lean();
  if (!p) throw new ApiError("Product not found", 404);
  if (!p.practiceId || !canSeePractice(caller, p.practiceId)) {
    throw new ApiError("Only the Practice can set clinic / physician earnings for this product.", 403);
  }
  return p;
}

const amountOrNull = (v) => (v == null || v === "" ? null : Number(v));

/**
 * Editor data for one product: its defaults and every clinic / physician of
 * the practice with their own amount (null = uses the default).
 */
export async function productEarnings(caller, productId) {
  const p = await managedProduct(caller, productId);
  const key = productKey(p);
  const [tree, rows] = await Promise.all([
    practiceStructure(p.practiceId),
    EarningOverride.find({ practiceId: p.practiceId, productKey: key }).lean(),
  ]);
  const own = {};
  for (const r of rows) own[`${r.role}:${r.entityId}`] = r.amount;
  const doctor = (d) => ({ id: d.id, name: d.name, amount: own[`physician:${d.id}`] ?? null });
  return {
    ok: true,
    productId: legacyId(p.productId),
    title: p.title,
    practiceId: p.practiceId,
    defaults: { physician: p.physicianCommission || 0, clinic: p.clinicCommission || 0 },
    clinics: tree.clinics.map((c) => ({
      id: c.id,
      name: c.name,
      amount: own[`clinic:${c.id}`] ?? null,
      doctors: c.doctors.map(doctor),
    })),
    unassigned: tree.unassigned.map(doctor),
  };
}

/**
 * Saves the editor: entries = [{ role, id, amount }]. A blank amount removes
 * that clinic's / physician's own earning (back to the default). Every id
 * must be a clinic / physician of the product's own practice.
 */
export async function saveProductEarnings(caller, productId, entries) {
  const p = await managedProduct(caller, productId);
  if (!Array.isArray(entries)) return { ok: false, error: "entries must be a list" };
  const key = productKey(p);
  const tree = await practiceStructure(p.practiceId);
  const clinics = new Set(tree.clinics.map((c) => c.id));
  const doctors = new Set([...tree.unassigned, ...tree.clinics.flatMap((c) => c.doctors)].map((d) => d.id));

  const ops = [];
  for (const e of entries) {
    const role = String(e?.role || "");
    const id = String(e?.id || "").trim();
    if (role !== "physician" && role !== "clinic") return { ok: false, error: `unknown role "${role}"` };
    if (!(role === "clinic" ? clinics : doctors).has(id)) {
      return { ok: false, error: `${id} is not a ${role} of practice ${p.practiceId}` };
    }
    const amount = amountOrNull(e.amount);
    const filter = { practiceId: p.practiceId, productKey: key, role, entityId: id };
    if (amount == null) {
      ops.push({ deleteOne: { filter } });
    } else if (isNaN(amount) || amount < 0) {
      return { ok: false, error: `a valid amount is required for ${id}` };
    } else {
      ops.push({
        updateOne: {
          filter,
          update: { $set: { amount: round2(amount), updatedBy: caller.customerId } },
          upsert: true,
        },
      });
    }
  }
  if (ops.length) await EarningOverride.bulkWrite(ops, { ordered: false });
  const customEarnings = await EarningOverride.countDocuments({ practiceId: p.practiceId, productKey: key });
  return { ok: true, productId: legacyId(p.productId), customEarnings };
}
