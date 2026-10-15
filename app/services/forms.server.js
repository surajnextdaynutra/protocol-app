import { connectDb } from "../db.server";
import { FormEntry } from "../models/index.server";
import { logEvent } from "./log.server";
import { getSettings, isTrue } from "./settings.server";
import { READ_ONLY } from "./shopify-admin.server";

/* Website forms (were the "form" and "contact-support-form" scripts).

   referral - the New Client / Sales Referral form on the rep dashboard:
              saved, emailed to the sales team + the rep, and pushed to Brevo
              as a contact and a deal.
   contact  - the public contact / support form: saved and emailed.

   Every submission is stored in `form_entries` first, so a lead is never
   lost to an email hiccup. */

const fieldsToObject = (fieldsArr) => {
  const data = {};
  for (const f of fieldsArr || []) if (f && f.key != null) data[f.key] = f.value;
  return data;
};

/** One plain-text email through Brevo. Returns true on success. */
async function sendPlainEmail(toEmail, toName, subject, textBody, replyToEmail) {
  const cfg = await getSettings();
  if (READ_ONLY || isTrue(cfg.EMAIL_DISABLED) || !cfg.BREVO_API_KEY) return false;
  const payload = {
    sender: {
      email: cfg.BREVO_SENDER_EMAIL || cfg.SALES_EMAIL,
      name: cfg.BREVO_SENDER_NAME || "Protocol Therapeutics",
    },
    to: [{ email: toEmail, name: toName || toEmail }],
    subject,
    textContent: textBody,
  };
  if (replyToEmail) payload.replyTo = { email: replyToEmail };
  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": cfg.BREVO_API_KEY, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) return true;
    logEvent("error", toEmail, `form email: Brevo HTTP ${res.status} ${(await res.text()).slice(0, 200)}`, null, false);
    return false;
  } catch (err) {
    logEvent("error", toEmail, "form email: " + err, null, false);
    return false;
  }
}

/* ------------------------------- contact -------------------------------- */

export async function saveContact(fieldsArr, { customerId = "", to } = {}) {
  await connectDb();
  const data = fieldsToObject(fieldsArr);
  const cfg = await getSettings();
  await FormEntry.create({
    form: "contact",
    data,
    customerId,
    email: String(data.email || "").toLowerCase(),
  });

  const who = data.name || data.email || "Website visitor";
  const lines = [
    "New contact form submission from the Protocol Therapeutics website.",
    "",
    "Name: " + (data.name || "-"),
    "Email: " + (data.email || "-"),
    "Phone: " + (data.phone || "-"),
    "",
    "Comment:",
    data.message || "-",
  ];
  if (data.source) lines.push("", "Source: " + data.source);
  if (data.pageUrl) lines.push("", "Submitted from: " + data.pageUrl);
  const replyTo = data.email && String(data.email).includes("@") ? String(data.email) : "";
  const sent = await sendPlainEmail(
    to || cfg.CONTACT_EMAIL,
    "Protocol Therapeutics Support",
    "Website Contact: " + who,
    lines.join("\n"),
    replyTo,
  );
  return { success: true, created: true, delivery: sent ? "brevo" : "saved" };
}

/* ------------------------------- referral ------------------------------- */

const REFERRAL_FIELDS = [
  "practiceName", "clinicLocation", "numClinics", "numPhysicians",
  "contactFirstName", "contactLastName", "contactEmail", "state", "notes",
  "locations", "productBranding", "numPrivateLabelProducts", "privateLabelSoftware",
  "labelFinish", "commissionPayout",
  "quotePlan", "quotePlatformSetupFee", "quoteLabelDesignTotal",
  "quoteMonthlySoftwareFee", "quoteTotalDueAtSetup", "quoteOngoingMonthly",
  "selectedProducts", "labelQuantities", "numLabelsTotal",
  "labelPrintingSubtotal", "metallicPlatingFees", "upfrontLabelCosts",
  "quoteSummary",
  "repName", "repEmail",
];

const prettyKey = (k) =>
  String(k)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());

/** Any field the form sent that the summary above did not already show. */
function otherFieldsBlock(data) {
  const keys = Object.keys(data).filter((k) => !REFERRAL_FIELDS.includes(k)).sort();
  if (!keys.length) return "";
  const lines = ["", "--- OTHER FIELDS ---"];
  for (const k of keys) {
    const v = data[k];
    lines.push(`${prettyKey(k)}: ${v === undefined || v === null || v === "" ? "-" : String(v)}`);
  }
  return lines.join("\n");
}

