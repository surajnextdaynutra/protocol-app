import crypto from "node:crypto";
import mongoose, { connectDb } from "../db.server";
import { Account, Product } from "../models/index.server";
import { copyMasterKey, idsFromCustomerTags, tagList, tagVal } from "./ids.server";
import { kvGet, kvSet, logEvent, withLock } from "./log.server";
import { getSettings, isTrue } from "./settings.server";
import { syncProductLater } from "./products.server";
import { getCustomer, gql, gqlAll, legacyId } from "./shopify-admin.server";

/* Master products -> one copy per practice (was Rx-Product-Sync, plus the
   "rxmaster id auto generator").

   The master list lives in the `master_products` collection (admin ->
   Products), one document per Master Key, holding the same columns the
   "Products" sheet tab had. For every master:
     - a BASE product (tag rxbase:<key>, base-product) with no practice id
     - one COPY per practice that has an active physician
       (tags practice_id:<id> + rxcopy:<key>; copies made before carry
       rxmaster:<key> or rxbase:<key> and are re-tagged on their next sync)
   Details stay in step with the master on every run EXCEPT price, which is
   written only when a copy is first created - after that the practice sets
   its own patient price. "Sync prices" pushes master prices on demand.
   Inventory is shared: when one copy sells, the new quantity is pushed to
   every copy of that master and recorded on the master. */

const { Schema } = mongoose;
const masterSchema = new Schema(
  {
    masterKey: { type: String, required: true, unique: true },
    row: { type: Schema.Types.Mixed, default: {} }, // column name -> value, as in the sheet
    sigs: { type: Schema.Types.Mixed, default: {} }, // last-synced fingerprint per target
    // the base product's id, so it is found even before Shopify's search sees its rxbase: tag
    baseProductId: { type: String, default: "" },
  },
  { timestamps: true, minimize: false },
);
export const MasterProduct =
  mongoose.models.MasterProduct || mongoose.model("MasterProduct", masterSchema, "master_products");

const STORE_CURRENCY = "USD";

// Column names (the sheet's own headers - the CSV import maps straight in).
export const P = {
  MASTER_KEY: "Master Key",
  TITLE: "Title",
  DESCRIPTION: "Description",
  VENDOR: "Vendor",
  PRICE: "Price",
  COMPARE_AT: "Compare At Price",
  INVENTORY: "Inventory",
  STATUS: "Status",
  PUBLISHED: "Published",
  TAGS: "Tags",
  SKU: "SKU",
  PURCHASE_OPTIONS: "Purchase Options",
  METAFIELDS: "Metafields",
  IMAGES: "Images",
};

// One column per metafield; list types take values separated by a pipe |.
export const METAFIELD_COLUMNS = [
  { column: "Other Ingredient", key: "other_ingredient", type: "single_line_text_field" },
  { column: "UPC", key: "upc", type: "single_line_text_field" },
  { column: "Related Categories", key: "related_categories", type: "list.single_line_text_field" },
  { column: "Storage Instructions", key: "storage_instructions", type: "multi_line_text_field" },
  { column: "Directions & Usage", key: "directions_usage", type: "multi_line_text_field" },
  { column: "Highlights", key: "highlights", type: "list.single_line_text_field" },
  { column: "Product Short Headline", key: "product_short_headline", type: "single_line_text_field" },
  { column: "Servings Per Container", key: "servings_per_container", type: "single_line_text_field" },
  { column: "Wholsale Price", key: "wholsale_price", type: "money" },
  { column: "MSRP High", key: "msrp_high", type: "money" },
  { column: "MSRP Low", key: "msrp_low", type: "money" },
  { column: "Peptides Support + Keywords", key: "peptides_support_keywords", type: "rich_text_field" },
  { column: "Spotlight File 1", key: "product_sport_light", type: "url" },
  { column: "Spotlight File 2", key: "sportlight_file_2", type: "url" },
  { column: "Spotlight File 3", key: "sportlight_file_3", type: "url" },
];
// Reference metafields: 'gid' = cell holds "Name (gid://...)"; 'url' = a file URL
// that is looked up in Shopify Files.
export const METAFIELD_REF_COLUMNS = [
  { column: "Quality Trust Block", key: "quality_trust_block", type: "metaobject_reference", source: "gid" },
  { column: "Ingredient Facts Image", key: "ingredient_facts_image", type: "file_reference", source: "url" },
  { column: "Formulation Features", key: "formulation_features", type: "list.file_reference", source: "url" },
];
export const MASTER_COLUMNS = [
  ...Object.values(P),
  ...METAFIELD_COLUMNS.map((d) => d.column),
  ...METAFIELD_REF_COLUMNS.map((d) => d.column),
];

const numOrNull = (v) => {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ""));
  return isNaN(n) ? null : n;
};

/* ----------------------------- master list ------------------------------ */

/** A Master Key the way the old sheet held them - the product's own name,
 *  e.g. "Zinc Glycinate" -> base rxbase:Zinc Glycinate, copies rxcopy:Zinc Glycinate, as
 *  like the products Rx-Product-Sync created. Commas are dropped (Shopify
 *  splits tags on them); made unique with " 2", " 3"… */
const keyFromTitle = (title) =>
  String(title || "").replace(/,/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) || "Product";

async function newMasterKey(title) {
  const base = keyFromTitle(title);
  const taken = new Set((await MasterProduct.distinct("masterKey")).map((k) => String(k).toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`.toLowerCase())) n++;
  return `${base} ${n}`;
}

export async function listMasters() {
  await connectDb();
  return MasterProduct.find({}).sort({ masterKey: 1 }).lean();
}

/** Create / update one master from a { column: value } row. A blank Master
 *  Key is generated from the Title. */
export async function saveMaster(row) {
  await connectDb();
  const clean = {};
  for (const [k, v] of Object.entries(row || {})) {
    const key = String(k).trim();
    if (key) clean[key] = typeof v === "string" ? v.trim() : v;
  }
  let masterKey = String(clean[P.MASTER_KEY] || "").trim();
  if (!masterKey) {
    if (!String(clean[P.TITLE] || "").trim()) throw new Error("A master product needs a Title.");
    masterKey = await newMasterKey(clean[P.TITLE]);
  }
  clean[P.MASTER_KEY] = masterKey;
  const before = await MasterProduct.findOne({ masterKey }).lean();
  await MasterProduct.updateOne({ masterKey }, { $set: { row: clean } }, { upsert: true });

  // A new Inventory typed on the master is pushed to its base product and
  // every copy at once - otherwise the shared-inventory job would read the
  // copies' old number as a "sale" and put the master straight back.
  const oldQty = before?.row?.[P.INVENTORY];
  const newQty = clean[P.INVENTORY];
  if (before && String(newQty ?? "").trim() !== "" && !isNaN(Number(newQty)) && String(oldQty) !== String(newQty)) {
    await pushMasterStock(before, Number(newQty));
  }
  return masterKey;
}

/** Sets one master's stock on its base product and every practice copy. */
async function pushMasterStock(master, qty) {
  const ids = (await Product.find({ masterKey: master.masterKey }, { productId: 1 }).lean())
    .map((p) => `gid://shopify/Product/${p.productId}`);
  if (master.baseProductId) ids.push(master.baseProductId);
  let ok = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      const p = await productById(id);
      if (!p?.inventoryItemId) continue;
      await setInventory(p.inventoryItemId, qty);
      ok++;
    } catch (err) {
      failed++;
      logEvent("sync", "inventory", `"${master.masterKey}": stock ${qty} not set on ${id} - ${err}`, null, false);
    }
  }
  logEvent("sync", "inventory", `"${master.masterKey}": stock set to ${qty} on ${ok} product(s)${failed ? `, ${failed} failed` : ""}`, null, !failed);
}

export async function deleteMaster(masterKey) {
  await connectDb();
  await MasterProduct.deleteOne({ masterKey });
}

/* ------------------------- import from the store ------------------------ */

/** A product's custom.* metafield -> the sheet-style cell value. */
function cellFromMetafield(def, mf) {
  if (!mf || mf.value == null || mf.value === "") return "";
  try {
    if (def.type === "money") return String(JSON.parse(mf.value).amount ?? "");
    if (def.type === "rich_text_field") {
      const lines = [];
      const walk = (n) => {
        if (n.type === "text") lines[lines.length - 1] = (lines[lines.length - 1] || "") + n.value;
        else {
          if (n.type === "paragraph" || n.type === "heading" || n.type === "list-item") lines.push("");
          (n.children || []).forEach(walk);
        }
      };
      walk(JSON.parse(mf.value));
      return lines.filter((l) => l.trim()).join("\n");
    }
    if (def.type === "list.file_reference") return JSON.parse(mf.value).join(", ");
    if (def.type.startsWith("list.")) return JSON.parse(mf.value).join(" | ");
  } catch {
    // not JSON after all - fall through to the raw value
  }
  return String(mf.value);
}

/**
 * Builds the master list from the products already in Shopify, so practice
 * copies come out exactly like the ones Rx-Product-Sync made
 * (practice_id:<id> + rxcopy:<Master Key>):
 *   1. a base product (rxbase:<key>, no practice_id) -> that key, as the old script set it;
 *   2. else a practice copy (practice_id + rxcopy:/rxbase:/rxmaster:<key>) -> that key;
 *   3. else a plain catalogue product -> its title as the key, and the
 *      product itself is tagged rxbase:<key> + base-product so it becomes the
 *      base (no second "base" copy of it is created).
 * Masters that already exist are left as they are. Returns a summary.
 */
/** Published = on the Online Store channel. onlineStoreUrl alone is not
 *  enough: it is empty on a password-protected / dev store, which marked every
 *  imported master unpublished and left the copies on no sales channel. */
const isOnSale = (n) =>
  !!n.onlineStoreUrl || (n.resourcePublications?.nodes || []).some((p) => /online store/i.test(p.publication?.name || ""));

/* The store-product fields a master row is built from (import + the
   Shopify -> app pull of a base product). */
const STORE_PRODUCT_FIELDS = `
  id title descriptionHtml status tags onlineStoreUrl isGiftCard vendor
  resourcePublications(first: 20, onlyPublished: true) { nodes { publication { name } } }
  variants(first: 1) { nodes { price compareAtPrice sku inventoryQuantity } }
  media(first: 10) { nodes { ... on MediaImage { image { url } } } }
  sellingPlanGroups(first: 1) { nodes { id } }
  metafields(first: 60, namespace: "custom") { nodes { key value } }`;

