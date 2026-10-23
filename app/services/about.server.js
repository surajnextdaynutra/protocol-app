import { connectDb } from "../db.server";
import { AboutPage } from "../models/index.server";
import { normalizePhone, phoneMessage } from "./account-validate.server";
import { gql } from "./shopify-admin.server";

/* About Us page editor (was rx-about-us-page).

   Pages live in the app database (about_pages), one per doctor + clinic +
   practice, addressed by a deterministic handle so a save always updates
   the same page and never creates a duplicate. The theme reads them through
   aboutUsPublic. Pages saved before the move are still in the store's
   `about_us` metaobjects: they are read from there (when that definition
   exists) until the doctor saves once, which copies them into the database. */

const MO_TYPE = "about_us";
const OWNER_TYPE = "about";
// physician_details holds the whole Physician & Clinic block as JSON
const JSON_KEYS = new Set(["physician_details", "what_makes_us_different_feature", "image_gallery_image"]);
const PHYSICIAN_KEYS = ["picture", "picture_original", "clinic_name", "first_name", "last_name", "credentials", "clinic_phone", "about"];
const ABOUT_MAX = 500;

const slug = (s) =>
  String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const aboutHandle = (doctorId, clinicId, practiceId) =>
  `${slug(doctorId)}-${slug(clinicId)}-${slug(practiceId)}`;

/* ---------------------------- rich text + checks ------------------------ */

const RICH_TAGS = new Set(["p", "br", "b", "strong", "i", "em", "u", "s", "strike", "a", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "div", "span"]);
const decodeEntities = (s) =>
  String(s || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
const escAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** http(s) / mailto / tel only - never javascript: or data: */
export function isSafeLink(url) {
  const u = String(url || "").trim();
  return /^https?:\/\/[^\s/.]+\.[^\s]+$/i.test(u) || /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(u) || /^tel:\+?[\d\s().-]{7,}$/i.test(u);
}

function hrefOf(attrs) {
  const m = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs || "");
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : "";
}

/** The About text is shown as HTML on the public page: only the editor's own
 *  formatting tags survive, with no attributes except a safe link href. */
export function sanitizeRichText(html) {
  return String(html || "")
    .replace(/<(script|style|iframe|object|embed|template|svg|math)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (m, tag, attrs) => {
      const t = tag.toLowerCase();
      if (!RICH_TAGS.has(t)) return "";
      if (m.startsWith("</")) return `</${t}>`;
      if (t === "a") {
        const href = hrefOf(attrs);
        return isSafeLink(href) ? `<a href="${escAttr(href)}" target="_blank" rel="noopener">` : "<a>";
      }
      return t === "br" ? "<br>" : `<${t}>`;
    })
    .replace(/<(?![a-zA-Z/!])/g, "&lt;");
}

export const richTextLength = (html) => decodeEntities(String(html || "").replace(/<[^>]*>/g, "")).length;

/** Physician & Clinic block checks, keyed by the editor's state path. */
export function validatePhysician(p) {
  const errs = {};
  const v = (k) => String(p[k] ?? "").trim();
  if (v("clinic_name").length > 100) errs["physician.clinic_name"] = "Clinic's name must be 100 characters or fewer.";
  const cred = v("credentials");
  if (cred.length > 60) errs["physician.credentials"] = "Initials / Credentials must be 60 characters or fewer.";
  else if (cred && !/^[\p{L}\p{M}0-9][\p{L}\p{M}0-9 .,&()/'-]*$/u.test(cred)) {
    errs["physician.credentials"] = "Initials / Credentials can only contain letters, digits, spaces and , . & ( ) / ' -";
  }
  const phone = v("clinic_phone");
  if (phone && normalizePhone(phone) === null) errs["physician.clinic_phone"] = phoneMessage(phone);
  const pic = v("picture");
  if (pic && (pic.length > 1000 || !/^https:\/\/\S+$/i.test(pic))) {
    errs["physician.picture"] = "Picture must be an https:// image link - or use Upload.";
  }
  const about = String(p.about ?? "");
  const aboutLen = richTextLength(about);
  if (aboutLen > ABOUT_MAX) {
    errs["physician.about"] = `About must be ${ABOUT_MAX} characters or fewer (it has ${aboutLen}).`;
  } else {
    const bad = [...about.matchAll(/<a\b([^>]*)>/gi)].map((m) => hrefOf(m[1])).find((h) => !isSafeLink(h));
    if (bad !== undefined) {
      errs["physician.about"] = `The link "${bad || "(empty)"}" is not valid - use a full https:// web address, mailto: or tel: link.`;
    }
  }
  return errs;
}

/* -------------------------------- storage ------------------------------- */

function parseJsonField(v) {
  if (v && typeof v === "object") return v;
  try { return JSON.parse(String(v || "")); } catch { return null; }
}

/** The pre-database metaobject entry, or null (also when the store has no
 *  about_us definition at all). Values come back as Shopify's strings. */
async function legacyMetaobject(handle) {
  try {
    const data = await gql(
      `#graphql
      query RxAboutLoad($handle: MetaobjectHandleInput!) {
        metaobjectByHandle(handle: $handle) { fields { key value } }
      }`,
      { handle: { type: MO_TYPE, handle } },
    );
    const mo = data.metaobjectByHandle;
    if (!mo) return null;
    const fields = {};
    for (const f of mo.fields || []) fields[f.key] = f.value;
    return fields;
  } catch {
    return null;
  }
}

/** The editor's view: every key as a string, JSON keys serialised. */
function toEditorFields(data) {
  const out = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (k.startsWith("_")) continue;
    out[k] = JSON_KEYS.has(k) && v && typeof v === "object" ? JSON.stringify(v) : String(v ?? "");
  }
  return out;
}

