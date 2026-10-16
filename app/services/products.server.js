import { connectDb } from "../db.server";
import { Product } from "../models/index.server";
import { ApiError, canSeeClinic, canSeeDoctor, canSeePractice } from "./caller.server";
import { applyViewerEarnings, productKey } from "./earnings.server";
import { copyMasterKey, tagVal } from "./ids.server";
import { logEvent } from "./log.server";
import { escQ, gid, gql, gqlAll, legacyId, metafieldsSet } from "./shopify-admin.server";

/* Product catalogue + Product Management (pricing / commission).

   The catalogue is mirrored into MongoDB (products/* webhooks + a periodic
   full sync), so the dashboards' product tables and the commission split
   never wait on a paged Shopify query. Writes (price, commission) go to
   Shopify first, then straight into the mirror. */

const STORE_CURRENCY = "USD";

// custom.* metafields mirrored on every product.
const MF_KEYS = [
  "wholsale_price", // sic - the store's key really is spelled this way
  "msrp_low",
  "msrp_high",
  "patient_price",
  "physician_commission",
  "clinic_commission",
  "peptides_support_keywords",
];

const PRODUCT_FIELDS = `#graphql
  fragment RxProduct on Product {
    id title handle status vendor productType tags description templateSuffix updatedAt
    publishedAt
    featuredMedia { preview { image { url } } }
    variants(first: 50) {
      nodes {
        id title sku price compareAtPrice position availableForSale inventoryQuantity
        inventoryItem { id }
      }
    }
    sellingPlanGroups(first: 10) { nodes { id name } }
    ${MF_KEYS.map((k) => `mf_${k}: metafield(namespace: "custom", key: "${k}") { value type }`).join("\n    ")}
  }`;

/** A custom.* money / number metafield as a number, or null when unset. */
function mfNumber(mf) {
  if (!mf || mf.value == null || mf.value === "") return null;
  if (mf.type === "money") {
    try {
      return Number(JSON.parse(mf.value).amount) || 0;
    } catch {
      return null;
    }
  }
  const n = Number(String(mf.value).replace(/[^0-9.]/g, ""));
  return isNaN(n) ? null : n;
}

/** Flattens a rich-text metafield's JSON document to plain text (search only). */
function richTextPlain(mf) {
  if (!mf?.value) return "";
  let doc;
  try {
    doc = JSON.parse(mf.value);
  } catch {
    return String(mf.value);
  }
  const parts = [];
  (function walk(node) {
    if (!node) return;
    if (node.type === "text" && node.value) parts.push(node.value);
    if (Array.isArray(node.children)) node.children.forEach(walk);
  })(doc);
  return parts.join(" ");
}

function productDoc(n) {
  const tags = n.tags || [];
  const variants = (n.variants?.nodes || []).map((v) => ({
    variantId: legacyId(v.id),
    title: v.title || "",
    sku: v.sku || "",
    price: Number(v.price) || 0,
    compareAtPrice: v.compareAtPrice != null ? Number(v.compareAtPrice) : null,
    inventoryQuantity: v.inventoryQuantity ?? null,
    inventoryItemId: v.inventoryItem ? legacyId(v.inventoryItem.id) : "",
    position: v.position,
    available: !!v.availableForSale,
  }));
  const mf = (k) => n[`mf_${k}`];
  return {
    productId: legacyId(n.id),
    title: n.title || "",
    handle: n.handle || "",
    status: n.status || "",
    vendor: n.vendor || "",
    productType: n.productType || "",
    tags,
    image: n.featuredMedia?.preview?.image?.url || "",
    templateSuffix: n.templateSuffix || "",
    variants,
    price: variants[0]?.price || 0,
    wholesale: mfNumber(mf("wholsale_price")) || 0,
    physicianCommission: mfNumber(mf("physician_commission")) || 0,
    clinicCommission: mfNumber(mf("clinic_commission")) || 0,
    metafields: {
      msrpLow: mfNumber(mf("msrp_low")),
      msrpHigh: mfNumber(mf("msrp_high")),
      patientPrice: mfNumber(mf("patient_price")),
      cost: mfNumber(mf("wholsale_price")),
      keywords: richTextPlain(mf("peptides_support_keywords")),
      description: n.description || "",
      published: !!n.publishedAt,
    },
    sellingPlanGroups: (n.sellingPlanGroups?.nodes || []).map((g) => ({ id: g.id, name: g.name })),
    doctorId: tagVal(tags, "doctor_id:"),
    clinicId: tagVal(tags, "clinic_id:"),
    practiceId: tagVal(tags, "practice_id:"),
    masterKey: copyMasterKey(tags),
    shopifyUpdatedAt: n.updatedAt ? new Date(n.updatedAt) : new Date(),
  };
}