/** A store product -> master row (the sheet's columns). */
function rowFromStoreProduct(n, key) {
  const v = n.variants?.nodes?.[0] || {};
  const mfs = Object.fromEntries((n.metafields?.nodes || []).map((m) => [m.key, m]));
  const row = {
    [P.MASTER_KEY]: key,
    [P.TITLE]: n.title || "",
    [P.DESCRIPTION]: n.descriptionHtml || "",
    [P.PRICE]: v.price ?? "",
    [P.COMPARE_AT]: v.compareAtPrice ?? "",
    [P.INVENTORY]: v.inventoryQuantity ?? "",
    [P.STATUS]: String(n.status || "ACTIVE").toLowerCase(),
    [P.VENDOR]: n.vendor || "",
    [P.PUBLISHED]: isOnSale(n) ? "TRUE" : "FALSE",
    // the copy's own markers are added back by the sync - not master tags
    [P.TAGS]: (n.tags || []).filter((t) => !/^(rxbase:|rxcopy:|rxmaster:|practice_id:|clinic_id:|doctor_id:)/i.test(t) && t.toLowerCase() !== "base-product").join(", "),
    [P.SKU]: v.sku || "",
    [P.PURCHASE_OPTIONS]: n.sellingPlanGroups?.nodes?.[0]?.id || "",
    [P.METAFIELDS]: "",
    [P.IMAGES]: (n.media?.nodes || []).map((m) => m.image?.url).filter(Boolean).join(", "),
  };
  for (const def of [...METAFIELD_COLUMNS, ...METAFIELD_REF_COLUMNS]) row[def.column] = cellFromMetafield(def, mfs[def.key]);
  return row;
}