export async function loadAbout({ doctor_id, clinic_id, practice_id }) {
  if (!doctor_id || !clinic_id || !practice_id) {
    return { error: "doctor_id, clinic_id and practice_id are required" };
  }
  await connectDb();
  const handle = aboutHandle(doctor_id, clinic_id, practice_id);
  const doc = await AboutPage.findOne({ ownerType: OWNER_TYPE, ownerId: handle }).lean();
  if (doc) return { found: true, handle, fields: toEditorFields(doc.data) };
  const legacy = await legacyMetaobject(handle);
  if (legacy) return { found: true, handle, fields: legacy, legacy: true };
  return { found: false, handle };
}

/** `incoming` is the editor's [{key, value}] list. */
export async function saveAbout(incoming, updatedBy = "") {
  const data = {};
  for (const f of Array.isArray(incoming) ? incoming : []) {
    if (!f || !/^[a-z0-9_]{1,64}$/.test(String(f.key || ""))) continue;
    const value = String(f.value == null ? "" : f.value);
    if (value.length > 20000) return { error: `${f.key} is too long.` };
    if (JSON_KEYS.has(f.key)) {
      const parsed = value ? parseJsonField(value) : null;
      if (value && (parsed === null || typeof parsed !== "object")) return { error: `${f.key} is not valid JSON.` };
      data[f.key] = parsed;
    } else {
      data[f.key] = value.trim();
    }
  }
  if (!data.doctor_id || !data.clinic_id || !data.practice_id) {
    return { error: "doctor_id, clinic_id and practice_id are required" };
  }

  if (data.physician_details) {
    const p = {};
    for (const k of PHYSICIAN_KEYS) p[k] = String(data.physician_details[k] ?? "").trim();
    p.about = sanitizeRichText(data.physician_details.about);
    const fieldErrors = validatePhysician(p);
    if (Object.keys(fieldErrors).length) {
      return { error: "Please fix the highlighted fields.", fieldErrors };
    }
    data.physician_details = p;
  }

  await connectDb();
  const handle = aboutHandle(data.doctor_id, data.clinic_id, data.practice_id);
  data._doctorKey = String(data.doctor_id).trim().toLowerCase();
  const before = await AboutPage.findOneAndUpdate(
    { ownerType: OWNER_TYPE, ownerId: handle },
    { $set: { data, updatedBy: String(updatedBy || "") } },
    { upsert: true, new: false },
  ).lean();
  return { ok: true, created: !before, handle };
}

const norm = (v) => String(v == null ? "" : v).trim().toLowerCase();

/** Public About page / header data for one doctor - only the Physician &
 *  Clinic block, which the storefront shows anyway. Clinic and practice
 *  narrow the match when the visitor's session has them. */
