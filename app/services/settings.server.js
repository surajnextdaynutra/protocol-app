import { connectDb } from "../db.server";
import { Setting } from "../models/index.server";
import * as M from "./message-defaults.server";
import { invalidateResponses } from "./response-cache.server";

/**
 * Every admin-editable setting, with its default. Replaces the "Settings"
 * sheet tab plus the script properties each Apps Script project carried
 * (Brevo keys, kill switches, commission rate, demo ids). Edited from
 * Shopify admin -> Rx Portal -> Settings; nothing here needs a redeploy.
 */
const LINK_NOTE =
  'HTML email body. Placeholders: [name] [link] [validity] [doctor_name]. [link] is used as the href of the "Click Here" button - the raw URL is never shown. [doctor_name] is the prescribing physician\'s name (already without a "Dr" prefix).';

export const SETTINGS_DEFAULTS = [
  // --- reminders
  ["REMINDERS_ENABLED", "TRUE", "TRUE/FALSE - master switch for all automatic reminders", "reminders"],
  ["REMINDER_1_HOURS", "24", "First reminder: hours after sending if the link was not opened", "reminders"],
  ["REMINDER_2_HOURS", "72", "Second reminder: hours after sending if the link is still not opened", "reminders"],
  ["ABANDONED_AFTER_HOURS", "24", "Mark Abandoned (and remind) this many hours after opening/checkout without purchase", "reminders"],
  ["BEFORE_EXPIRY_HOURS", "24", "Final reminder this many hours before the link expires", "reminders"],
  // --- email templates
  ["NOT_OPENED_SUBJECT", "Your prescription is waiting", "Reminder subject when the link was not opened", "email"],
  ["NOT_OPENED_BODY", M.NOT_OPENED_BODY_DEFAULT, LINK_NOTE, "email"],
  ["NOT_OPENED_TEMPLATE_ID", "", "Optional Brevo template id. If set, this reminder uses that template's own design/subject; only params NAME/LINK/VALIDITY/DOCTOR_NAME are filled in.", "email"],
  ["ABANDONED_SUBJECT", "You left your prescribed items in your cart", "Reminder subject for abandoned checkout", "email"],
  ["ABANDONED_BODY", M.ABANDONED_BODY_DEFAULT, LINK_NOTE, "email"],
  ["ABANDONED_TEMPLATE_ID", "", "Optional Brevo template id (params NAME/LINK/VALIDITY/DOCTOR_NAME).", "email"],
  ["EXPIRY_SUBJECT", "Your prescription link expires soon", "Reminder subject before expiry", "email"],
  ["EXPIRY_BODY", M.EXPIRY_BODY_DEFAULT, LINK_NOTE, "email"],
  ["EXPIRY_TEMPLATE_ID", "", "Optional Brevo template id (params NAME/LINK/VALIDITY/DOCTOR_NAME).", "email"],
  ["CONFIRMED_SUBJECT", M.CONFIRMED_SUBJECT_DEFAULT, "Subject of the email sent when a prescription is sent by email", "email"],
  ["CONFIRMED_BODY", M.CONFIRMED_BODY_DEFAULT, LINK_NOTE, "email"],
  ["CONFIRMED_TEMPLATE_ID", "", 'Optional Brevo template id. Put "{{ params.NAME }}" etc. in the Brevo template.', "email"],
  // --- welcome email for new portal accounts
  ["WELCOME_EMAIL_SUBJECT", "", "Subject of the welcome email sent to a new practice / clinic / physician / rep. Placeholders: [First Name] [Last Name] [Name] [Email] [Role] [Link]. Empty = the built-in \"Your Protocol Therapeutics Account Is Ready\". Easier to edit (with preview) on the Welcome email page.", "welcome"],
  ["WELCOME_EMAIL_BODY", "", "Body of the welcome email (plain text or HTML). Same placeholders. Empty = the built-in Protocol Therapeutics template. Whether an account gets the email is the \"Send welcome email\" tick when creating it.", "welcome"],
  ["WELCOME_EMAIL_LINK", "https://protocoltherapeutics.com/customer_authentication/login?return_to=/", "What [Link] resolves to. return_to is swapped for the role's own dashboard.", "welcome"],
  ["WELCOME_EMAIL_DELAY_MINUTES", "30", "Minutes to wait after an account is created before its welcome email goes out.", "welcome"],
  // --- sms
  ["SMS_BODY", M.SMS_BODY_DEFAULT, 'SMS sent when the doctor checks "Also send by SMS". Placeholders: [name] [link] [validity] [doctor_name].', "sms"],
  ["ABANDONED_SMS_ENABLED", "FALSE", "TRUE/FALSE - also text the patient (when the prescription has a phone) along with the abandoned-cart reminder email. Off until switched on: the Google scripts never sent this one.", "sms"],
  ["ABANDONED_SMS_BODY", M.ABANDONED_SMS_BODY_DEFAULT, "Placeholders: [First Name] (patient), [Last Name] (physician's last name), [View Your Protocol] (short link), [name] [link] [doctor_name].", "sms"],
  ["ORDER_PAID_SMS_ENABLED", "TRUE", "TRUE/FALSE - one-time SMS to the customer of EVERY paid order that has a phone on it.", "sms"],
  ["ORDER_PAID_BODY", M.ORDER_PAID_BODY_DEFAULT, "Placeholders: [name] [order-number].", "sms"],
  ["ORDER_PAID_SMS_START_AT", "", "Optional ISO date/time. Orders created before this never get the order-paid SMS. Blank = captured automatically the first time the feature runs.", "sms"],
  // --- order confirmation email (the app's own, alongside / instead of Shopify's)
  ["ORDER_CONFIRM_EMAIL_ENABLED", "TRUE", "TRUE/FALSE - the app's order confirmation email to the customer of every paid order (same go-live cutoff as the order-paid SMS).", "email"],
  ["ORDER_CONFIRM_SUBJECT", M.ORDER_CONFIRM_SUBJECT_DEFAULT, "Placeholders: [name] [order-number].", "email"],
  ["ORDER_CONFIRM_BODY", M.ORDER_CONFIRM_BODY_DEFAULT, "HTML. Placeholders: [name] [order-number] [order_date] [items] [subtotal] [discount_row] [shipping] [tax] [total] [shipping_address] [order_status_link].", "email"],
  ["ORDER_FULFILLED_SMS_ENABLED", "FALSE", "TRUE/FALSE - one-time SMS when an order is fulfilled and has a tracking link. Off by default: the old Google script never actually sent this one.", "sms"],
  ["ORDER_FULFILLED_BODY", M.ORDER_FULFILLED_BODY_DEFAULT, "Placeholders: [First Name] [Tracking Link].", "sms"],
  ["ORDER_UPDATED_SMS_ENABLED", "TRUE", "TRUE/FALSE - SMS whenever an order's phone, email or shipping address is changed.", "sms"],
  ["ORDER_UPDATED_BODY", M.ORDER_UPDATED_BODY_DEFAULT, "Placeholders: [First Name], [order-number], [Order Update Summary].", "sms"],
  // --- kill switches (were constants in Config.gs)
  ["SMS_DISABLED", "FALSE", "TRUE stops every SMS without touching the Brevo key.", "channels"],
  ["EMAIL_DISABLED", "FALSE", "TRUE stops every email without touching the Brevo key.", "channels"],
  // --- Brevo (were script properties)
  ["BREVO_API_KEY", "", "Brevo API v3 key (Brevo -> SMTP & API).", "brevo", true],
  ["BREVO_SENDER_EMAIL", "", "A sender address verified in Brevo.", "brevo"],
  ["BREVO_SENDER_NAME", "Protocol Therapeutics", "Display name on outgoing email.", "brevo"],
  ["BREVO_SMS_SENDER", "Rx", "Approved Brevo SMS sender - letters/digits only, max 11 characters.", "brevo"],
  // --- website forms
  ["SALES_EMAIL", "onboarding@protocoltherapeutics.com", "Where New Client / Sales Referral submissions are emailed.", "forms"],
  ["CONTACT_EMAIL", "sales@protocoltherapeutics.com", "Where contact / support form submissions are emailed.", "forms"],
  ["BREVO_CONTACTS_LIST_NAME", "Rep Onboarding", "Brevo contact list a referral's contact is added to. Blank = no list.", "forms"],
  ["BREVO_DEALS_PIPELINE_NAME", "Practice Onboarding", "Brevo deals pipeline a referral's deal is created in. Blank = Brevo's default.", "forms"],
  ["BREVO_DEALS_STAGE_NAME", "New Lead", "Stage inside that pipeline.", "forms"],
  ["BREVO_DEAL_ATTRIBUTES_JSON", "", 'Optional JSON map of form field -> Brevo deal attribute internal name, e.g. {"practiceName":"practice_name"}.', "forms"],
  // --- commission
  ["COMMISSION_PERCENT", "5", "Default commission % of purchased order totals, used when a doctor has no commission:X tag override", "commission"],
  ["COMMISSION_PER_UNIT", "1", "Sales rep commission in dollars per product unit sold.", "commission"],
  // --- product copies
  ["PRODUCT_SYNC_DELETE_ORPHANS", "FALSE", "TRUE = when a practice's last physician is removed, delete that practice's product copies (after it has been missing on two sync runs). FALSE = only report them on the Products page.", "products"],
  ["LOCATION_ID", "", "Shopify inventory location id used for shared inventory. Blank = the store's primary location. Changing it re-stocks every copy at the new location from the master list.", "products"],
  ["PRODUCT_VENDOR", "Protocol Therapeutics", "Vendor on product copies when the master has no Vendor of its own.", "products"],
  // --- misc
  ["DEMO_IDS", "", "Comma-separated demo practice_id / clinic_id / doctor_id values. Demo orders are hidden from finance and never pay a rep.", "demo"],
  ["TIMEZONE", "America/New_York", "IANA timezone used for payout months and dashboard date ranges.", "general"],
  ["ORDER_SYNC_DAYS", "30", "How many days back the safety-net order sync re-checks Shopify.", "general"],
];