export async function importMastersFromStore() {
  await connectDb();
  const nodes = await gqlAll(
    `#graphql
    query RxStoreCatalogue($after: String) {
      products(first: 50, after: $after, sortKey: TITLE) {
        pageInfo { hasNextPage endCursor }
        nodes { ${STORE_PRODUCT_FIELDS} }
      }
    }`,
    {},
    (d) => d.products,
    { max: 5000 },
  );

  const tag = (n, prefix) => (n.tags || []).find((t) => t.toLowerCase().startsWith(prefix))?.slice(prefix.length).trim() || "";
  const candidates = new Map(); // master key -> { node, source }
  const rank = { base: 0, copy: 1, plain: 2 };
  for (const n of nodes) {
    if (n.isGiftCard) continue;
    const isCopy = !!tag(n, "practice_id:");
    const baseKey = isCopy ? "" : tag(n, "rxbase:");
    const copyKey = copyMasterKey(n.tags);
    let key;
    let source;
    if (baseKey) { key = baseKey; source = "base"; }
    else if (copyKey) { key = copyKey; source = "copy"; }
    else if (!isCopy) { key = keyFromTitle(n.title); source = "plain"; }
    else continue; // a practice-tagged product with no master marker - not a catalogue item
    const prev = candidates.get(key.toLowerCase());
    if (!prev || rank[source] < rank[prev.source]) candidates.set(key.toLowerCase(), { key, node: n, source });
  }

  const existing = new Set((await MasterProduct.distinct("masterKey")).map((k) => String(k).toLowerCase()));
  const out = { found: candidates.size, imported: 0, skippedExisting: 0, adoptedAsBase: 0, keys: [] };
  for (const { key, node: n, source } of candidates.values()) {
    if (existing.has(key.toLowerCase())) { out.skippedExisting++; continue; }
    const row = rowFromStoreProduct(n, key);

    const baseProductId = source === "copy" ? "" : n.id;
    // The base IS this product, built from it - mark it in step so the first
    // sync doesn't rewrite it (e.g. re-upload its own images).
    const sigs = baseProductId
      ? { base: signature(row, [...baseTags(row), `rxbase:${key}`, "base-product"].join(", ")) }
      : {};
    await MasterProduct.updateOne({ masterKey: key }, { $set: { row, baseProductId, sigs } }, { upsert: true });
    out.imported++;
    out.keys.push(key);

    // A plain catalogue product becomes the base itself (tags added, nothing removed).
    if (source === "plain") {
      const res = await gql(
        `#graphql
        mutation RxAdoptBase($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
        { id: n.id, tags: [`rxbase:${key}`, "base-product"] },
      );
      if (!(res.tagsAdd?.userErrors || []).length) out.adoptedAsBase++;
    }
  }
  logEvent("sync", "product-sync", `masters imported from store ${JSON.stringify({ ...out, keys: undefined })}`);
  return out;
}

/* --------------------------- Shopify plumbing --------------------------- */

/* The stock location: the LOCATION_ID setting (read every time, so a change
   on the Settings page applies at once), else the store's PRIMARY location.
   It used to be "the first active location", which is not a stable choice -
   stock was written to one location and later read from another. */
let primaryLocation = null;
async function locationId() {
  const cfg = await getSettings();
  const set = String(cfg.LOCATION_ID || "").replace(/\D/g, "");
  if (set) return `gid://shopify/Location/${set}`;
  if (primaryLocation) return primaryLocation;
  const data = await gql(`#graphql
    query RxPrimaryLocation { location { id } }`);
  primaryLocation = data.location.id;
  return primaryLocation;
}

async function setVariant(productId, variantId, fields) {
  const v = { id: variantId, inventoryItem: { tracked: true } };
  if (fields.price != null) v.price = String(fields.price);
  if (fields.compareAtPrice != null) v.compareAtPrice = String(fields.compareAtPrice);
  if (fields.sku != null) v.inventoryItem.sku = String(fields.sku);
  await gql(
    `#graphql
    mutation RxSetVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } }
    }`,
    { productId, variants: [v] },
  );
}

async function setInventory(inventoryItemId, qty, { activated = false } = {}) {
  const loc = await locationId();
  const data = await gql(
    // @idempotent is required on inventory mutations since API 2026-04: a
    // fresh key per call, so a retried request is never applied twice.
    `#graphql
    mutation RxSetInventory($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
      inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) { userErrors { field message } }
    }`,
    {
      idempotencyKey: crypto.randomUUID(),
      input: {
        name: "available",
        reason: "correction",
        // changeFromQuantity is required since 2026-07 (replaced
        // ignoreCompareQuantity); null = no compare-and-swap check, because
        // the master list is the source of truth for this shared stock.
        quantities: [{ inventoryItemId, locationId: loc, quantity: Number(qty), changeFromQuantity: null }],
      },
    },
  );
  const errs = data.inventorySetQuantities?.userErrors || [];
  if (!errs.length) return;
  const msg = errs.map((e) => e.message).join("; ");
  // The product isn't stocked at this location yet: stock it there, then set.
  if (!activated && /not stocked|isn't stocked|not active|inventory level|location/i.test(msg)) {
    const act = await gql(
      `#graphql
      mutation RxActivateStock($item: ID!, $loc: ID!, $idempotencyKey: String!) {
        inventoryActivate(inventoryItemId: $item, locationId: $loc) @idempotent(key: $idempotencyKey) { userErrors { message } }
      }`,
      { item: inventoryItemId, loc, idempotencyKey: crypto.randomUUID() },
    );
    if (!(act.inventoryActivate?.userErrors || []).length) return setInventory(inventoryItemId, qty, { activated: true });
  }
  throw new Error(msg);
}

/** A product's "available" stock at the stock location, or null when it is
 *  not stocked there at all (unknown - NOT zero). */
const levelQty = (item) => {
  const q = item?.inventoryLevel?.quantities?.[0]?.quantity;
  return item?.inventoryLevel && q != null ? Number(q) : null;
};

function formatMetafieldValue(type, raw) {
  const v = String(raw).trim();
  if (type === "money") {
    return JSON.stringify({ amount: v.replace(/[^0-9.]/g, "") || "0", currency_code: STORE_CURRENCY });
  }
  if (type.startsWith("list.")) {
    return JSON.stringify(v.split("|").map((x) => x.trim()).filter(Boolean));
  }
  if (type === "rich_text_field") {
    let paragraphs = v.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!paragraphs.length) paragraphs = [""];
    return JSON.stringify({
      type: "root",
      children: paragraphs.map((line) => ({ type: "paragraph", children: [{ type: "text", value: line }] })),
    });
  }
  return v;
}

async function setPatientPrice(productId, amount) {
  await gql(
    `#graphql
    mutation RxPatientPrice($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { field message } } }`,
    { m: [{ ownerId: productId, namespace: "custom", key: "patient_price", type: "money", value: formatMetafieldValue("money", amount) }] },
  );
}

// filename (lower-case) -> file gid, built once per run
let fileMap = null;
const fileNameFromUrl = (url) => (String(url || "").split("?")[0].split("/").pop() || "").toLowerCase();
async function fileGidFromUrl(cell) {
  const s = String(cell || "").trim();
  if (!s) return "";
  if (s.startsWith("gid://")) return s;
  if (!fileMap) {
    fileMap = {};
    const nodes = await gqlAll(
      `#graphql
      query RxFiles($after: String) {
        files(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { id ... on MediaImage { image { url } } ... on GenericFile { url } }
        }
      }`,
      {},
      (d) => d.files,
      { max: 3000 },
    );
    for (const n of nodes) {
      const fn = fileNameFromUrl(n.image?.url || n.url);
      if (fn) fileMap[fn] = n.id;
    }
  }
  const fn = fileNameFromUrl(s);
  if (fileMap[fn]) return fileMap[fn];
  const alt = fn.replace(/(_\d+x\d+)(\.[a-z0-9]+)$/i, "$2");
  if (alt !== fn && fileMap[alt]) return fileMap[alt];
  // Not in this store's Files (e.g. a link to another store's CDN): upload it
  // here from that URL, then use the new file.
  const uploaded = /^https?:\/\//i.test(s) ? await uploadFileFromUrl(s) : "";
  if (uploaded) {
    fileMap[fn] = uploaded;
    return uploaded;
  }
  logEvent("sync", "product-sync", "File not found in Shopify and could not be uploaded: " + s, null, false);
  return "";
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|heic)$/i;

/** Adds the file at `url` to this store's Files (Shopify downloads it) and
 *  waits until it is ready to be referenced. Returns its gid or "". */
async function uploadFileFromUrl(url) {
  try {
    const name = fileNameFromUrl(url);
    const res = await gql(
      `#graphql
      mutation RxFileCreate($files: [FileCreateInput!]!) {
        fileCreate(files: $files) { files { id fileStatus } userErrors { field message } }
      }`,
      { files: [{ originalSource: url, contentType: IMAGE_EXT.test(name) ? "IMAGE" : "FILE", alt: name.replace(/\.[a-z0-9]+$/i, "") }] },
    );
    const errs = res.fileCreate?.userErrors || [];
    const file = res.fileCreate?.files?.[0];
    if (errs.length || !file?.id) {
      logEvent("sync", "product-sync", `upload failed for ${url}: ${errs.map((e) => e.message).join("; ")}`, null, false);
      return "";
    }
    // Shopify processes the download in the background - wait for READY (or give up after ~30 s)
    let status = file.fileStatus;
    for (let i = 0; i < 15 && status !== "READY" && status !== "FAILED"; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const d = await gql(
        `#graphql
        query RxFileStatus($id: ID!) { node(id: $id) { ... on MediaImage { fileStatus } ... on GenericFile { fileStatus } } }`,
        { id: file.id },
      );
      status = d.node?.fileStatus || status;
    }
    if (status === "FAILED") {
      logEvent("sync", "product-sync", `Shopify could not download ${url}`, null, false);
      return "";
    }
    logEvent("sync", "product-sync", `uploaded ${name} to Files (${status})`);
    return file.id;
  } catch (err) {
    logEvent("sync", "product-sync", `upload failed for ${url}: ${err.message || err}`, null, false);
    return "";
  }
}

/** Writes every filled-in metafield column. Returns false on a user error,
 *  so the row is retried on the next run instead of being marked synced. */
async function writeMetafields(productId, row) {
  const metafields = [];
  for (const def of METAFIELD_COLUMNS) {
    const raw = row[def.column];
    if (raw == null || String(raw).trim() === "") continue;
    metafields.push({ ownerId: productId, namespace: "custom", key: def.key, type: def.type, value: formatMetafieldValue(def.type, raw) });
  }
  for (const def of METAFIELD_REF_COLUMNS) {
    const raw = String(row[def.column] ?? "").trim();
    if (!raw) continue;
    const isList = def.type.startsWith("list.");
    let gids;
    if (def.source === "url") {
      gids = [];
      for (const u of isList ? raw.split(",") : [raw]) {
        const g = await fileGidFromUrl(u.trim());
        if (g) gids.push(g);
      }
    } else {
      gids = (isList ? raw.split("|") : [raw])
        .map((c) => (String(c).match(/gid:\/\/shopify\/[^)\s]+/) || [""])[0])
        .filter(Boolean);
    }
    if (!gids.length) continue;
    metafields.push({ ownerId: productId, namespace: "custom", key: def.key, type: def.type, value: isList ? JSON.stringify(gids) : gids[0] });
  }
  const rawJson = row[P.METAFIELDS];
  if (rawJson && String(rawJson).trim()) {
    try {
      for (const mf of JSON.parse(rawJson)) {
        metafields.push({
          ownerId: productId,
          namespace: String(mf.namespace),
          key: String(mf.key),
          type: String(mf.type || "single_line_text_field"),
          value: String(mf.value),
        });
      }
    } catch {
      // an unreadable Metafields cell is skipped, like a blank one
    }
  }
  if (!metafields.length) return true;
  const send = (m) =>
    gql(
      `#graphql
      mutation RxWriteMetafields($m: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $m) { metafields { id } userErrors { field message } }
      }`,
      { m },
    ).then((data) => data.metafieldsSet?.userErrors || []);
  let ok = true;
  for (let i = 0; i < metafields.length; i += 25) {
    const batch = metafields.slice(i, i + 25);
    let errs = await send(batch);
    if (!errs.length) continue;
    // metafieldsSet is all-or-nothing: one bad value (e.g. a reference to
    // something this store doesn't have) used to drop every other field of
    // the product. The failing ones are left out and the rest sent again.
    const bad = new Set(errs.map((e) => Number(e.field?.[1])).filter((n) => !isNaN(n)));
    const dropped = batch.filter((_, j) => bad.has(j)).map((m) => m.key);
    logEvent("sync", "product-sync", `metafields for ${productId}: ${dropped.length ? `skipped ${dropped.join(", ")} - ` : ""}${JSON.stringify(errs).slice(0, 400)}`, null, false);
    const rest = batch.filter((_, j) => !bad.has(j));
    if (!bad.size) { ok = false; continue; } // errors not tied to a field - retry the product next run
    if (rest.length) {
      errs = await send(rest);
      if (errs.length) {
        ok = false;
        logEvent("sync", "product-sync", `metafields for ${productId} (retry): ${JSON.stringify(errs).slice(0, 400)}`, null, false);
      }
    }
    // only the skipped fields failed - the product counts as synced, so it
    // isn't rewritten every run for a value this store can never take
  }
  return ok;
}

/** Replaces the product's images with the comma-separated URL list. */
async function writeImages(productId, raw) {
  const urls = String(raw || "").split(",").map((u) => u.trim()).filter(Boolean);
  if (!urls.length) return;
  const cur = await gql(
    `#graphql
    query RxProductMedia($id: ID!) { product(id: $id) { media(first: 50) { nodes { id } } } }`,
    { id: productId },
  );
  const existing = cur.product?.media?.nodes || [];
  if (existing.length) {
    await gql(
      `#graphql
      mutation RxDeleteMedia($pid: ID!, $ids: [ID!]!) {
        productDeleteMedia(productId: $pid, mediaIds: $ids) { userErrors { message } }
      }`,
      { pid: productId, ids: existing.map((m) => m.id) },
    );
  }
  const res = await gql(
    `#graphql
    mutation RxCreateMedia($pid: ID!, $m: [CreateMediaInput!]!) {
      productCreateMedia(productId: $pid, media: $m) { mediaUserErrors { message } }
    }`,
    { pid: productId, m: urls.map((u) => ({ originalSource: u, mediaContentType: "IMAGE" })) },
  );
  // was silently ignored - a failed image now shows up in Sync & logs
  const errs = res.productCreateMedia?.mediaUserErrors || [];
  if (errs.length) {
    logEvent("sync", "product-sync", `images for ${productId}: ${errs.map((e) => e.message).join("; ").slice(0, 300)}`, null, false);
  }
}

/** Purchase Options = a selling plan group gid -> subscription ON for this
 *  product; blank / anything else -> OFF. */
async function syncSubscription(productId, rawGroupId) {
  let want = String(rawGroupId || "").trim();
  if (!want.startsWith("gid://shopify/SellingPlanGroup/")) want = "";
  const cur = await gql(
    `#graphql
    query RxProductPlans($id: ID!) { product(id: $id) { sellingPlanGroups(first: 20) { nodes { id } } } }`,
    { id: productId },
  );
  const current = (cur.product?.sellingPlanGroups?.nodes || []).map((g) => g.id);
  const remove = (groupId) =>
    gql(
      `#graphql
      mutation RxPlanRemove($id: ID!, $pids: [ID!]!) {
        sellingPlanGroupRemoveProducts(id: $id, productIds: $pids) { userErrors { message } }
      }`,
      { id: groupId, pids: [productId] },
    );
  for (const g of current) if (g !== want) await remove(g);
  if (want && !current.includes(want)) {
    await gql(
      `#graphql
      mutation RxPlanAdd($id: ID!, $pids: [ID!]!) {
        sellingPlanGroupAddProducts(id: $id, productIds: $pids) { userErrors { message } }
      }`,
      { id: want, pids: [productId] },
    );
  }
}

let publications = null;
async function setPublished(productId, publish) {
  if (!publications) {
    publications = await gqlAll(
      `#graphql
      query RxPublications($after: String) {
        publications(first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { id } }
      }`,
      {},
      (d) => d.publications,
      { max: 250 },
    );
  }
  if (!publications.length) return;
  const input = publications.map((p) => ({ publicationId: p.id }));
  if (publish) {
    await gql(
      `#graphql
      mutation RxPublish($id: ID!, $input: [PublicationInput!]!) {
        publishablePublish(id: $id, input: $input) { userErrors { message } }
      }`,
      { id: productId, input },
    );
  } else {
    await gql(
      `#graphql
      mutation RxUnpublish($id: ID!, $input: [PublicationInput!]!) {
        publishableUnpublish(id: $id, input: $input) { userErrors { message } }
      }`,
      { id: productId, input },
    );
  }
}

async function findProduct(query) {
  const data = await gql(
    `#graphql
    query RxFindCopy($q: String!) {
      products(first: 1, query: $q) { nodes { id variants(first: 1) { nodes { id inventoryItem { id } } } } }
    }`,
    { q: query },
  );
  const node = data.products?.nodes?.[0];
  if (!node) return null;
  return {
    productId: node.id,
    variantId: node.variants.nodes[0].id,
    inventoryItemId: node.variants.nodes[0].inventoryItem.id,
  };
}
/** Live (non-search) read of one product, same shape as findProduct. */
async function productById(id) {
  const data = await gql(
    `#graphql
    query RxCopyById($id: ID!) {
      product(id: $id) { id variants(first: 1) { nodes { id inventoryItem { id } } } }
    }`,
    { id },
  );
  const node = data.product;
  if (!node?.variants?.nodes?.[0]) return null;
  return {
    productId: node.id,
    variantId: node.variants.nodes[0].id,
    inventoryItemId: node.variants.nodes[0].inventoryItem.id,
  };
}

/* The base carries rxbase:<key> with NO practice_id. Copies tagged for a
   while with the same rxbase tag (before rxcopy:) must not be taken for it,
   so the first search hit is not enough. */
async function findBase(masterKey) {
  const data = await gql(
    `#graphql
    query RxFindBase($q: String!) {
      products(first: 20, query: $q) { nodes { id tags variants(first: 1) { nodes { id inventoryItem { id } } } } }
    }`,
    { q: `tag:'rxbase:${masterKey}'` },
  );
  const node = (data.products?.nodes || []).find((n) => !tagVal(n.tags, "practice_id:") && n.variants?.nodes?.[0]);
  if (!node) return null;
  return {
    productId: node.id,
    variantId: node.variants.nodes[0].id,
    inventoryItemId: node.variants.nodes[0].inventoryItem.id,
  };
}

/* Shopify's product search can lag a minute or more behind productCreate, so
   a copy made moments ago (the new-physician sync, then the timed run) would
   look missing and be created twice. The local mirror row is written the
   moment a copy is created (see upsertFromMaster), so fall back to it and
   read that product directly. */
async function findCopy(practiceId, masterKey) {
  // rxcopy: = current copies; rxmaster: / rxbase: = copies made before -
  // found here and re-tagged by this same sync
  const hit = await findProduct(
    `(tag:'rxcopy:${masterKey}' OR tag:'rxmaster:${masterKey}' OR tag:'rxbase:${masterKey}') AND tag:'practice_id:${practiceId}'`,
  );
  if (hit) return hit;
  const row = await Product.findOne({ practiceId, masterKey }, { productId: 1 }).lean();
  return row ? productById(`gid://shopify/Product/${row.productId}`) : null;
}

/* ------------------------------- upsert --------------------------------- */

const statusGql = (m) => {
  const s = String(m[P.STATUS] || "active").trim().toLowerCase();
  return s === "draft" ? "DRAFT" : s === "archived" ? "ARCHIVED" : "ACTIVE";
};
const isPublished = (m) => String(m[P.PUBLISHED]).toUpperCase() === "TRUE";

/** Vendor on a product: the master's own, else the PRODUCT_VENDOR setting.
 *  Never left blank - Shopify then puts the store name ("Protocol app test"). */
const vendorOf = (m, cfg) => String(m[P.VENDOR] || "").trim() || String(cfg.PRODUCT_VENDOR || "").trim() || "Protocol Therapeutics";

function signature(m, tags, vendor = "") {
  const payload = {
    title: m[P.TITLE], desc: m[P.DESCRIPTION], status: statusGql(m), tags, vendor,
    sku: m[P.SKU], sp: m[P.PURCHASE_OPTIONS], pub: m[P.PUBLISHED], images: m[P.IMAGES],
    mfJson: m[P.METAFIELDS],
    mf: [...METAFIELD_COLUMNS, ...METAFIELD_REF_COLUMNS].map((d) => m[d.column]),
  };
  return crypto.createHash("md5").update(JSON.stringify(payload)).digest("base64");
}

/** The master's shared stock onto one product. A failure is logged, not
 *  thrown - stock must not stop the metafields / images / publishing. */
async function setInventoryFromMaster(inventoryItemId, m, master, target) {
  const qty = Number(m[P.INVENTORY]);
  if (String(m[P.INVENTORY] ?? "").trim() === "" || isNaN(qty)) return;
  try {
    await setInventory(inventoryItemId, qty);
  } catch (err) {
    logEvent("sync", "product-sync", `${master.masterKey} / ${target.sigKey}: stock not set - ${err}`, null, false);
  }
}

/**
 * Creates or updates one product (base, or a practice's copy) from a master
 * row. `target` = { sigKey, tags[], find(), launchPrice, withPatientPrice }.
 * Returns 'created' | 'updated' | 'unchanged' | 'skip'.
 */
async function upsertFromMaster(master, target) {
  const m = master.row;
  const tags = target.tags;
  const vendor = vendorOf(m, await getSettings());
  // vendor is in the copies' fingerprint only: a base product keeps its own
  // vendor, and a changed base fingerprint would rewrite the base (images too).
  const sig = signature(m, tags.join(", "), target.practiceId ? vendor : "");
  const existing = await target.find();

  const markSynced = (ok) =>
    ok
      ? MasterProduct.updateOne({ _id: master._id }, { $set: { [`sigs.${target.sigKey}`]: sig } })
      : null;

  if (!existing) {
    const res = await gql(
      `#graphql
      mutation RxProductCreate($product: ProductCreateInput!) {
        productCreate(product: $product) {
          product { id variants(first: 1) { nodes { id inventoryItem { id } } } }
          userErrors { field message }
        }
      }`,
      {
        product: {
          title: String(m[P.TITLE] || ""),
          descriptionHtml: String(m[P.DESCRIPTION] || ""),
          status: statusGql(m),
          vendor,
          tags,
          productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
        },
      },
    );
    const errs = res.productCreate.userErrors || [];
    if (errs.length) {
      logEvent("sync", "product-sync", `create ${target.sigKey} (${master.masterKey}): ${JSON.stringify(errs)}`, null, false);
      return "skip";
    }
    const product = res.productCreate.product;
    const variant = product.variants.nodes[0];
    // Remember it now - findCopy / the base lookup rely on this while search catches up.
    if (target.sigKey === "base") {
      await MasterProduct.updateOne({ _id: master._id }, { $set: { baseProductId: product.id } });
    }
    if (target.practiceId) {
      await Product.updateOne(
        { productId: legacyId(product.id) },
        { $set: { practiceId: target.practiceId, masterKey: master.masterKey, title: String(m[P.TITLE] || "") } },
        { upsert: true },
      );
    }
    // Price is written ONLY here, at creation.
    await setVariant(product.id, variant.id, {
      price: target.launchPrice,
      compareAtPrice: numOrNull(m[P.COMPARE_AT]),
      sku: String(m[P.SKU] || ""),
    });
    if (target.withPatientPrice && target.launchPrice != null) await setPatientPrice(product.id, target.launchPrice);
    await setInventoryFromMaster(variant.inventoryItem.id, m, master, target);
    const mfOk = await writeMetafields(product.id, m);
    await writeImages(product.id, m[P.IMAGES]);
    await syncSubscription(product.id, m[P.PURCHASE_OPTIONS]);
    await setPublished(product.id, isPublished(m));
    await markSynced(mfOk);
    syncProductLater(product.id);
    return "created";
  }

  if ((master.sigs || {})[target.sigKey] === sig) return "unchanged";
  // Never fully synced (a step failed while it was being created): give it
  // its stock now too - the update path otherwise leaves stock alone.
  if (!(master.sigs || {})[target.sigKey] && existing.inventoryItemId) {
    await setInventoryFromMaster(existing.inventoryItemId, m, master, target);
  }

  await gql(
    `#graphql
    mutation RxProductUpdate($product: ProductUpdateInput!) {
      productUpdate(product: $product) { userErrors { field message } }
    }`,
    {
      product: {
        id: existing.productId,
        title: String(m[P.TITLE] || ""),
        descriptionHtml: String(m[P.DESCRIPTION] || ""),
        status: statusGql(m),
        vendor,
        tags,
      },
    },
  );
  await setVariant(existing.productId, existing.variantId, { sku: String(m[P.SKU] || "") });
  const mfOk = await writeMetafields(existing.productId, m);
  await writeImages(existing.productId, m[P.IMAGES]);
  await syncSubscription(existing.productId, m[P.PURCHASE_OPTIONS]);
  await setPublished(existing.productId, isPublished(m));
  await markSynced(mfOk);
  syncProductLater(existing.productId);
  return "updated";
}

const baseTags = (m) => String(m[P.TAGS] || "").split(",").map((t) => t.trim()).filter(Boolean);

/** A copy launches at MSRP Low when that is filled in, else the Price column. */
const launchPrice = (m) => numOrNull(m["MSRP Low"]) ?? numOrNull(m[P.PRICE]);

const baseTarget = (master) => ({
  sigKey: "base",
  tags: [...baseTags(master.row), `rxbase:${master.masterKey}`, "base-product"],
  // the recorded id first - search can lag behind a just-tagged/created base.
  // A recorded id that no longer exists (product deleted / re-imported) is
  // replaced by the base found by its rxbase tag.
  find: async () => {
    const byId = master.baseProductId && (await productById(master.baseProductId));
    if (byId) return byId;
    const found = (await findBase(master.masterKey)) || (await adoptBaseByTitle(master));
    if (found && found.productId !== master.baseProductId) {
      await MasterProduct.updateOne({ _id: master._id }, { $set: { baseProductId: found.productId } });
      master.baseProductId = found.productId;
    }
    return found;
  },
  launchPrice: numOrNull(master.row[P.PRICE]),
  withPatientPrice: false,
});
/* No product carries this master's rxbase tag (e.g. the catalogue was
   re-imported into Shopify). Rather than create a duplicate, adopt the ONE
   plain product with exactly the master's title - not a practice copy, not
   another master's base - by tagging it rxbase:<key> + base-product. */
async function adoptBaseByTitle(master) {
  const title = String(master.row?.[P.TITLE] || "").trim();
  if (!title) return null;
  const data = await gql(
    `#graphql
    query RxBaseByTitle($q: String!) {
      products(first: 10, query: $q) { nodes { id title tags variants(first: 1) { nodes { id inventoryItem { id } } } } }
    }`,
    { q: `title:${JSON.stringify(title)}` },
  );
  const plain = (data.products?.nodes || []).filter(
    (n) => n.title.trim().toLowerCase() === title.toLowerCase() &&
      !(n.tags || []).some((t) => /^(practice_id:|rxcopy:|rxmaster:|rxbase:)/i.test(t)) &&
      n.variants?.nodes?.[0],
  );
  if (plain.length !== 1) return null; // none, or ambiguous - leave it to create / a person
  const n = plain[0];
  const res = await gql(
    `#graphql
    mutation RxAdoptBase($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
    { id: n.id, tags: [`rxbase:${master.masterKey}`, "base-product"] },
  );
  if ((res.tagsAdd?.userErrors || []).length) return null;
  logEvent("sync", "product-sync", `${master.masterKey}: adopted "${title}" (${n.id}) as its base product`);
  return { productId: n.id, variantId: n.variants.nodes[0].id, inventoryItemId: n.variants.nodes[0].inventoryItem.id };
}

const practiceTarget = (master, practiceId) => ({
  practiceId,
  sigKey: `practice:${practiceId}`,
  tags: [...baseTags(master.row), `practice_id:${practiceId}`, `rxcopy:${master.masterKey}`],
  find: () => findCopy(practiceId, master.masterKey),
  launchPrice: launchPrice(master.row),
  withPatientPrice: true,
});

/* ------------------------------ practices ------------------------------- */

/**
 * Practices that should have product copies: every practice_id carried by a
 * wholesale customer who also has doctor_id + clinic_id. Read live from
 * Shopify (not the local mirror) because this decides what gets created.
 */
async function activePracticeIds() {
  const nodes = await gqlAll(
    `#graphql
    query RxDoctors($after: String) {
      customers(first: 100, after: $after, query: "tag:'wholesale'") {
        pageInfo { hasNextPage endCursor }
        nodes { tags }
      }
    }`,
    {},
    (d) => d.customers,
    { max: 20000 },
  );
  const ids = new Set();
  for (const n of nodes) {
    const tags = n.tags || [];
    const practiceId = tagVal(tags, "practice_id:");
    if (practiceId && tagVal(tags, "doctor_id:") && tagVal(tags, "clinic_id:")) ids.add(practiceId);
  }
  return [...ids];
}

/**
 * Practices that still have product copies but no active physician.
 * Their products are only DELETED when PRODUCT_SYNC_DELETE_ORPHANS is TRUE
 * and the practice has been missing on two runs in a row (Shopify's customer
 * search can briefly omit a customer right after a tag change).
 */
async function handleOrphanPractices(active) {
  const withCopies = await Product.distinct("practiceId", { practiceId: { $ne: "" }, masterKey: { $ne: "" } });
  const orphans = withCopies.filter((id) => !active.includes(id));
  const cfg = await getSettings();
  const state = mongoose.connection.db.collection("kv");
  const out = [];
  for (const practiceId of orphans) {
    const key = "orphan-practice:" + practiceId;
    const seen = await state.findOne({ _id: key });
    if (!seen) {
      await state.updateOne({ _id: key }, { $set: { value: Date.now(), expiresAt: null } }, { upsert: true });
      logEvent("sync", "product-sync", `practice ${practiceId} has no active physician - flagged, nothing deleted`);
      continue;
    }
    if (!isTrue(cfg.PRODUCT_SYNC_DELETE_ORPHANS)) {
      out.push(practiceId);
      continue;
    }
    const products = await Product.find({ practiceId, masterKey: { $ne: "" } }, { productId: 1 }).lean();
    for (const p of products) {
      await gql(
        `#graphql
        mutation RxProductDelete($id: ID!) { productDelete(input: { id: $id }) { deletedProductId userErrors { message } } }`,
        { id: `gid://shopify/Product/${p.productId}` },
      );
      await Product.deleteOne({ productId: p.productId });
    }
    await state.deleteOne({ _id: key });
    logEvent("sync", "product-sync", `practice ${practiceId}: last physician removed - ${products.length} product copies deleted`);
  }
  // a practice that came back is no longer flagged
  await state.deleteMany({ _id: { $in: active.map((id) => "orphan-practice:" + id) } });
  return out;
}

