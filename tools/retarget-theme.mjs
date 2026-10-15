#!/usr/bin/env node
/* Points an exported theme at the Rx Portal app instead of Google Apps Script.

     node tools/retarget-theme.mjs <theme_export dir> [<output dir>]
     node tools/retarget-theme.mjs <theme_export dir> --in-place

   Without --in-place nothing in the input folder is modified: every file
   that needs a change is written to the output folder (default:
   <input>_patched) with the same relative path, ready to upload to the
   theme. With --in-place the theme folder itself is edited. Running it again
   changes nothing. What it does:

     1. Replaces every hard-coded script.google.com/…/exec URL with the
        matching /apps/rx/<endpoint> path.
     2. Sets the "Apps Script URL" settings of the portal sections in the
        JSON templates to their /apps/rx/<endpoint> path, and blanks the
        shared-secret settings (the app does not use one - Shopify signs each
        request instead).
     3. Sets the theme-level rx_physician_url setting.
     4. Hard-codes the endpoint where a section or snippet READS one of those
        URL settings, so the page works whatever is typed in the theme
        editor (and on a theme whose settings still hold a Google URL).

   The last lines of output list anything it could not map, to fix by hand. */

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const inPlace = args.includes("--in-place");
const [inDirArg, outDirArg] = args.filter((a) => !a.startsWith("--"));
if (!inDirArg) {
  console.error("usage: node tools/retarget-theme.mjs <theme_export dir> [<output dir> | --in-place]");
  process.exit(1);
}
const inDir = path.resolve(inDirArg);
const outDir = inPlace ? inDir : path.resolve(outDirArg || inDir.replace(/[\\/]+$/, "") + "_patched");
const PROXY = "/apps/rx";

/* Which Apps Script deployment was which. Keyed by the first characters of
   the deployment id found in the theme. */
const DEPLOYMENTS = {
  AKfycbwN0UkS: "physicians", // Rx Physician list
  AKfycby9UOkJ: "physicians", // older physician list deployment
  AKfycbxOnSTl: "form", // referral + contact form
  AKfycbzyrgEh: "account", // Account Settings API
  AKfycbzIStlf: "pricing", // Product Price Management
  AKfycbysy14A: "about", // rx-about-us-page
  AKfycbyuml4R: "practice", // 3-rx-practice (practice directory)
  AKfycbw0PwkJ: "rep", // 5-rx-rep
  "AKfycby9-88A": "finance", // 7-rx-finance-admin
  AKfycbyPMpuM: "support", // contact-support-form
  AKfycbyobR48: "cart", // 2-rx-cart
  AKfycbwjfUoQ: "clinic", // 6-rx-clinic
  AKfycbztgpLx: "builder", // 1-rx-builder
  AKfycbzPJfgB: "physician", // 4-rx-physician
  AKfycbyEboqZ: "banking", // Rx Banking Details Form
};

/* Section type -> { setting id: endpoint }. A setting whose id contains
   "secret" or "token" is blanked for these sections. */
const SECTION_SETTINGS = {
  "rx-practice-dashboard": { apps_script_url: "practice" },
  "rx-physician-dashboard": {
    apps_script_url: "physician",
    solo_check_url: "physician",
    practice_directory_url: "practice",
    banking_apps_script_url: "banking",
    patient_search_url: "builder",
    contact_apps_script_url: "support",
  },
  "rx-clinic-dashboard": { apps_script_url: "clinic", practice_apps_script_url: "practice" },
  "rx-rep-dashboard": { apps_script_url: "rep" },
  "rx-finance-dashboard": { apps_script_url: "finance" },
  "rx-New-prescription-builder": {
    apps_script_url: "builder",
    solo_check_url: "physician",
    practice_directory_url: "practice",
  },
  "rx-prescription-builder": { apps_script_url: "builder" },
  "rx-prescription-cart": { apps_script_url: "cart" },
  "contact-support-form": { apps_script_url: "support" },
  "contact-protocol": { apps_script_url: "support" },
};
const THEME_SETTINGS = { rx_physician_url: "physician" };