/** Re-reads one product from Shopify into the mirror (webhook handler). */
export async function syncProduct(productId) {
  await connectDb();
  const data = await gql(
    `#graphql
    ${PRODUCT_FIELDS}
    query RxProductOne($id: ID!) { product(id: $id) { ...RxProduct } }`,
    { id: gid.product(productId) },
  );
  if (!data.product) {
    await Product.deleteOne({ productId: legacyId(productId) });
    return null;
  }
  const doc = productDoc(data.product);
  await Product.updateOne({ productId: doc.productId }, { $set: doc }, { upsert: true });
  return doc;
}

/** Refreshes one product in the mirror a few seconds after the app changed
 *  it (Shopify's own webhook follows too; this just closes the gap). */
export function syncProductLater(productId) {
  setTimeout(() => syncProduct(productId).catch(() => {}), 4000).unref?.();
}

export async function removeProduct(productId) {
  await connectDb();
  await Product.deleteOne({ productId: legacyId(productId) });
}

/** Full catalogue sync; also drops mirror rows Shopify no longer has. */
export async function syncAllProducts() {
  await connectDb();
  const nodes = await gqlAll(
    `#graphql
    ${PRODUCT_FIELDS}
    query RxProductsAll($after: String) {
      products(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ...RxProduct }
      }
    }`,
    {},
    (d) => d.products,
    { max: 100000 },
  );
  const seen = [];
  for (const n of nodes) {
    const doc = productDoc(n);
    seen.push(doc.productId);
    await Product.updateOne({ productId: doc.productId }, { $set: doc }, { upsert: true });
  }
  // A product missing from the listing is only a suspect (a just-created copy
  // can lag behind): it is read live by id and removed only when Shopify
  // confirms it is gone. Its row is what stops a duplicate copy being made.
  let removed = 0;
  const suspects = await Product.find({ productId: { $nin: seen } }, { productId: 1 }).lean();
  for (const s of suspects) {
    try {
      const data = await gql(
        `#graphql
        query RxProductStillThere($id: ID!) { product(id: $id) { id } }`,
        { id: `gid://shopify/Product/${s.productId}` },
      );
      if (data.product) continue; // still exists - listing just hadn't caught up
      await Product.deleteOne({ productId: s.productId });
      removed++;
    } catch {
      // can't confirm -> keep the row
    }
  }
  logEvent("job", "product-sync", `products=${nodes.length} removed=${removed} keptAfterLiveCheck=${suspects.length - removed}`);
  return { synced: nodes.length, removed };
}

let mirrorReady = false;
async function ensureMirror() {
  if (mirrorReady) return;
  await connectDb();
  if ((await Product.estimatedDocumentCount()) === 0) await syncAllProducts();
  mirrorReady = true;
}

/* ------------------------- Product Management --------------------------- */

/**
 * Products for the "Product Management" tab. practice_id is preferred (one
 * shared product set per practice); clinic_id / doctor_id only match legacy
 * per-doctor copies. Only ACTIVE + published products are listed - what a
 * patient could actually buy right now. Price shown is custom.patient_price,
 * falling back to MSRP Low, then the variant price.
 *
 * `viewer` = { doctorId, clinicId } of the physician / clinic looking (both
 * blank = the practice): the earnings columns are then THEIR amounts - see
 * earnings.server.js applyViewerEarnings.
 */