/* ------------------------- deleted last physician ------------------------ */

/* Set when a practice's copies are deleted because its last physician was
   deleted. Shopify's customer search keeps returning a deleted customer for
   a while, so without this mark the next sync would see the practice as
   active again and re-create every copy. Cleared as soon as a real
   physician is confirmed for the practice. */
const REMOVED_TTL = 6 * 3600;
const removedKey = (practiceId) => "practice-removed:" + practiceId;

/**
 * Does the practice still have a physician (doctor + clinic + practice id,
 * wholesale)? Candidates come from the local accounts AND Shopify's search,
 * and each one is confirmed by a live read by id - the search alone lags
 * both ways (still lists a deleted customer, misses a brand-new one).
 * `except` = the customer being deleted. Throws when Shopify can't be read.
 */
async function practiceHasPhysician(practiceId, except = "") {
  const fromSearch = await gqlAll(
    `#graphql
    query RxPracticeCustomers($after: String, $q: String!) {
      customers(first: 100, after: $after, query: $q) {
        pageInfo { hasNextPage endCursor }
        nodes { legacyResourceId }
      }
    }`,
    // wholesale = portal users only, not the practice's patients
    { q: `tag:'practice_id:${practiceId}' AND tag:'wholesale'` },
    (d) => d.customers,
    { max: 2000 },
  );
  const local = await Account.find(
    { practiceId, doctorId: { $ne: "" }, clinicId: { $ne: "" } },
    { customerId: 1 },
  ).lean();
  const ids = new Set([...fromSearch.map((n) => String(n.legacyResourceId)), ...local.map((a) => a.customerId)]);
  ids.delete(String(except));
  for (const id of ids) {
    const c = await getCustomer(id);
    if (!c) continue;
    const t = idsFromCustomerTags(tagList(c.tags));
    if (t.doctorId && t.clinicId && t.wholesale && t.practiceId === practiceId) return true;
  }
  return false;
}