const DEFAULT_MAP = Object.fromEntries(
  SETTINGS_DEFAULTS.map(([k, v]) => [k, v]),
);
export const SECRET_KEYS = new Set(
  SETTINGS_DEFAULTS.filter((r) => r[4]).map((r) => r[0]),
);

let cache = null;
let cacheAt = 0;
const TTL = 30_000;

/** All settings as a flat { KEY: "value" } object, plus the parsed reminder
 *  numbers the sweep uses. Cached in-process for 30 s. */
export async function getSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < TTL) return cache;
  await connectDb();
  const rows = await Setting.find({}, { key: 1, value: 1 }).lean();
  const cfg = { ...DEFAULT_MAP };
  for (const r of rows) {
    const v = String(r.value ?? "");
    // a template still holding the app's old wording was never edited -> new default
    cfg[r.key] = M.OLD_DEFAULTS[r.key] === v ? DEFAULT_MAP[r.key] : v;
  }
  cfg.enabled = isTrue(cfg.REMINDERS_ENABLED);
  cfg.r1 = Number(cfg.REMINDER_1_HOURS) || 0;
  cfg.r2 = Number(cfg.REMINDER_2_HOURS) || 0;
  cfg.abandonH = Number(cfg.ABANDONED_AFTER_HOURS) || 0;
  cfg.beforeExpH = Number(cfg.BEFORE_EXPIRY_HOURS) || 0;
  cache = cfg;
  cacheAt = Date.now();
  return cfg;
}

