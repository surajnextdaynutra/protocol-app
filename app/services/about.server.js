import { kvGet, kvSet } from "./log.server";
import { gql } from "./shopify-admin.server";

/* About Us page editor (was rx-about-us-page).

   The page content stays in the store's `about_us` metaobject because the
   theme renders the public About page straight from it. One entry per
   doctor + clinic + practice, addressed by a deterministic handle so a save
   always updates the same entry and never creates a duplicate. */

const MO_TYPE = "about_us";

const slug = (s) =>
  String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const aboutHandle = (doctorId, clinicId, practiceId) =>
  `${slug(doctorId)}-${slug(clinicId)}-${slug(practiceId)}`;

/** Field keys the metaobject definition actually has. Shopify rejects a save
 *  that carries any other key, so incoming fields are filtered to these. */
async function definedKeys() {
  const cached = await kvGet("about:keys");
  if (cached) return cached;
  const data = await gql(
    `#graphql
    query RxAboutDefinition($type: String!) {
      metaobjectDefinitionByType(type: $type) { fieldDefinitions { key } }
    }`,
    { type: MO_TYPE },
  );
  const keys = (data.metaobjectDefinitionByType?.fieldDefinitions || []).map((f) => f.key);
  if (keys.length) await kvSet("about:keys", keys, 600);
  return keys;
}

export async function loadAbout({ doctor_id, clinic_id, practice_id }) {
  if (!doctor_id || !clinic_id || !practice_id) {
    return { error: "doctor_id, clinic_id and practice_id are required" };
  }
  const handle = aboutHandle(doctor_id, clinic_id, practice_id);
  const data = await gql(
    `#graphql
    query RxAboutLoad($handle: MetaobjectHandleInput!) {
      metaobjectByHandle(handle: $handle) { id handle fields { key value } }
    }`,
    { handle: { type: MO_TYPE, handle } },
  );
  const mo = data.metaobjectByHandle;
  if (!mo) return { found: false, handle };
  const fields = {};
  for (const f of mo.fields || []) fields[f.key] = f.value;
  return { found: true, handle: mo.handle, fields };
}

/** `incoming` is the editor's [{key, value}] list. */
export async function saveAbout(incoming) {
  const allowed = new Set(await definedKeys());
  const fields = [];
  const byKey = {};
  for (const f of Array.isArray(incoming) ? incoming : []) {
    if (!f || (allowed.size && !allowed.has(f.key))) continue;
    const value = String(f.value == null ? "" : f.value);
    fields.push({ key: f.key, value });
    byKey[f.key] = value;
  }
  if (!byKey.doctor_id || !byKey.clinic_id || !byKey.practice_id) {
    return { error: "doctor_id, clinic_id and practice_id are required" };
  }
  const handle = aboutHandle(byKey.doctor_id, byKey.clinic_id, byKey.practice_id);
  const existing = await gql(
    `#graphql
    query RxAboutExists($handle: MetaobjectHandleInput!) { metaobjectByHandle(handle: $handle) { id } }`,
    { handle: { type: MO_TYPE, handle } },
  );
  const data = await gql(
    `#graphql
    mutation RxAboutSave($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
      metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
        metaobject { id handle }
        userErrors { field message }
      }
    }`,
    {
      handle: { type: MO_TYPE, handle },
      metaobject: { fields, capabilities: { publishable: { status: "ACTIVE" } } },
    },
  );
  const errs = data.metaobjectUpsert?.userErrors || [];
  if (errs.length) return { error: errs[0].message || "Metaobject save failed" };
  return {
    ok: true,
    created: !existing.metaobjectByHandle,
    handle: data.metaobjectUpsert.metaobject.handle,
    id: data.metaobjectUpsert.metaobject.id,
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