/** Copies of a removed practice must not be re-created - unless a physician
 *  has been added since, which also clears the mark. */
async function blockedAsRemoved(practiceId) {
  if (!(await kvGet(removedKey(practiceId)))) return false;
  let has;
  try {
    has = await practiceHasPhysician(practiceId);
  } catch {
    return true; // can't confirm -> don't re-create
  }
  if (has) await kvSet(removedKey(practiceId), 0, 1);
  return !has;
}

const removingCopies = new Map(); // practiceId -> running promise

/**
 * A portal user was deleted: when that leaves the practice with no
 * physician, its product copies are deleted straight away (the timed
 * orphan check would wait two runs and, by default, only report them).
 * Shared by the Delete button and the customers/delete webhook - a second
 * call for the same practice joins the first. Returns { deleted } or
 * { kept: reason }.
 */
export function removePracticeCopiesIfUnused(practiceId, { except = "" } = {}) {
  practiceId = String(practiceId || "").trim();
  if (!practiceId) return Promise.resolve({ kept: "no practice id" });
  if (removingCopies.has(practiceId)) return removingCopies.get(practiceId);
  const run = (async () => {
    await connectDb();
    let has;
    try {
      has = await practiceHasPhysician(practiceId, except);
    } catch (err) {
      logEvent("error", "product-delete", `practice ${practiceId}: could not check its physicians - copies kept (${err.message || err})`, null, false);
      return { kept: "could not check physicians" };
    }
    if (has) return { kept: "practice still has a physician" };

    // Mark first, so a sync running right now skips this practice from here on.
    await kvSet(removedKey(practiceId), Date.now(), REMOVED_TTL);
    const deleted = await deletePracticeProducts(practiceId);
    // A copy that a sync was creating at that very moment is caught here,
    // once that sync lets go of the lock.
    withLock("product-sync", () => deletePracticeProducts(practiceId))
      .then((late) => late && logEvent("sync", "product-delete", `practice ${practiceId}: ${late} late copies deleted`))
      .catch(() => {});
    await MasterProduct.updateMany({}, { $unset: { [`sigs.practice:${practiceId}`]: "" } });
    await mongoose.connection.db.collection("kv").deleteOne({ _id: "orphan-practice:" + practiceId });
    logEvent("sync", "product-delete", `practice ${practiceId}: last physician deleted - ${deleted} product copies deleted`);
    return { deleted };
  })().finally(() => removingCopies.delete(practiceId));
  removingCopies.set(practiceId, run);
  return run;
}

/** Deletes every copy of one practice (local mirror + Shopify search, so a
 *  copy the search hasn't indexed yet is not missed). Returns the count. */
async function deletePracticeProducts(practiceId) {
  const rows = await Product.find({ practiceId, masterKey: { $ne: "" } }, { productId: 1 }).lean();
  const found = await gqlAll(
    `#graphql
    query RxPracticeCopies($after: String, $q: String!) {
      products(first: 100, after: $after, query: $q) {
        pageInfo { hasNextPage endCursor }
        nodes { id tags }
      }
    }`,
    { q: `tag:'practice_id:${practiceId}'` },
    (d) => d.products,
    { max: 5000 },
  );
  const ids = new Set(rows.map((r) => String(r.productId)));
  for (const n of found) {
    // only the practice's copies of master products - never anything else with the tag
    if (copyMasterKey(n.tags) && tagVal(n.tags, "practice_id:") === practiceId) ids.add(legacyId(n.id));
  }
  let deleted = 0;
  const queue = [...ids];
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      const res = await gql(
        `#graphql
        mutation RxDeletePracticeCopy($id: ID!) { productDelete(input: { id: $id }) { deletedProductId userErrors { message } } }`,
        { id: `gid://shopify/Product/${id}` },
      );
      const errs = res.productDelete?.userErrors || [];
      if (errs.length && !/not.*(found|exist)/i.test(errs.map((e) => e.message).join("; "))) {
        logEvent("error", "product-delete", `practice ${practiceId}: product ${id} not deleted - ${errs.map((e) => e.message).join("; ")}`, null, false);
        continue;
      }
      await Product.deleteOne({ productId: id });
      if (!errs.length) deleted++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, queue.length) }, worker));
  return deleted;
}

/* ----------------------- product metafield definitions ------------------- */

/* Every custom.* product metafield the app writes and the theme reads, with
   the SAME type the app writes it with (a different type would make those
   writes fail). A fresh store has none of these: the theme can't use one as a
   dynamic source until it is defined ("Dynamic source
   'product.metafields.custom.product_short_headline.value' does not exist"
   on theme push), and admin shows them as unstructured.
   quality_trust_block (metaobject_reference) is left out - it needs the
   metaobject definition it points to, which only the live store has. */
const PRODUCT_METAFIELD_DEFS = [
  ...METAFIELD_COLUMNS.map((d) => ({ key: d.key, name: d.column, type: d.type })),
  { key: "ingredient_facts_image", name: "Ingredient Facts Image", type: "file_reference" },
  { key: "formulation_features", name: "Formulation Features", type: "list.file_reference" },
  { key: "patient_price", name: "Patient Price", type: "money" },
  { key: "physician_commission", name: "Physician Commission", type: "money" },
  { key: "clinic_commission", name: "Clinic Commission", type: "money" },
];

/** Creates the missing definitions above (existing ones are never changed).
 *  Returns { created: [...], existing, failed: [...] }. */
export async function ensureProductMetafieldDefinitions() {
  const data = await gql(
    `#graphql
    query RxProductMfDefs {
      metafieldDefinitions(first: 250, ownerType: PRODUCT, namespace: "custom") { nodes { key type { name } } }
    }`,
  );
  const have = new Map((data.metafieldDefinitions?.nodes || []).map((n) => [n.key, n.type?.name]));
  const out = { created: [], existing: have.size, failed: [] };
  for (const d of PRODUCT_METAFIELD_DEFS) {
    if (have.has(d.key)) {
      if (have.get(d.key) !== d.type) {
        logEvent("sync", "metafield-defs", `custom.${d.key} is defined as ${have.get(d.key)} in Shopify but the app writes ${d.type} - left as it is`, null, false);
      }
      continue;
    }
    const res = await gql(
      `#graphql
      mutation RxCreateMfDef($def: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $def) { createdDefinition { id } userErrors { field message code } }
      }`,
      { def: { name: d.name, namespace: "custom", key: d.key, type: d.type, ownerType: "PRODUCT" } },
    );
    const errs = res.metafieldDefinitionCreate?.userErrors || [];
    if (errs.length) out.failed.push(`${d.key}: ${errs.map((e) => e.message).join("; ")}`);
    else out.created.push(d.key);
  }
  if (out.created.length || out.failed.length) {
    logEvent("sync", "metafield-defs", `product metafield definitions ${JSON.stringify(out)}`, null, !out.failed.length);
  }
  return out;
}

/* -------------------------------- jobs ---------------------------------- */

let mfDefsChecked = false;