/* Liquid settings that hold a backend URL, wherever they are read. The
   section's own "apps_script_url" depends on which section it is - see
   SECTION_SETTINGS; these are the same in every file. */
const URL_SETTINGS = {
  "section.settings.practice_directory_url": "practice",
  "section.settings.practice_apps_script_url": "practice",
  "section.settings.solo_check_url": "physician",
  "section.settings.patient_search_url": "builder",
  "section.settings.banking_apps_script_url": "banking",
  "section.settings.contact_apps_script_url": "support",
  "settings.rx_physician_url": "physician",
};

const report = { files: [], urls: 0, settings: 0, secrets: 0, hardcoded: 0, unknown: new Set(), notes: [] };

/** Replaces each read of a URL setting with the endpoint as a Liquid string,
 *  e.g. {{ section.settings.apps_script_url | strip | json }}
 *    -> {{ '/apps/rx/practice' | strip | json }}
 *  The {% schema %} block is left alone, so the setting still exists in the
 *  theme editor (it just no longer decides anything). */
function hardcodeEndpoints(text, rel) {
  const schemaAt = text.search(/\{%-?\s*schema\s*-?%\}/);
  let body = schemaAt < 0 ? text : text.slice(0, schemaAt);
  const schema = schemaAt < 0 ? "" : text.slice(schemaAt);
  const swap = (token, endpoint) => {
    const re = new RegExp("(?<![\\w.])" + token.replace(/\./g, "\\.") + "(?![\\w])", "g");
    body = body.replace(re, () => {
      report.hardcoded++;
      return "'" + PROXY + "/" + endpoint + "'";
    });
  };
  const type = (/^sections\/(.+)\.liquid$/.exec(rel) || [])[1];
  // "ontact-support-form" is a second copy of the contact form section
  const own = SECTION_SETTINGS[type] || (type === "ontact-support-form" ? SECTION_SETTINGS["contact-support-form"] : null);
  if (own && own.apps_script_url) swap("section.settings.apps_script_url", own.apps_script_url);
  for (const [token, endpoint] of Object.entries(URL_SETTINGS)) swap(token, endpoint);
  return body + schema;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Hard-coded exec URLs (plain, or with JSON-escaped slashes). */
function replaceUrls(text, rel) {
  return text.replace(
    /https:(\\?\/)\\?\/script\.google\.com\\?\/macros\\?\/s\\?\/([A-Za-z0-9_-]+)\\?\/exec/g,
    (whole, slash, id) => {
      const key = Object.keys(DEPLOYMENTS).find((k) => id.startsWith(k));
      if (!key) {
        report.unknown.add(`${rel}: …/s/${id.slice(0, 14)}…/exec`);
        return whole;
      }
      report.urls++;
      const p = `${PROXY}/${DEPLOYMENTS[key]}`;
      return slash === "\\/" ? p.replace(/\//g, "\\/") : p;
    },
  );
}

/** Shopify prefixes JSON templates with a comment block - keep it. */
function splitJson(text) {
  const m = text.match(/^\s*\/\*[\s\S]*?\*\/\s*/);
  return m ? { head: m[0], body: text.slice(m[0].length) } : { head: "", body: text };
}

function patchTemplate(text, rel) {
  const { head, body } = splitJson(text);
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    return text; // not plain JSON - leave to the URL pass
  }
  let changed = false;
  for (const section of Object.values(json.sections || {})) {
    const map = SECTION_SETTINGS[section.type];
    if (!map) continue;
    section.settings ||= {};
    for (const [id, endpoint] of Object.entries(map)) {
      const want = `${PROXY}/${endpoint}`;
      if (section.settings[id] !== want) {
        section.settings[id] = want;
        report.settings++;
        changed = true;
      }
    }
    for (const id of Object.keys(section.settings)) {
      if (/secret|token/i.test(id) && section.settings[id]) {
        section.settings[id] = "";
        report.secrets++;
        changed = true;
      }
    }
  }
  return changed ? head + JSON.stringify(json, null, 2) + "\n" : text;
}

function patchSettingsData(text) {
  const { head, body } = splitJson(text);
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    return text;
  }
  const current = typeof json.current === "object" ? json.current : null;
  if (!current) {
    report.notes.push("config/settings_data.json: 'current' is a preset name - set rx_physician_url in the theme editor.");
    return text;
  }
  let changed = false;
  for (const [id, endpoint] of Object.entries(THEME_SETTINGS)) {
    const want = `${PROXY}/${endpoint}`;
    if (current[id] !== want) {
      current[id] = want;
      report.settings++;
      changed = true;
    }
  }
  return changed ? head + JSON.stringify(json, null, 2) + "\n" : text;
}

