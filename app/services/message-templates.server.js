import { connectDb } from "../db.server";
import { Setting } from "../models/index.server";
import { fillTemplate, sendEmail, sendSms } from "./brevo.server";
import { getWelcomeTemplate, saveWelcomeTemplate, sendWelcomeEmail } from "./provisioning.server";
import { READ_ONLY } from "./shopify-admin.server";
import { SETTINGS_DEFAULTS, getSettings, isTrue, setSettings } from "./settings.server";

/* Every message the portal sends a customer, for the Emails page. Each
   entry names the settings that hold its wording; nothing here changes
   when or how a message is sent - the senders read the same settings. */

const LINK = "https://protocoltherapeutics.com/pages/rx-cart?rx=RX-TEST";

/* "When it is sent" settings shown on a tab (were the Settings page's
   "Prescription reminders" group). The reminders master switch is shared by
   all three reminder emails. */
const REMINDERS_ON = { key: "REMINDERS_ENABLED", label: "Send prescription reminders (all three reminder emails)", type: "bool" };
const hours = (key, label, help) => ({ key, label, type: "hours", help });
const RX = [
  { token: "name", sample: "Jane", note: "patient's first name" },
  { token: "link", sample: LINK, note: "the patient's protocol / checkout link" },
  { token: "validity", sample: "December 31, 2026", note: "when the link expires" },
  { token: "doctor_name", sample: "John Carter", note: "physician's name, without “Dr”" },
];