/** The 30-minute sync: base products + one copy per active practice. */
export function runProductSync() {
  return withLock("product-sync", async () => {
    await connectDb();
    fileMap = null;
    publications = null;
    // One-time repair of masters imported before vendor / sales channels were
    // read, and of the stock the old location mix-up wiped to 0.
    if (!(await kvGet("migration:masters-from-base-1")) && (await MasterProduct.exists({ baseProductId: { $ne: "" } }))) {
      await refreshMastersFromBase();
      await kvSet("migration:masters-from-base-1", 1);
    }
    // definitions first, so the metafields written below are typed (once per run of the app)
    if (!mfDefsChecked) {
      mfDefsChecked = true;
      await ensureProductMetafieldDefinitions().catch((err) => logEvent("error", "metafield-defs", String(err), null, false));
    }
    const masters = await MasterProduct.find({}).lean();
    if (!masters.length) return { message: "No master products yet." };

    // A practice whose last physician was just deleted can still show up in
    // Shopify's lagging customer search - it must not get its copies back.
    const practices = [];
    for (const id of await activePracticeIds()) {
      if (!(await blockedAsRemoved(id))) practices.push(id);
    }
    const orphans = await handleOrphanPractices(practices);
    const tally = { created: 0, updated: 0, unchanged: 0, skip: 0 };
    const run = async (master, target) => {
      try {
        tally[await upsertFromMaster(master, target)]++;
      } catch (err) {
        tally.skip++;
        logEvent("sync", "product-sync", `${master.masterKey} / ${target.sigKey}: ${err}`, null, false);
      }
    };
    for (const master of masters) await run(master, baseTarget(master));
    for (const practiceId of practices) {
      for (const master of masters) {
        if (await kvGet(removedKey(practiceId))) break; // its last physician was deleted mid-run
        await run(master, practiceTarget(master, practiceId));
      }
    }
    const result = { practices: practices.length, masters: masters.length, ...tally, orphanPractices: orphans };
    logEvent("sync", "product-sync", `done ${JSON.stringify(result)}`);
    welcomeAfterProducts(); // a practice may have just been completed
    return result;
  });
}

/**
 * Copies for ONE practice, run right after a physician is created so a new
 * practice doesn't wait for the next timed run (up to 30 minutes). Takes the
 * id directly instead of searching customers - that search can lag minutes
 * behind a just-created customer. Copies that already exist are updated or
 * left alone, never duplicated (see findCopy).
 */
export function syncPracticeCopies(practiceId) {
  practiceId = String(practiceId || "").trim();
  if (!practiceId) return Promise.resolve({ message: "No practice id." });
  copiesInProgress.add(practiceId);
  return runPracticeCopies(practiceId).finally(() => {
    copiesInProgress.delete(practiceId);
    welcomeAfterProducts();
  });
}

/**
 * Is this practice's product set complete? done = not being created right
 * now AND every master's copy finished its sync. No masters = nothing to
 * create = done. The welcome email of a physician waits on this.
 */
export async function practiceCopiesStatus(practiceId) {
  await connectDb();
  const [masters, finished] = await Promise.all([
    MasterProduct.countDocuments(),
    MasterProduct.countDocuments({ [`sigs.practice:${practiceId}`]: { $exists: true } }),
  ]);
  const inProgress = copiesInProgress.has(String(practiceId));
  return { masters, finished, inProgress, done: !inProgress && finished >= masters };
}

/* A product run just finished - send any welcome email that was waiting
   for its practice's products (dynamic import: provisioning imports this file). */
function welcomeAfterProducts() {
  import("./provisioning.server.js")
    .then((m) => m.sendDueWelcomeEmailsSoon(1000))
    .catch(() => {});
}

/* Practices whose copy run is queued or running - shown as "Creating…" on
   the Accounts page, and so one practice is never queued twice. */
const copiesInProgress = new Set();
export const practiceCopiesInProgress = () => [...copiesInProgress];

/**
 * Gives a practice its product copies the moment it has a physician, from
 * wherever that physician came from (Accounts page, Shopify admin, the old
 * scripts, a re-sync). Skips a practice that already has copies - those are
 * kept current by the timed sync - or one already queued.
 */
export async function ensurePracticeCopies(practiceId) {
  practiceId = String(practiceId || "").trim();
  if (!practiceId || copiesInProgress.has(practiceId)) return { skipped: "queued" };
  copiesInProgress.add(practiceId); // claimed before any await - two triggers can't both start it
  try {
    await connectDb();
    // Complete = it has copies AND every master's copy finished its sync
    // (a half-built copy from a failed run has no fingerprint yet).
    const [hasCopies, masters, finished] = await Promise.all([
      Product.exists({ practiceId, masterKey: { $ne: "" } }),
      MasterProduct.countDocuments(),
      MasterProduct.countDocuments({ [`sigs.practice:${practiceId}`]: { $exists: true } }),
    ]);
    if (hasCopies && finished >= masters) return { skipped: "has copies" };
    return await runPracticeCopies(practiceId);
  } finally {
    copiesInProgress.delete(practiceId);
    welcomeAfterProducts(); // products ready (or already were) - welcome may go now
  }
}

function runPracticeCopies(practiceId) {
  return withLock("product-sync", async () => {
    await connectDb();
    fileMap = null;
    publications = null;
    const masters = await MasterProduct.find({}).lean();
    if (!masters.length) {
      logEvent("sync", "product-sync", `practice ${practiceId}: no master products yet - nothing to copy`, null, false);
      return { message: "No master products yet." };
    }
    // Last physician deleted moments ago and this was triggered by a stale
    // read of them -> no copies. A newly added physician clears the mark.
    if (await blockedAsRemoved(practiceId)) {
      logEvent("sync", "product-sync", `practice ${practiceId}: no physician left (deleted) - copies not re-created`);
      return { practiceId, skipped: "practice removed" };
    }
    const tally = { created: 0, updated: 0, unchanged: 0, skip: 0 };
    for (const master of masters) {
      if (await kvGet(removedKey(practiceId))) break; // last physician deleted mid-run
      try {
        tally[await upsertFromMaster(master, practiceTarget(master, practiceId))]++;
      } catch (err) {
        tally.skip++;
        logEvent("sync", "product-sync", `${master.masterKey} / practice:${practiceId}: ${err}`, null, false);
      }
    }
    const result = { practiceId, masters: masters.length, ...tally };
    logEvent("sync", "product-sync", `new physician - practice copies ${JSON.stringify(result)}`);
    return result;
  });
}

/* --------------------------- maintenance tools -------------------------- */

/**
 * Duplicate practice copies (was Rx-Product-Sync's
 * cleanupLegacyDoctorTaggedCopies). Groups every product by
 * (master key, practice_id) and:
 *   - collapses duplicate CLEAN copies (no doctor_id:) to the OLDEST one -
 *     made when two runs overlapped while Shopify's search lagged;
 *   - deletes leftover copies from the old one-copy-per-doctor design (they
 *     still carry doctor_id:), but only when a clean copy exists for that
 *     pair - so a practice is never left without the product. A group with
 *     doctor-tagged copies and no clean one is reported, not touched.
 * `dryRun` only reports. Runs under the product-sync lock so it can never
 * overlap a sync (that overlap is what makes duplicates).
 */
export function cleanupDuplicateCopies({ dryRun = true } = {}) {
  return withLock("product-sync", async () => {
    await connectDb();
    const nodes = await gqlAll(
      `#graphql
      query RxAllCopies($after: String) {
        products(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { id title tags createdAt }
        }
      }`,
      {},
      (d) => d.products,
      { max: 20000 },
    );
    const groups = new Map(); // "master||practice" -> { clean: [], stale: [] }
    for (const n of nodes) {
      const masterKey = copyMasterKey(n.tags);
      const practiceId = tagVal(n.tags, "practice_id:");
      if (!masterKey || !practiceId) continue;
      const key = `${masterKey}||${practiceId}`;
      const g = groups.get(key) || { masterKey, practiceId, clean: [], stale: [] };
      groups.set(key, g);
      const doctorId = tagVal(n.tags, "doctor_id:");
      (doctorId ? g.stale : g.clean).push({ id: n.id, title: n.title, createdAt: n.createdAt, doctorId });
    }

    const plan = { duplicates: [], legacy: [], skipped: [] };
    for (const g of groups.values()) {
      g.clean.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      const keep = g.clean[0];
      for (const p of g.clean.slice(1)) plan.duplicates.push({ ...p, practiceId: g.practiceId, masterKey: g.masterKey, keep: keep.id });
      if (!g.stale.length) continue;
      if (!keep) {
        plan.skipped.push({ practiceId: g.practiceId, masterKey: g.masterKey, count: g.stale.length });
        continue;
      }
      for (const p of g.stale) plan.legacy.push({ ...p, practiceId: g.practiceId, masterKey: g.masterKey, keep: keep.id });
    }

    let deleted = 0;
    if (!dryRun) {
      for (const p of [...plan.duplicates, ...plan.legacy]) {
        const res = await gql(
          `#graphql
          mutation RxDeleteCopy($id: ID!) { productDelete(input: { id: $id }) { deletedProductId userErrors { message } } }`,
          { id: p.id },
        );
        if ((res.productDelete?.userErrors || []).length) continue;
        await Product.deleteOne({ productId: legacyId(p.id) });
        deleted++;
        logEvent("sync", "product-cleanup",
          `deleted ${p.doctorId ? `leftover doctor_id:${p.doctorId}` : "duplicate"} copy "${p.title}" (${p.id}) for ` +
          `${p.masterKey} / ${p.practiceId} - kept ${p.keep}`);
      }
      for (const s of plan.skipped) {
        logEvent("sync", "product-cleanup", `${s.masterKey} / ${s.practiceId}: ${s.count} doctor-tagged copies, no clean copy - left for review`, null, false);
      }
    }
    return {
      dryRun,
      groups: groups.size,
      duplicates: plan.duplicates.length,
      legacy: plan.legacy.length,
      skipped: plan.skipped.length,
      deleted,
      // a sample for the preview
      sample: [...plan.duplicates, ...plan.legacy].slice(0, 25).map((p) => ({
        title: p.title, practiceId: p.practiceId, kind: p.doctorId ? "leftover per-doctor copy" : "duplicate", createdAt: p.createdAt,
      })),
    };
  });
}

/**
 * Forget every practice copy's "already in step" fingerprint, then run the
 * sync - so every copy's details, metafields, images and subscription are
 * rewritten from its master even if nothing looks changed (was
 * forceResyncPracticeMetafields_). Base products and prices are untouched.
 */
export async function forceResyncCopies() {
  await connectDb();
  const masters = await MasterProduct.find({}, { sigs: 1 }).lean();
  let cleared = 0;
  for (const m of masters) {
    const keep = Object.fromEntries(Object.entries(m.sigs || {}).filter(([k]) => !k.startsWith("practice:")));
    cleared += Object.keys(m.sigs || {}).length - Object.keys(keep).length;
    await MasterProduct.updateOne({ _id: m._id }, { $set: { sigs: keep } });
  }
  logEvent("sync", "product-sync", `force re-sync: cleared ${cleared} practice copy fingerprints`);
  const result = await runProductSync();
  return { cleared, ...result };
}

/** On demand: push each master's price (MSRP Low, else Price) to every
 *  EXISTING practice copy. Never runs on the timer. */