export async function publicAbout({ doctor_id, clinic_id, practice_id }) {
  if (!doctor_id) return { ok: true, found: false };
  await connectDb();
  const docs = await AboutPage.find({ ownerType: OWNER_TYPE, "data._doctorKey": norm(doctor_id) })
    .sort({ updatedAt: -1 })
    .limit(20)
    .lean();
  let match = docs.find(
    (d) => (!clinic_id || norm(d.data?.clinic_id) === norm(clinic_id)) && (!practice_id || norm(d.data?.practice_id) === norm(practice_id)),
  )?.data;
  if (!match && clinic_id && practice_id) {
    const legacy = await legacyMetaobject(aboutHandle(doctor_id, clinic_id, practice_id));
    if (legacy) match = { ...legacy, physician_details: parseJsonField(legacy.physician_details) };
  }
  const p = match && match.physician_details && typeof match.physician_details === "object" ? match.physician_details : null;
  if (!p) return { ok: true, found: false };
  const physician = {};
  for (const k of PHYSICIAN_KEYS) if (k !== "picture_original") physician[k] = String(p[k] ?? "");
  physician.about = sanitizeRichText(physician.about);
  return {
    ok: true,
    found: true,
    doctor_id: match.doctor_id,
    clinic_id: match.clinic_id,
    practice_id: match.practice_id,
    physician,
  };
}

/* ------------------------------ image upload ---------------------------- */

const FILE_URL = `#graphql
  fragment RxFileUrl on File {
    fileStatus
    ... on MediaImage { image { url } }
    ... on GenericFile { url }
  }`;

/** A file already in Shopify Files under this name is reused, not re-uploaded. */
async function findExistingFileUrl(baseName, fullName) {
  if (!baseName) return "";
  const data = await gql(
    `#graphql
    ${FILE_URL}
    query RxFilesByName($q: String!) {
      files(first: 10, query: $q, sortKey: CREATED_AT, reverse: true) { nodes { ...RxFileUrl } }
    }`,
    { q: "filename:" + JSON.stringify(baseName) },
  );
  for (const n of data.files?.nodes || []) {
    const url = n.image?.url || n.url || "";
    if (!url) continue;
    const urlFile = decodeURIComponent(url.split("?")[0].split("/").pop() || "").toLowerCase();
    if (urlFile === fullName.toLowerCase() || urlFile.startsWith(baseName.toLowerCase())) return url;
  }
  return "";
}

async function pollForImageUrl(fileGid) {
  for (let i = 0; i < 15; i++) {
    const data = await gql(
      `#graphql
      ${FILE_URL}
      query RxFileReady($id: ID!) { node(id: $id) { ...RxFileUrl } }`,
      { id: fileGid },
    );
    const node = data.node;
    if (node) {
      const url = node.image?.url || node.url;
      if (url) return url;
      if (node.fileStatus === "FAILED") return "";
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  return "";
}

/**
 * Uploads one image (base64) to Shopify Files and returns its CDN URL:
 * staged upload target -> upload the bytes -> fileCreate -> wait for the URL.
 */
export async function uploadAboutImage({ filename, mimeType, data: base64 }) {
  filename = String(filename || "image.jpg");
  mimeType = String(mimeType || "image/jpeg");
  if (!base64) return { error: "No image data received" };
  if (!/^image\//i.test(mimeType)) return { error: "Only image files can be uploaded" };

  const baseName = filename.replace(/\.[^.]+$/, "");
  const existingUrl = await findExistingFileUrl(baseName, filename);
  if (existingUrl) return { ok: true, url: existingUrl, reused: true };

  const staged = await gql(
    `#graphql
    mutation RxStagedUpload($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }`,
    { input: [{ resource: "IMAGE", filename, mimeType, httpMethod: "POST" }] },
  );
  const target = staged.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target) {
    return { error: staged.stagedUploadsCreate?.userErrors?.[0]?.message || "stagedUploadsCreate failed" };
  }

  const form = new FormData();
  for (const par of target.parameters || []) form.append(par.name, par.value);
  form.append("file", new Blob([Buffer.from(String(base64), "base64")], { type: mimeType }), filename);
  const uploadRes = await fetch(target.url, { method: "POST", body: form });
  if (uploadRes.status >= 300) return { error: `Staged upload failed (${uploadRes.status})` };

  const created = await gql(
    `#graphql
    mutation RxFileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files { id fileStatus }
        userErrors { field message }
      }
    }`,
    { files: [{ originalSource: target.resourceUrl, contentType: "IMAGE", filename }] },
  );
  const file = created.fileCreate?.files?.[0];
  if (!file) return { error: created.fileCreate?.userErrors?.[0]?.message || "fileCreate failed" };

  const url = await pollForImageUrl(file.id);
  if (!url) return { error: "File processed but URL not ready yet - try again in a moment" };
  return { ok: true, url, reused: false };
}