export async function listPracticeProducts(doctorId, clinicId, practiceId, viewer = {}) {
  doctorId = String(doctorId || "").trim();
  clinicId = String(clinicId || "").trim();
  practiceId = String(practiceId || "").trim();
  if (!doctorId && !clinicId && !practiceId) {
    return { ok: false, error: "missing doctor, clinic, or practice id" };
  }
  await ensureMirror();
  const idQ = practiceId ? { practiceId } : clinicId ? { clinicId } : { doctorId };
  const rows = await Product.find({ ...idQ, status: "ACTIVE", "metafields.published": true })
    .sort({ title: 1 })
    .lean();

  const products = rows.map((p) => {
    const m = p.metafields || {};
    const variant = p.variants?.[0] || {};
    const price = variant.price || 0;
    const patientPrice = m.patientPrice;
    const msrpLow = m.msrpLow;
    return {
      id: gid.product(p.productId),
      title: p.title,
      sku: variant.sku || "",
      image: p.image || "",
      price: patientPrice != null ? patientPrice : price,
      cost: m.cost != null ? m.cost : 0,
      msrpLow: msrpLow != null ? msrpLow : 0,
      msrpHigh: m.msrpHigh != null ? m.msrpHigh : 0,
      patientPrice: patientPrice != null ? patientPrice : msrpLow != null ? msrpLow : price,
      physicianCommission: p.physicianCommission || 0,
      clinicCommission: p.clinicCommission || 0,
      masterKey: p.masterKey || "",
      status: String(p.status || "").toLowerCase(),
      description: m.description || "",
      keywords: m.keywords || "",
      _key: productKey(p),
      _practiceId: p.practiceId || "",
    };
  });
  await applyViewerEarnings(products, viewer);
  for (const p of products) {
    delete p._key;
    delete p._practiceId;
  }
  return {
    ok: true,
    matchedBy: practiceId ? "practice_id" : clinicId ? "clinic_id" : "doctor_id",
    products,
  };
}

/**
 * Brings each product's real Shopify price in line with its intended patient
 * price (the metafield when set, else MSRP Low). The product sync only writes
 * a price at creation, so an MSRP Low filled in later would otherwise never
 * reach the storefront. Runs from the scheduler, not on page load.
 */
export async function reconcilePatientPrices() {
  await ensureMirror();
  const rows = await Product.find({ status: "ACTIVE", practiceId: { $ne: "" } }).lean();
  let fixed = 0;
  for (const p of rows) {
    const m = p.metafields || {};
    const price = p.variants?.[0]?.price || 0;
    const intended = m.patientPrice != null ? m.patientPrice : m.msrpLow != null ? m.msrpLow : price;
    if (!(intended > 0) || Math.abs(intended - price) <= 0.01) continue;
    try {
      await setProductPrice(p.productId, intended);
      fixed++;
    } catch (err) {
      logEvent("error", p.productId, "price reconcile: " + err, null, false);
    }
  }
  if (fixed) logEvent("job", "price-reconcile", `fixed=${fixed}`);
  return { checked: rows.length, fixed };
}

const moneyValue = (amount) =>
  JSON.stringify({ amount: Number(amount).toFixed(2), currency_code: STORE_CURRENCY });