export function syncMasterPrices() {
  return withLock("product-sync", async () => {
    await connectDb();
    const masters = await MasterProduct.find({}).lean();
    const practices = await activePracticeIds();
    let updated = 0;
    let skipped = 0;
    for (const practiceId of practices) {
      for (const master of masters) {
        const price = launchPrice(master.row);
        const existing = price == null ? null : await findCopy(practiceId, master.masterKey);
        if (!existing) {
          skipped++;
          continue;
        }
        await setVariant(existing.productId, existing.variantId, {
          price,
          compareAtPrice: numOrNull(master.row[P.COMPARE_AT]),
        });
        await setPatientPrice(existing.productId, price);
        syncProductLater(existing.productId);
        updated++;
      }
    }
    logEvent("sync", "price-sync", `practices=${practices.length} masters=${masters.length} updated=${updated} skipped=${skipped}`);
    return { ok: true, practices: practices.length, masters: masters.length, updated, skipped };
  });
}

/**
 * Shared inventory. When any copy's quantity differs from the master's
 * recorded Inventory, that copy just sold: its new quantity is pushed to
 * every other copy of the master and written back to the master.
 */
export function syncSharedInventory() {
  return withLock("inventory-sync", async () => {
    await connectDb();
    const masters = await MasterProduct.find({}).lean();
    if (!masters.length) return { masters: 0 };
    const loc = await locationId();
    const copies = await Product.find({ masterKey: { $ne: "" } }, { productId: 1, masterKey: 1, practiceId: 1 }).lean();
    // A copy that never finished its first sync (no fingerprint for its
    // practice) still has whatever stock it was created with - often 0. Read
    // as a "sale", it would push that 0 to every copy and the master, so
    // such copies are left out of the comparison until the sync completes them.
    const finished = (masterKey, practiceId) => {
      const m = masters.find((x) => x.masterKey === masterKey);
      return !!(m && (m.sigs || {})[`practice:${practiceId}`]);
    };

    const index = {}; // masterKey -> [{ inventoryItemId, qty }]
    for (let i = 0; i < copies.length; i += 50) {
      const batch = copies.slice(i, i + 50);
      const data = await gql(
        `#graphql
        query RxCopyInventory($ids: [ID!]!, $loc: ID!) {
          nodes(ids: $ids) {
            ... on Product {
              id
              variants(first: 1) {
                nodes {
                  inventoryItem {
                    id
                    inventoryLevel(locationId: $loc) { quantities(names: ["available"]) { quantity } }
                  }
                }
              }
            }
          }
        }`,
        { ids: batch.map((p) => `gid://shopify/Product/${p.productId}`), loc },
      );
      for (const n of data.nodes || []) {
        if (!n?.id) continue;
        const copy = batch.find((p) => p.productId === legacyId(n.id));
        const item = n.variants?.nodes?.[0]?.inventoryItem;
        if (!copy || !item) continue;
        if (!finished(copy.masterKey, copy.practiceId)) continue;
        (index[copy.masterKey] ||= []).push({ inventoryItemId: item.id, qty: levelQty(item) });
      }
    }

    // Stock location changed (Settings -> LOCATION_ID), or first run: the
    // copies' numbers at the new location say nothing about sales - often
    // they are simply not stocked there, or hold 0. Reading them as sales is
    // what once wiped every master to 0. So the copies are re-stocked from
    // the masters at the new location instead, and comparing starts again
    // next run.
    const LOC_KEY = "inventory-location";
    if ((await kvGet(LOC_KEY)) !== loc) {
      let set = 0;
      let failed = 0;
      for (const master of masters) {
        const raw = master.row[P.INVENTORY];
        if (raw == null || String(raw).trim() === "" || isNaN(Number(raw))) continue;
        for (const c of index[master.masterKey] || []) {
          if (c.qty === Number(raw)) continue;
          try {
            await setInventory(c.inventoryItemId, Number(raw));
            set++;
          } catch (err) {
            failed++;
            logEvent("sync", "inventory", `"${master.masterKey}": stock not set on one copy - ${err}`, null, false);
          }
        }
      }
      if (!failed) await kvSet(LOC_KEY, loc);
      logEvent("sync", "inventory", `stock location is ${loc} - ${set} copies set from the master list${failed ? `, ${failed} failed (retried next run)` : ""}`);
      return { masters: masters.length, copies: copies.length, restocked: set, failed };
    }

    let changedMasters = 0;
    for (const master of masters) {
      const raw = master.row[P.INVENTORY];
      const recorded = raw == null || String(raw).trim() === "" ? null : Number(raw);
      if (recorded == null || isNaN(recorded)) continue;
      // not stocked at the location = unknown, never "sold out"
      const list = (index[master.masterKey] || []).filter((c) => c.qty != null);
      const moved = list.filter((c) => c.qty !== recorded);
      if (!moved.length) continue;
      // Every copy sells from the same shared stock: each copy's own drop
      // (or restock) is applied to the shared number - two practices selling
      // in the same window both count, not just the last one seen.
      const newQty = recorded + moved.reduce((sum, c) => sum + (c.qty - recorded), 0);
      if (newQty < 0) {
        logEvent("sync", "inventory",
          `"${master.masterKey}": copies changed by more than the ${recorded} in stock (${moved.map((c) => c.qty).join(", ")}) - left as it is; set the stock on the Products page`,
          null, false);
        continue;
      }
      let failed = 0;
      for (const c of list) {
        if (c.qty === newQty) continue;
        try {
          await setInventory(c.inventoryItemId, newQty);
        } catch (err) {
          failed++;
          logEvent("sync", "inventory", `"${master.masterKey}": stock not set on one copy - ${err}`, null, false);
        }
      }
      // only record the new number once every copy actually holds it
      if (failed) continue;
      await MasterProduct.updateOne({ _id: master._id }, { $set: { [`row.${P.INVENTORY}`]: newQty } });
      logEvent("sync", "inventory", `"${master.masterKey}": ${recorded} -> ${newQty} across ${list.length} copies`);
      // the base product shows the same shared stock in Shopify admin
      const base = master.baseProductId && (await productById(master.baseProductId).catch(() => null));
      if (base?.inventoryItemId) await setInventory(base.inventoryItemId, newQty).catch((err) =>
        logEvent("sync", "inventory", `"${master.masterKey}": base stock not set - ${err}`, null, false));
      changedMasters++;
    }
    return { masters: masters.length, copies: copies.length, changed: changedMasters };
  });
}

/**
 * Re-reads Vendor, Published and Inventory of every master from its base
 * product in the store, then lets the copies follow: vendor and sales
 * channels on the next product sync, stock on the next stock run (the copies
 * are re-stocked from these numbers, not compared against them). Repairs
 * masters imported with the unpublished/blank-vendor bug, and stock wiped by
 * the old location mix-up. The base itself is not rewritten.
 */
export function refreshMastersFromBase() {
  return withLock("inventory-sync", async () => {
    await connectDb();
    const masters = await MasterProduct.find({}).lean();
    const out = { masters: masters.length, updated: 0, unchanged: 0, missing: 0 };
    for (const master of masters) {
      const base = await baseTarget(master).find().catch(() => null);
      if (!base) { out.missing++; continue; }
      // everything the base has (stock included); stock is pushed to the
      // copies below by the re-stock, not one by one (this run holds the lock)
      const res = await pullMasterFromBase(base.productId, { pushStock: false });
      if (res.updated) out.updated++;
      else out.unchanged++;
    }
    await kvSet("inventory-location", "", 1); // next stock run re-stocks the copies from these numbers
    await kvSet("migration:masters-from-base-1", 1);
    logEvent("sync", "product-sync", `masters refreshed from their base products ${JSON.stringify(out)}`);
    return out;
  });
}

/* ------------------- one-time metafield import (products CSV) ------------------ */

/** RFC-4180 CSV (quoted fields, "" escapes, newlines inside quotes). */
export function parseCsv(text) {
  const t = String(text || "").replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let f = "";
  let q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') {
        if (t[i + 1] === '"') { f += '"'; i++; } else q = false;
      } else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(f); rows.push(row); row = []; f = "";
    } else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ""));
}

const normTitle = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
// Shopify's export puts one list value per line
const EXPORT_LIST_SPLIT = /\r?\n/;

/** "Name (product.metafields.ns.key)" -> { label, namespace, key } */
function metafieldColumn(header) {
  const m = /^(.*)\(product\.metafields\.([^.)]+)\.([^)]+)\)\s*$/.exec(String(header || ""));
  return m ? { label: m[1].trim(), namespace: m[2], key: m[3] } : null;
}

/* A metaobject handle (export format) -> "handle (gid)" master cell, or "". */
async function metaobjectCell(handle) {
  const defs = await gql(`#graphql
    query RxMoTypes { metaobjectDefinitions(first: 50) { nodes { type } } }`);
  for (const { type } of defs.metaobjectDefinitions?.nodes || []) {
    const d = await gql(
      `#graphql
      query RxMoByHandle($h: MetaobjectHandleInput!) { metaobjectByHandle(handle: $h) { id } }`,
      { h: { type, handle } },
    );
    if (d.metaobjectByHandle?.id) return `${handle} (${d.metaobjectByHandle.id})`;
  }
  return "";
}

/**
 * One-time import of product metafields from a Shopify "Export products" CSV
 * (Settings page). For each product in the file (matched to a master by
 * title): its custom.* metafield values go into the master row, are written
 * to the base product straight away, and reach every practice copy on the
 * next product sync. Missing definitions are created first. `dryRun` only
 * reports. Columns with no data, Shopify's own standard (shopify.*)
 * metafields and references whose target doesn't exist in this store are
 * skipped and listed.
 */