export const MESSAGES = [
  {
    id: "welcome", label: "Welcome email", kind: "email",
    subjectKey: "WELCOME_EMAIL_SUBJECT", bodyKey: "WELCOME_EMAIL_BODY",
    when: "Sent to a new practice, clinic, physician or sales rep created on the Accounts page with “Send welcome email” ticked.",
    looseMatch: true, // [First Name] == [first name] - see sendWelcomeEmail
    placeholders: [
      { token: "First Name", sample: "Jane" }, { token: "Last Name", sample: "Smith" },
      { token: "Name", sample: "Jane Smith" }, { token: "Email", sample: "jane.smith@example.com" },
      { token: "Role", sample: "Physician" }, { token: "Link", sample: "", note: "login, then the account's own dashboard" },
    ],
  },
  {
    id: "protocol-email", label: "Protocol email", kind: "email",
    subjectKey: "CONFIRMED_SUBJECT", bodyKey: "CONFIRMED_BODY", templateIdKey: "CONFIRMED_TEMPLATE_ID",
    when: "Sent to the patient when a physician sends a protocol by email (Prescription builder → Send).",
    placeholders: RX,
  },
  {
    id: "protocol-sms", label: "Protocol SMS", kind: "sms", bodyKey: "SMS_BODY",
    when: "Sent with the protocol email when the physician ticks “Also send by SMS”. [link] is shortened.",
    placeholders: RX,
  },
  {
    id: "not-opened", label: "Reminder: not opened", kind: "email",
    subjectKey: "NOT_OPENED_SUBJECT", bodyKey: "NOT_OPENED_BODY", templateIdKey: "NOT_OPENED_TEMPLATE_ID",
    when: "Sent when the patient hasn't opened the protocol link - a first and a second reminder.",
    placeholders: RX,
    settings: [
      REMINDERS_ON,
      hours("REMINDER_1_HOURS", "First reminder", "Hours after the protocol was sent, if the link wasn't opened."),
      hours("REMINDER_2_HOURS", "Second reminder", "Hours after it was sent, if the link still wasn't opened."),
    ],
  },
  {
    id: "abandoned", label: "Reminder: abandoned cart", kind: "email",
    subjectKey: "ABANDONED_SUBJECT", bodyKey: "ABANDONED_BODY", templateIdKey: "ABANDONED_TEMPLATE_ID",
    when: "Sent when the patient opened the link or started checkout but didn't buy.",
    placeholders: RX,
    settings: [
      REMINDERS_ON,
      hours("ABANDONED_AFTER_HOURS", "Abandoned after", "Hours after opening / starting checkout without buying."),
    ],
  },
  {
    id: "abandoned-sms", label: "Abandoned cart SMS", kind: "sms",
    bodyKey: "ABANDONED_SMS_BODY", enabledKey: "ABANDONED_SMS_ENABLED",
    when: "Sent with the abandoned-cart reminder email when the prescription has a phone number.",
    placeholders: [
      { token: "First Name", sample: "Jane", note: "patient's first name" },
      { token: "Last Name", sample: "Carter", note: "physician's last name" },
      { token: "View Your Protocol", sample: "https://tinyurl.com/rx-test", note: "short protocol link" },
      ...RX,
    ],
  },
  {
    id: "expiry", label: "Reminder: expiring", kind: "email",
    subjectKey: "EXPIRY_SUBJECT", bodyKey: "EXPIRY_BODY", templateIdKey: "EXPIRY_TEMPLATE_ID",
    when: "Sent shortly before the protocol link expires, if it still hasn't been bought.",
    placeholders: RX,
    settings: [
      REMINDERS_ON,
      hours("BEFORE_EXPIRY_HOURS", "Before expiry", "Hours before the link expires."),
    ],
  },
  {
    id: "order-confirm-email", label: "Order confirmation email", kind: "email",
    subjectKey: "ORDER_CONFIRM_SUBJECT", bodyKey: "ORDER_CONFIRM_BODY", enabledKey: "ORDER_CONFIRM_EMAIL_ENABLED",
    when: "Sent once to the customer of every paid Shopify order: products with their images, totals and the shipping address. Shopify's own order confirmation email is separate - see Shopify admin → Settings → Notifications.",
    // shown as the placeholder itself in the preview / test - no sample order data
    placeholders: ["name", "order-number", "order_date", "items", "subtotal", "discount_row", "shipping", "tax", "total", "shipping_address", "order_status_link"]
      .map((token) => ({ token, sample: "[" + token + "]" })),
    settings: [
      { key: "ORDER_PAID_SMS_START_AT", label: "Only orders created after", type: "datetime",
        help: "Shared with the order confirmation SMS: older orders never get it. Blank = set automatically the first time it runs." },
    ],
  },
  {
    id: "order-paid-sms", label: "Order confirmation SMS", kind: "sms",
    bodyKey: "ORDER_PAID_BODY", enabledKey: "ORDER_PAID_SMS_ENABLED",
    when: "Sent once to the customer of every paid Shopify order with a phone number.",
    placeholders: [
      { token: "name", sample: "Jane", note: "customer's first name" },
      { token: "order-number", sample: "#1001" },
    ],
    settings: [
      { key: "ORDER_PAID_SMS_START_AT", label: "Only orders created after", type: "datetime",
        help: "Orders created before this never get the confirmation (or shipped) SMS. Blank = set automatically the first time it runs, so the old backlog is never texted." },
    ],
  },
  {
    id: "order-shipped-sms", label: "Order shipped SMS", kind: "sms",
    bodyKey: "ORDER_FULFILLED_BODY", enabledKey: "ORDER_FULFILLED_SMS_ENABLED",
    when: "Sent once when an order is fulfilled and has a tracking link.",
    placeholders: [
      { token: "First Name", sample: "Jane" },
      { token: "Tracking Link", sample: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400TEST" },
    ],
  },
  {
    id: "order-updated-sms", label: "Order updated SMS", kind: "sms",
    bodyKey: "ORDER_UPDATED_BODY", enabledKey: "ORDER_UPDATED_SMS_ENABLED",
    when: "Sent when an order's phone, email or shipping address is changed.",
    placeholders: [
      { token: "First Name", sample: "Jane" },
      { token: "order-number", sample: "#1001" },
      { token: "Order Update Summary", sample: "Shipping address updated." },
    ],
  },
];

const DEFAULTS = Object.fromEntries(SETTINGS_DEFAULTS.map(([k, v]) => [k, v]));
const byId = (id) => MESSAGES.find((m) => m.id === id);
const sampleValues = (m) => Object.fromEntries(m.placeholders.map((p) => [p.token, p.sample]));

/** Everything the Emails page shows, per message. */
export async function listMessages() {
  await connectDb();
  const cfg = await getSettings({ fresh: true });
  const stored = new Set((await Setting.find({}, { key: 1 }).lean()).map((r) => r.key));
  const welcome = await getWelcomeTemplate(cfg);
  return MESSAGES.map((m) => {
    const isWelcome = m.id === "welcome";
    const subject = isWelcome ? welcome.subject : m.subjectKey ? cfg[m.subjectKey] || "" : "";
    const body = isWelcome ? welcome.body : cfg[m.bodyKey] || "";
    const defaultSubject = m.subjectKey ? DEFAULTS[m.subjectKey] || "" : "";
    const defaultBody = DEFAULTS[m.bodyKey] || "";
    return {
      ...m,
      subject,
      body,
      // welcome's defaults live in welcome-default.server (its settings default to blank)
      defaultSubject: isWelcome ? null : defaultSubject,
      defaultBody: isWelcome ? null : defaultBody,
      custom: isWelcome ? welcome.custom : subject !== defaultSubject || body !== defaultBody,
      enabled: m.enabledKey ? isTrue(cfg[m.enabledKey]) : null,
      settings: (m.settings || []).map((s) => ({ ...s, value: String(cfg[s.key] ?? "") })),
      templateId: m.templateIdKey ? cfg[m.templateIdKey] || "" : "",
      stored: [m.subjectKey, m.bodyKey].some((k) => k && stored.has(k)),
    };
  });
}

export async function saveMessage(id, { subject, body, templateId }) {
  const m = byId(id);
  if (!m) throw new Error("Unknown message: " + id);
  if (m.id === "welcome") return saveWelcomeTemplate({ subject, body });
  const map = { [m.bodyKey]: String(body ?? "") };
  if (m.subjectKey) map[m.subjectKey] = String(subject ?? "");
  if (m.templateIdKey) map[m.templateIdKey] = String(templateId ?? "").trim();
  await setSettings(map);
}

/** Back to the built-in wording (the stored rows are removed). */
export async function resetMessage(id) {
  const m = byId(id);
  if (!m) throw new Error("Unknown message: " + id);
  if (m.id === "welcome") return saveWelcomeTemplate({ subject: "", body: "" });
  await connectDb();
  await Setting.deleteMany({ key: { $in: [m.subjectKey, m.bodyKey].filter(Boolean) } });
  await getSettings({ fresh: true }); // drop the cached copy
}

/** Saves a tab's "when it is sent" settings - only keys that tab owns. */
export async function saveMessageSettings(id, input) {
  const m = byId(id);
  if (!m?.settings?.length) throw new Error("This message has no sending settings.");
  const map = {};
  for (const s of m.settings) {
    if (!(s.key in input)) continue;
    const raw = String(input[s.key] ?? "").trim();
    if (s.type === "bool") map[s.key] = raw === "TRUE" ? "TRUE" : "FALSE";
    else if (s.type === "hours") {
      const n = Number(raw);
      if (raw === "" || !(n >= 0)) throw new Error(`${s.label}: enter 0 or more hours.`);
      map[s.key] = String(n);
    } else if (s.type === "datetime") {
      if (raw && isNaN(new Date(raw).getTime())) throw new Error(`${s.label}: not a valid date/time.`);
      map[s.key] = raw;
    } else map[s.key] = raw;
  }
  await setSettings(map);
}

export async function setMessageEnabled(id, on) {
  const m = byId(id);
  if (!m?.enabledKey) throw new Error("This message can't be switched off here.");
  await setSettings({ [m.enabledKey]: on ? "TRUE" : "FALSE" });
}

/**
 * Sends the SAVED template once with the sample values, "[Test]" in the
 * subject. `to` is an email or (for SMS) a phone number. Returns a message
 * for the page.
 */
export async function sendTestMessage(id, to, role) {
  const m = byId(id);
  if (!m) throw new Error("Unknown message: " + id);
  to = String(to || "").trim();
  const cfg = await getSettings({ fresh: true });

  if (m.kind === "sms") {
    const digits = to.replace(/\D/g, "");
    if (digits.length < 10) return { ok: false, message: "Enter a phone number with country code, e.g. +1 555 123 4567." };
    if (READ_ONLY) return { ok: false, message: "Not sent - read-only mode (RX_READ_ONLY)." };
    if (isTrue(cfg.SMS_DISABLED)) return { ok: false, message: "Not sent - SMS_DISABLED is on in Settings." };
    if (!cfg.BREVO_API_KEY) return { ok: false, message: "Not sent - set BREVO_API_KEY in Settings." };
    const ok = await sendSms(digits, fillTemplate(cfg[m.bodyKey], sampleValues(m)));
    return ok
      ? { ok: true, message: `Test SMS sent to +${digits}.` }
      : { ok: false, message: "Brevo didn't accept the SMS - see Sync & logs for the reason." };
  }

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { ok: false, message: "Enter a valid email to send the test to." };
  if (m.id === "welcome") {
    const result = await sendWelcomeEmail({ firstName: "Test", lastName: "User", email: to, role: role || "Physician", test: true });
    return result === "sent"
      ? { ok: true, message: `Test welcome email (${role || "Physician"}) sent to ${to}.` }
      : { ok: false, message: "Test not sent - " + result };
  }
  const values = sampleValues(m);
  await sendEmail({
    to,
    subject: "[Test] " + fillTemplate(cfg[m.subjectKey], values),
    htmlBody: fillTemplate(cfg[m.bodyKey], values),
    params: { NAME: values.name, LINK: values.link, VALIDITY: values.validity, DOCTOR_NAME: values.doctor_name },
    templateId: m.templateIdKey ? cfg[m.templateIdKey] : "",
  });
  return { ok: true, message: `Test “${m.label}” sent to ${to}.` };
}