for (const file of walk(inDir)) {
  const rel = path.relative(inDir, file).replace(/\\/g, "/");
  if (!/\.(liquid|json|js)$/.test(rel)) continue;
  const before = fs.readFileSync(file, "utf8");
  let after = replaceUrls(before, rel);
  if (rel.endsWith(".liquid")) after = hardcodeEndpoints(after, rel);
  if (rel.startsWith("templates/") && rel.endsWith(".json")) after = patchTemplate(after, rel);
  if (rel === "config/settings_data.json") after = patchSettingsData(after);
  if (after === before) continue;
  const dest = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, after);
  report.files.push(rel);
}

// Anything still pointing at Google, or a secret still printed in a page.
const leftovers = [];
for (const rel of report.files) {
  const text = fs.readFileSync(path.join(outDir, rel), "utf8");
  if (/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}/.test(text)) leftovers.push(rel);
}
const hardcodedSecrets = [];
for (const file of walk(inDir)) {
  const rel = path.relative(inDir, file).replace(/\\/g, "/");
  if (!rel.endsWith(".liquid")) continue;
  const text = fs.readFileSync(file, "utf8");
  if (/(SECRET|secret)\w*\s*[=:]\s*['"][A-Za-z0-9]{24,}['"]/.test(text)) hardcodedSecrets.push(rel);
}

console.log(`Theme: ${inDir}`);
console.log(inPlace ? "Edited in place.\n" : `Patched files written to: ${outDir}\n`);
console.log(`  files changed ............ ${report.files.length}`);
console.log(`  hard-coded URLs replaced . ${report.urls}`);
console.log(`  setting reads hard-coded . ${report.hardcoded}`);
console.log(`  section/theme settings ... ${report.settings}`);
console.log(`  secrets blanked .......... ${report.secrets}\n`);
for (const f of report.files) console.log("  ~ " + f);
if (report.unknown.size) {
  console.log("\nApps Script URLs with no known mapping (edit DEPLOYMENTS in this tool, or fix by hand):");
  for (const u of report.unknown) console.log("  ! " + u);
}
if (leftovers.length) {
  console.log("\nStill referencing script.google.com after patching:");
  for (const f of leftovers) console.log("  ! " + f);
}
if (hardcodedSecrets.length) {
  console.log("\nFiles with an old shared secret typed into the code (harmless once the Google scripts are");
  console.log("switched off - the app ignores it - but worth deleting from the file):");
  for (const f of hardcodedSecrets) console.log("  - " + f);
}
for (const n of report.notes) console.log("\nNote: " + n);

// Sales reps open the shared demo Practice / Clinic / Physician; the app only
// lets them when it knows those ids are demo ids.
try {
  const { body } = splitJson(fs.readFileSync(path.join(outDir, "config/settings_data.json"), "utf8"));
  const cur = JSON.parse(body).current || {};
  const ids = [cur.rx_demo_practice_id, cur.rx_demo_clinic_id, cur.rx_demo_doctor_id].filter(Boolean);
  if (ids.length) {
    console.log("\nDemo accounts: in the app, Settings -> Demo accounts -> DEMO_IDS must contain");
    console.log("  " + ids.join(","));
  }
} catch {
  // no settings_data.json in this export
}