export function isTrue(v) {
  return String(v ?? "").trim().toUpperCase() === "TRUE";
}

export async function setSetting(key, value) {
  invalidateResponses();
  await connectDb();
  const def = SETTINGS_DEFAULTS.find((r) => r[0] === key);
  await Setting.updateOne(
    { key },
    {
      $set: { value: String(value ?? "") },
      $setOnInsert: {
        notes: def?.[2] || "",
        group: def?.[3] || "general",
        secret: !!def?.[4],
      },
    },
    { upsert: true },
  );
  cache = null;
}

export async function setSettings(map) {
  invalidateResponses();
  for (const [k, v] of Object.entries(map)) await setSetting(k, v);
}

/** Rows for the admin Settings page: defaults merged with stored values. */
export async function listSettings() {
  await connectDb();
  const stored = Object.fromEntries(
    (await Setting.find({}).lean()).map((r) => [r.key, r]),
  );
  const rows = SETTINGS_DEFAULTS.map(([key, def, notes, group, secret]) => ({
    key,
    value: stored[key] && M.OLD_DEFAULTS[key] !== stored[key].value ? stored[key].value : def,
    notes,
    group,
    secret: !!secret,
    isDefault: !stored[key] || M.OLD_DEFAULTS[key] === stored[key].value,
  }));
  // keys that exist only in the database (imported from the old sheet)
  for (const r of Object.values(stored)) {
    if (!DEFAULT_MAP.hasOwnProperty(r.key)) {
      rows.push({
        key: r.key,
        value: r.value,
        notes: r.notes || "",
        group: r.group || "general",
        secret: !!r.secret,
        isDefault: false,
      });
    }
  }
  return rows;
}