export async function importMetafieldsCsv(text, { dryRun = true } = {}) {
  await connectDb();
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error("The file has no product rows.");
  const head = rows[0];
  const col = (name) => head.indexOf(name);
  if (col("Title") < 0 || col("Handle") < 0) {
    throw new Error("This is not a Shopify products export - the Handle / Title columns are missing.");
  }

  const known = new Map([...METAFIELD_COLUMNS, ...METAFIELD_REF_COLUMNS].map((d) => [d.key, d]));
  const mfCols = head.map((h, i) => ({ i, ...metafieldColumn(h) })).filter((c) => c.key);
  const out = {
    dryRun, products: 0, matched: [], unmatched: [], skippedColumns: [], extraKeys: [],
    referencesNotFound: [], definitions: null, updatedMasters: 0, baseErrors: [],
  };

  // one entry per handle - image rows repeat the handle with blank fields
  const byHandle = new Map();
  for (const r of rows.slice(1)) {
    const h = String(r[col("Handle")] || "").trim();
    if (!h) continue;
    const cur = byHandle.get(h) || { handle: h, title: "", values: {} };
    if (!cur.title) cur.title = String(r[col("Title")] || "").trim();
    for (const c of mfCols) {
      const v = String(r[c.i] ?? "").trim();
      const id = c.key + "|" + c.namespace;
      if (v && !cur.values[id]) cur.values[id] = v;
    }
    byHandle.set(h, cur);
  }
  out.products = byHandle.size;

  // which columns carry data at all
  const used = new Set();
  for (const p of byHandle.values()) for (const k of Object.keys(p.values)) used.add(k);
  for (const c of mfCols) {
    const id = c.key + "|" + c.namespace;
    if (!used.has(id)) out.skippedColumns.push(`${c.namespace}.${c.key} (no data)`);
    else if (c.namespace !== "custom") out.skippedColumns.push(`${c.namespace}.${c.key} (Shopify standard metafield - not imported)`);
    else if (!known.has(c.key)) out.extraKeys.push(c.key);
  }

  // a type for keys the app doesn't know, from their values
  const extraType = {};
  for (const key of out.extraKeys) {
    const vals = [...byHandle.values()].map((p) => p.values[key + "|custom"]).filter(Boolean);
    extraType[key] = vals.every((v) => /^\d+(\.\d+)?\s+[A-Z]{3}$/.test(v)) ? "money"
      : vals.some((v) => /\n/.test(v)) ? "multi_line_text_field" : "single_line_text_field";
  }

  const masters = await MasterProduct.find({}).lean();
  const byTitle = new Map(masters.map((m) => [normTitle(m.row?.[P.TITLE]), m]));
  const moCache = {};
  const changes = new Map(); // master _id -> { master, row }

  for (const p of byHandle.values()) {
    const master = byTitle.get(normTitle(p.title));
    if (!master) { out.unmatched.push(`${p.title} (${p.handle})`); continue; }
    const entry = changes.get(String(master._id)) || { master, row: { ...master.row } };
    let fields = 0;
    const extra = [];
    for (const [id, raw] of Object.entries(p.values)) {
      const [key, ns] = id.split("|");
      if (ns !== "custom") continue;
      const def = known.get(key);
      if (!def) {
        const type = extraType[key];
        extra.push({ namespace: "custom", key, type, value: type === "money" ? formatMetafieldValue("money", raw) : raw });
        continue;
      }
      let cell = raw;
      if (def.type === "money") cell = raw.replace(/[^0-9.]/g, "");
      else if (def.source === "gid") {
        if (!(raw in moCache)) moCache[raw] = raw.startsWith("gid://") ? raw : await metaobjectCell(raw);
        cell = moCache[raw];
        if (!cell) { out.referencesNotFound.push(`${p.title}: ${key} = ${raw}`); continue; }
      } else if (def.source === "url") {
        cell = raw.split(EXPORT_LIST_SPLIT).map((x) => x.trim()).filter(Boolean).join(", ");
      } else if (def.type.startsWith("list.")) {
        cell = raw.split(EXPORT_LIST_SPLIT).map((x) => x.trim()).filter(Boolean).join(" | ");
      }
      entry.row[def.column] = cell;
      fields++;
    }
    if (extra.length) {
      let list = [];
      try { list = JSON.parse(entry.row[P.METAFIELDS] || "[]"); } catch { list = []; }
      for (const e of extra) list = [...list.filter((x) => !(x.namespace === e.namespace && x.key === e.key)), e];
      entry.row[P.METAFIELDS] = JSON.stringify(list);
      fields += extra.length;
    }
    changes.set(String(master._id), entry);
    out.matched.push({ title: p.title, handle: p.handle, master: master.masterKey, fields });
  }

  if (dryRun) return out;

  // definitions first, so every value below is stored with its type
  out.definitions = await ensureProductMetafieldDefinitions();
  for (const key of out.extraKeys) {
    const res = await gql(
      `#graphql
      mutation RxCreateMfDef($def: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $def) { createdDefinition { id } userErrors { message code } }
      }`,
      { def: { name: key.replace(/_/g, " "), namespace: "custom", key, type: extraType[key], ownerType: "PRODUCT" } },
    );
    const errs = res.metafieldDefinitionCreate?.userErrors || [];
    if (!errs.length) out.definitions.created.push(key);
    else if (!errs.some((e) => e.code === "TAKEN")) out.definitions.failed.push(`${key}: ${errs.map((e) => e.message).join("; ")}`);
  }

  for (const { master, row } of changes.values()) {
    // the base gets the values now; its fingerprint is kept in step so the
    // sync doesn't rewrite it (images included) - only the copies follow
    const sigs = { ...(master.sigs || {}) };
    // the base as it is in the store now (a saved id can be stale)
    const base = await baseTarget(master).find().catch(() => null);
    if (!base) out.baseErrors.push(`${master.masterKey}: no base product (rxbase:${master.masterKey}) in the store - the next product sync creates it`);
    if (base) {
      const ok = await writeMetafields(base.productId, row).catch((err) => {
        out.baseErrors.push(`${master.masterKey}: ${err.message || err}`);
        return false;
      });
      if (!ok && !out.baseErrors.some((e) => e.startsWith(master.masterKey + ":"))) {
        out.baseErrors.push(`${master.masterKey}: Shopify refused a value - see Sync & logs`);
      }
      const tags = baseTarget(master).tags.join(", ");
      if (ok && sigs.base && sigs.base === signature(master.row, tags)) sigs.base = signature(row, tags);
    }
    await MasterProduct.updateOne({ _id: master._id }, { $set: { row, sigs } });
    out.updatedMasters++;
  }
  await kvSet("migration:metafields-csv", JSON.stringify({ at: new Date().toISOString(), products: out.matched.length, masters: out.updatedMasters }));
  logEvent("sync", "metafields-csv", `metafields imported from CSV ${JSON.stringify({ ...out, matched: out.matched.length })}`);
  return out;
}

/** When the one-time CSV import ran ({ at, products, masters }) or null. */
export async function metafieldsCsvImported() {
  const v = await kvGet("migration:metafields-csv");
  try { return v ? JSON.parse(v) : null; } catch { return null; }
}

/* ------------------- Shopify -> app: edits made on a base product ------------------ */

const MASTER_FROM_BASE_SKIP = new Set([P.MASTER_KEY, P.METAFIELDS]);

/* Copies follow a pulled change on the next product sync; several base
   edits in a row (a bulk edit) start ONE sync. */
let copiesSyncTimer = null;
function syncCopiesSoon() {
  clearTimeout(copiesSyncTimer);
  copiesSyncTimer = setTimeout(() => {
    runProductSync()
      .then((r) => logEvent("job", "product-copies", "after a base product edit in Shopify: " + JSON.stringify(r)))
      .catch((err) => logEvent("error", "product-copies", String(err), null, false));
  }, 30_000);
}

/**
 * A base product (rxbase:<key>, no practice_id) was edited in Shopify admin:
 * its master in the app takes the new values - title, description, status,
 * vendor, tags, SKU, prices, images, channels, custom metafields and stock -
 * so the app never shows stale data and the practice copies follow on the
 * next sync. The base itself is marked in step (not rewritten). A change the
 * app made itself comes back identical and is ignored. Returns what changed.
 */
export async function pullMasterFromBase(productId, { pushStock = true } = {}) {
  await connectDb();
  const gidId = String(productId).startsWith("gid://") ? String(productId) : `gid://shopify/Product/${productId}`;
  const loc = await locationId();
  const data = await gql(
    `#graphql
    query RxBaseForMaster($id: ID!, $loc: ID!) {
      product(id: $id) {
        ${STORE_PRODUCT_FIELDS}
        stock: variants(first: 1) { nodes { inventoryItem { inventoryLevel(locationId: $loc) { quantities(names: ["available"]) { quantity } } } } }
      }
    }`,
    { id: gidId, loc },
  );
  const n = data.product;
  if (!n) return { skipped: "product not found" };
  if (tagVal(n.tags, "practice_id:")) return { skipped: "practice copy" };
  const key = tagVal(n.tags, "rxbase:");
  if (!key) return { skipped: "not a base product" };
  const master = await MasterProduct.findOne({ masterKey: key }).lean();
  if (!master) return { skipped: `no master ${key}` };

  const fromBase = rowFromStoreProduct(n, key);
  // stock at the app's stock location, not the all-locations total
  const atLoc = levelQty(n.stock?.nodes?.[0]?.inventoryItem);
  if (atLoc != null) fromBase[P.INVENTORY] = atLoc;
  const row = { ...master.row };
  const changed = [];
  for (const [col, val] of Object.entries(fromBase)) {
    if (MASTER_FROM_BASE_SKIP.has(col)) continue;
    // a reference this store can't resolve comes back blank - keep the master's
    if (val === "" && METAFIELD_REF_COLUMNS.some((d) => d.column === col)) continue;
    if (String(row[col] ?? "") !== String(val ?? "")) {
      changed.push(col);
      row[col] = val;
    }
  }
  if (!changed.length) return { unchanged: key };

  const sigs = { ...(master.sigs || {}) };
  sigs.base = signature(row, baseTarget({ ...master, row }).tags.join(", ")); // the base already looks like this
  await MasterProduct.updateOne(
    { _id: master._id },
    { $set: { row, sigs, ...(master.baseProductId !== n.id ? { baseProductId: n.id } : {}) } },
  );
  logEvent("sync", "product-sync", `${key}: master updated from the base product in Shopify (${changed.join(", ")})`);

  // Stock changed on the base: every copy takes the same number now, so the
  // shared-stock run never reads the gap as a sale.
  if (pushStock && changed.includes(P.INVENTORY) && String(row[P.INVENTORY]).trim() !== "") {
    await withLock("inventory-sync", () => pushMasterStock({ ...master, row }, Number(row[P.INVENTORY])));
  }
  if (changed.some((c) => c !== P.INVENTORY)) syncCopiesSoon();
  return { updated: key, changed };
}

/**
 * inventory_levels/update: stock edited in Shopify. On a base product (at the
 * app's stock location) it becomes the master's Inventory and goes to every
 * copy; a copy's own change is a sale, handled by the shared-stock run.
 */
export async function pullStockFromInventoryLevel(payload) {
  const itemId = payload?.inventory_item_id;
  if (!itemId) return { skipped: "no item" };
  const loc = await locationId();
  if (payload.location_id && `gid://shopify/Location/${payload.location_id}` !== loc) return { skipped: "other location" };
  const data = await gql(
    `#graphql
    query RxItemProduct($id: ID!) { inventoryItem(id: $id) { variant { product { id tags } } } }`,
    { id: `gid://shopify/InventoryItem/${itemId}` },
  );
  const prod = data.inventoryItem?.variant?.product;
  if (!prod || tagVal(prod.tags, "practice_id:") || !tagVal(prod.tags, "rxbase:")) return { skipped: "not a base product" };
  return pullMasterFromBase(prod.id);
}