function referralSummary(data) {
  const contactName = [data.contactFirstName, data.contactLastName].filter(Boolean).join(" ");
  const lines = [
    "Practice/Physician Name: " + (data.practiceName || "-"),
    "Clinic Location: " + (data.clinicLocation || "-"),
    "Number of Physicians: " + (data.numPhysicians || "-"),
    "Contact Name: " + (contactName || "-"),
    "Contact Email: " + (data.contactEmail || "-"),
    "State: " + (data.state || "-"),
    "Notes: " + (data.notes || "-"),
  ];
  if (data.quoteSummary) {
    if (data.privateLabelSoftware) lines.push("", "Private-label software: " + data.privateLabelSoftware);
  } else if (data.locations || data.productBranding) {
    lines.push("", "--- INTAKE ---");
    lines.push("Locations: " + (data.locations || "-"));
    lines.push("Product branding: " + (data.productBranding || "-"));
    if (data.productBranding === "private") {
      lines.push("Products to private label: " + (data.numPrivateLabelProducts || "-"));
      lines.push("Private-label software: " + (data.privateLabelSoftware || "-"));
    }
  }
  if (data.quoteSummary) lines.push("", "--- QUOTE ---", data.quoteSummary);
  if (data.labelQuantities || data.upfrontLabelCosts) {
    lines.push("", "--- LABEL COSTS ---");
    if (data.labelFinish) lines.push("Label finish: " + data.labelFinish);
    if (data.labelQuantities) lines.push("Per-product labels: " + data.labelQuantities);
    if (data.numLabelsTotal) lines.push("Total labels: " + data.numLabelsTotal);
    if (data.labelPrintingSubtotal) lines.push("Label printing subtotal: " + data.labelPrintingSubtotal);
    if (data.metallicPlatingFees) lines.push("Metallic plating fees: " + data.metallicPlatingFees);
    if (data.upfrontLabelCosts) lines.push("Upfront label costs: " + data.upfrontLabelCosts);
    if (data.commissionPayout) lines.push("Sales commissions paid to: " + data.commissionPayout);
  }
  return lines.join("\n") + otherFieldsBlock(data);
}

export async function saveReferral(fieldsArr, repName, repEmail, { customerId = "" } = {}) {
  await connectDb();
  const data = fieldsToObject(fieldsArr);
  data.repName = repName || "";
  data.repEmail = repEmail || "";
  const cfg = await getSettings();
  const entry = await FormEntry.create({
    form: "referral",
    data,
    customerId,
    email: String(data.contactEmail || "").toLowerCase(),
  });

  const practiceName = data.practiceName || "New referral";
  const summary = referralSummary(data);
  const subjectSuffix = data.quotePlan ? " - " + data.quotePlan : "";
  const submittedBy = `Submitted by: ${repName || "Unknown rep"}${repEmail ? ` (${repEmail})` : ""}`;

  // Notifications and CRM run after the reply - the rep is not kept waiting.
  Promise.resolve()
    .then(async () => {
      await sendPlainEmail(
        cfg.SALES_EMAIL,
        "Sales",
        `Protocol Therapeutics: New Client ${practiceName}${subjectSuffix}`,
        `${summary}\n\n${submittedBy}`,
        repEmail || "",
      );
      if (repEmail) {
        await sendPlainEmail(
          repEmail,
          repName || "",
          `Referral received - ${practiceName}${subjectSuffix}`,
          `Hi ${repName || "there"},\n\nWe received your referral for ${practiceName}. Our sales team has been notified and will follow up.\n\nSummary:\n${summary}\n\nThanks for the referral!`,
        );
      }
      const contactId = await createBrevoContact(data, cfg);
      await createBrevoDeal(data, `${submittedBy}\n\n${summary}`, contactId, cfg);
      await FormEntry.updateOne({ _id: entry._id }, { $set: { status: "Notified" } });
    })
    .catch((err) => logEvent("error", "referral", String(err), null, false));

  return { success: true, created: true };
}

/* ------------------------------ Brevo CRM ------------------------------- */

// form field -> Brevo contact attribute
const CONTACT_ATTRIBUTES = {
  practiceName: "PRACTICE_NAME",
  clinicLocation: "CLINIC_LOCATION",
  numClinics: "NUM_CLINICS",
  numPhysicians: "NUM_PHYSICIANS",
  state: "STATE",
  notes: "NOTES",
  repName: "REP_NAME",
  repEmail: "REP_EMAIL",
  locations: "LOCATIONS",
  productBranding: "PRODUCT_BRANDING",
  numPrivateLabelProducts: "NUM_PRIVATE_LABEL_PRODUCTS",
  privateLabelSoftware: "PRIVATE_LABEL_SOFTWARE",
  quotePlan: "QUOTE_PLAN",
  quotePlatformSetupFee: "QUOTE_PLATFORM_SETUP_FEE",
  quoteLabelDesignTotal: "QUOTE_LABEL_DESIGN_TOTAL",
  quoteMonthlySoftwareFee: "QUOTE_MONTHLY_SOFTWARE_FEE",
  quoteTotalDueAtSetup: "QUOTE_TOTAL_DUE_AT_SETUP",
  quoteOngoingMonthly: "QUOTE_ONGOING_MONTHLY",
  quoteSummary: "QUOTE_SUMMARY",
  labelFinish: "LABEL_FINISH",
  selectedProducts: "SELECTED_PRODUCTS",
  labelQuantities: "LABEL_QUANTITIES",
  numLabelsTotal: "NUM_LABELS_TOTAL",
  labelPrintingSubtotal: "LABEL_PRINTING_SUBTOTAL",
  metallicPlatingFees: "METALLIC_PLATING_FEES",
  upfrontLabelCosts: "UPFRONT_LABEL_COSTS",
  commissionPayout: "COMMISSION_PAYOUT",
};
const NUMERIC_DEAL_FIELDS = new Set(["numClinics", "numPhysicians"]);