/** Sets every variant's price + custom.patient_price for one product. */
async function setProductPrice(productId, newPrice) {
  const id = gid.product(productId);
  const data = await gql(
    `#graphql
    query RxProductVariants($id: ID!) { product(id: $id) { variants(first: 100) { nodes { id } } } }`,
    { id },
  );
  const variants = data.product?.variants?.nodes || [];
  if (!variants.length) throw new Error("Product or variants not found");
  const res = await gql(
    `#graphql
    mutation RxVariantPrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id price }
        userErrors { field message }
      }
    }`,
    { productId: id, variants: variants.map((v) => ({ id: v.id, price: Number(newPrice).toFixed(2) })) },
  );
  const errs = res.productVariantsBulkUpdate.userErrors || [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
  await metafieldsSet([
    { ownerId: id, namespace: "custom", key: "patient_price", type: "money", value: moneyValue(newPrice) },
  ]);
  await Product.updateOne(
    { productId: legacyId(id) },
    {
      $set: {
        price: Number(newPrice),
        "variants.$[].price": Number(newPrice),
        "metafields.patientPrice": Number(newPrice),
      },
    },
  );
  return variants.length;
}

/** The product must belong to a practice / clinic / doctor the caller may
 *  manage. Reads the product's own tags, never an id from the page. */
async function assertOwnsProduct(caller, productId) {
  await ensureMirror();
  let p = await Product.findOne({ productId: legacyId(productId) }).lean();
  if (!p) p = await syncProduct(productId);
  if (!p) throw new ApiError("Product not found", 404);
  if (
    canSeePractice(caller, p.practiceId) ||
    canSeeClinic(caller, p.clinicId) ||
    canSeeDoctor(caller, p.doctorId)
  ) {
    return p;
  }
  throw new ApiError("You do not have access to this product.", 403);
}

/**
 * Product Management "UPDATE" on a price: one product, or (applyToPractice)
 * every copy of the same master product across the practice.
 */
export async function updateProductPrice(body, caller) {
  const rawId = String(body.productId || "").trim();
  let newPrice = body.newPrice;
  if (!rawId) return { ok: false, error: "productId is required" };
  if (newPrice === undefined || newPrice === null || newPrice === "" || isNaN(Number(newPrice)) || Number(newPrice) < 0) {
    return { ok: false, error: "a valid newPrice is required" };
  }
  newPrice = Number(newPrice);
  const product = await assertOwnsProduct(caller, rawId);

  if (body.applyToPractice) {
    const practiceId = product.practiceId;
    const masterKey = String(body.masterKey || product.masterKey || "").trim();
    if (!practiceId || !masterKey) {
      return { ok: false, error: "practiceId and masterKey are required for a practice-wide update" };
    }
    const data = await gql(
      `#graphql
      query RxPracticeCopies($q: String!) { products(first: 100, query: $q) { nodes { id } } }`,
      // rxcopy: = current copies; rxbase: / rxmaster: = copies made before that
      { q: `(tag:'rxcopy:${escQ(masterKey)}' OR tag:'rxbase:${escQ(masterKey)}' OR tag:'rxmaster:${escQ(masterKey)}') AND tag:'practice_id:${escQ(practiceId)}'` },
    );
    const nodes = data.products?.nodes || [];
    if (!nodes.length) {
      return { ok: false, error: `No products found for practice_id:${practiceId} / rxcopy:${masterKey}.` };
    }
    let updated = 0;
    const errors = [];
    for (const n of nodes) {
      try {
        await setProductPrice(n.id, newPrice);
        updated++;
      } catch (err) {
        errors.push(`${n.id}: ${err.message || err}`);
      }
    }
    return {
      ok: !!updated,
      error: updated ? undefined : "No products could be updated.",
      message: `Updated ${updated} of ${nodes.length} product(s) across the practice.`,
      newPrice,
      updatedProducts: updated,
      totalProducts: nodes.length,
      errors,
    };
  }

  try {
    const updatedVariants = await setProductPrice(rawId, newPrice);
    return { ok: true, productId: rawId, newPrice, updatedVariants };
  } catch (err) {
    return { ok: false, error: String(err.message || err), productId: rawId };
  }
}

/**
 * Product Management "UPDATE" on a Physician / Clinic Commission cell: one
 * absolute dollar amount on that product's own money metafield. The
 * practice's cut is never stored - it is Profit minus these two.
 */
export async function updateProductCommission(body, caller) {
  const rawId = String(body.productId || "").trim();
  const role = String(body.role || "").trim();
  let amount = body.amount;
  if (!rawId) return { ok: false, error: "productId is required" };
  if (role !== "physician" && role !== "clinic") {
    return { ok: false, error: 'role must be "physician" or "clinic"' };
  }
  if (amount === undefined || amount === null || amount === "" || isNaN(Number(amount)) || Number(amount) < 0) {
    return { ok: false, error: "a valid amount is required" };
  }
  amount = Number(amount);
  await assertOwnsProduct(caller, rawId);

  const key = role === "clinic" ? "clinic_commission" : "physician_commission";
  const errs = await metafieldsSet([
    { ownerId: gid.product(rawId), namespace: "custom", key, type: "money", value: moneyValue(amount) },
  ]);
  if (errs.length) return { ok: false, error: "Metafield write failed: " + errs.map((e) => e.message).join("; ") };
  await Product.updateOne(
    { productId: legacyId(rawId) },
    { $set: { [role === "clinic" ? "clinicCommission" : "physicianCommission"]: amount } },
  );
  return { ok: true, productId: rawId, role, amount };
}