async function brevo(cfg, method, path, body) {
  const res = await fetch("https://api.brevo.com/v3" + path, {
    method,
    headers: { "api-key": cfg.BREVO_API_KEY, accept: "application/json", "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, ok: res.ok, json, text };
}

/** Creates (or updates) the practice's contact in Brevo; returns its id. */
async function createBrevoContact(data, cfg) {
  if (READ_ONLY || !cfg.BREVO_API_KEY) return null;
  const email = String(data.contactEmail || "").trim();
  if (!email) return null;

  const base = {};
  if (data.contactFirstName) base.FIRSTNAME = data.contactFirstName;
  if (data.contactLastName) base.LASTNAME = data.contactLastName;
  const extra = {};
  for (const [field, name] of Object.entries(CONTACT_ATTRIBUTES)) {
    const v = data[field];
    if (v !== undefined && v !== null && v !== "") extra[name] = String(v);
  }
  const payload = { email, attributes: { ...base, ...extra }, updateEnabled: true };

  const listName = String(cfg.BREVO_CONTACTS_LIST_NAME || "").trim();
  if (listName) {
    const lists = await brevo(cfg, "GET", "/contacts/lists?limit=50&sort=desc");
    const list = (lists.json?.lists || []).find((l) => String(l.name || "").trim() === listName);
    if (list) payload.listIds = [list.id];
  }

  let res = await brevo(cfg, "POST", "/contacts", payload);
  if (res.status !== 201 && res.status !== 204 && Object.keys(extra).length) {
    // an attribute that does not exist in Brevo fails the whole call - retry bare
    payload.attributes = base;
    res = await brevo(cfg, "POST", "/contacts", payload);
  }
  if (res.status === 201) return res.json?.id || null;
  if (res.status === 204) {
    const got = await brevo(cfg, "GET", "/contacts/" + encodeURIComponent(email));
    return got.ok ? got.json?.id || null : null;
  }
  logEvent("error", email, `Brevo contact: HTTP ${res.status} ${res.text.slice(0, 200)}`, null, false);
  return null;
}

/** Creates the deal in the onboarding pipeline, with the summary as a note. */
async function createBrevoDeal(data, noteText, contactId, cfg) {
  if (READ_ONLY || !cfg.BREVO_API_KEY) return;
  const practiceName = data.practiceName || "New referral";
  const contactName = [data.contactFirstName, data.contactLastName].filter(Boolean).join(" ");

  const base = {};
  const pipelineName = String(cfg.BREVO_DEALS_PIPELINE_NAME || "").trim();
  const stageName = String(cfg.BREVO_DEALS_STAGE_NAME || "").trim();
  if (pipelineName) {
    const pipes = await brevo(cfg, "GET", "/crm/pipeline/details/all");
    const pipe = (pipes.json || []).find((p) => String(p.pipeline_name || "").trim() === pipelineName);
    const stage = pipe && (pipe.stages || []).find((s) => String(s.name || "").trim() === stageName);
    if (pipe && stage) Object.assign(base, { pipeline: pipe.pipeline, deal_stage: stage.id });
  }

  // Custom deal attributes: { formField: brevoInternalName } JSON in Settings.
  const extra = {};
  let internalNames = {};
  try {
    internalNames = JSON.parse(cfg.BREVO_DEAL_ATTRIBUTES_JSON || "{}");
  } catch {
    internalNames = {};
  }
  const computed = { ...data, contactName };
  for (const [field, internalName] of Object.entries(internalNames)) {
    const value = computed[field];
    if (!internalName || value === undefined || value === null || value === "") continue;
    if (NUMERIC_DEAL_FIELDS.has(field)) {
      const n = Number(value);
      if (!isNaN(n)) extra[internalName] = n;
    } else {
      extra[internalName] = String(value);
    }
  }

  const payload = { name: practiceName + (contactName ? " - " + contactName : "") };
  if (Object.keys(base).length || Object.keys(extra).length) payload.attributes = { ...base, ...extra };
  if (contactId) payload.linkedContactsIds = [contactId];

  let res = await brevo(cfg, "POST", "/crm/deals", payload);
  if (!res.ok && Object.keys(extra).length) {
    if (Object.keys(base).length) payload.attributes = base;
    else delete payload.attributes;
    res = await brevo(cfg, "POST", "/crm/deals", payload);
  }
  if (!res.ok || !res.json?.id) {
    logEvent("error", practiceName, `Brevo deal: HTTP ${res.status} ${res.text.slice(0, 200)}`, null, false);
    return;
  }
  const noteHtml = String(noteText)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br />");
  await brevo(cfg, "POST", "/crm/notes", { text: noteHtml, dealIds: [res.json.id] });
}
