import mongoose from "../db.server";

const { Schema } = mongoose;

/** Vite reloads this module in dev. The model is compiled again from the
 *  schema just read: reusing the one compiled before kept serving the OLD
 *  schema after an edit (new fields silently dropped on save) until the
 *  server was restarted. deleteModel avoids OverwriteModelError. */
function model(name, schema, collection) {
  if (mongoose.models[name]) mongoose.deleteModel(name);
  return mongoose.model(name, schema, collection);
}

/* ---------------------------------------------------------------------------
   Settings - replaces the "Settings" sheet tab AND every Apps Script project's
   script properties (Brevo keys, kill switches, commission rate, demo ids).
   --------------------------------------------------------------------------- */
const settingSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: String, default: "" },
    notes: { type: String, default: "" },
    group: { type: String, default: "general" },
    secret: { type: Boolean, default: false },
  },
  { timestamps: true },
);
export const Setting = model("Setting", settingSchema, "settings");

/* ---------------------------------------------------------------------------
   Prescriptions - replaces the "Prescriptions" tab. One document per Rx ID.
   Unlike the sheet, a purchased prescription is KEPT (status 'Purchased')
   instead of deleted; the open-prescription queries filter by status.
   --------------------------------------------------------------------------- */
export const RX_OPEN_STATUSES = [
  "Created",
  "Sent",
  "Opened",
  "Checkout Started",
  "Abandoned",
];

const prescriptionSchema = new Schema(
  {
    rxId: { type: String, required: true, unique: true },
    patientId: { type: String, default: "", index: true },
    clientType: { type: String, default: "" },
    first: { type: String, default: "" },
    last: { type: String, default: "" },
    email: { type: String, default: "", index: true },
    phone: { type: String, default: "" },
    physician: { type: String, default: "" },
    doctorId: { type: String, default: "", index: true },
    clinicId: { type: String, default: "", index: true },
    practiceId: { type: String, default: "", index: true },
    customerId: { type: String, default: "" },
    patientEdit: { type: String, default: "No" },
    items: { type: String, default: "" },
    total: { type: String, default: "" },
    validity: { type: String, default: "" },
    expiresAt: { type: Date, default: null },
    link: { type: String, default: "" },
    status: { type: String, default: "Created", index: true },
    confirmed: { type: Boolean, default: false }, // sheet's "Confirmation" Yes/No = actually delivered
    emailSentAt: { type: Date, default: null },
    purchasedAt: { type: Date, default: null },
    orderName: { type: String, default: "" },
    orderId: { type: String, default: "" },
    openedAt: { type: Date, default: null },
    checkoutAt: { type: Date, default: null },
    reminder1At: { type: Date, default: null },
    reminder2At: { type: Date, default: null },
    expiryReminderAt: { type: Date, default: null },
    demo: { type: Boolean, default: false },
  },
  { timestamps: true },
);
prescriptionSchema.index({ status: 1, createdAt: -1 });
export const Prescription = model(
  "Prescription",
  prescriptionSchema,
  "prescriptions",
);

/* ---------------------------------------------------------------------------
   Orders - a local copy of every Shopify order the portal cares about, kept
   current by the orders/* webhooks. Dashboards read THIS, never Shopify, which
   is what removes the 10 s - 1 min dashboard loads. The embedded `commission`
   block replaces the "Order Commission Log" tab.
   --------------------------------------------------------------------------- */
const lineItemSchema = new Schema(
  {
    lineItemId: String,
    productId: String,
    variantId: String,
    title: String,
    variantTitle: String,
    sku: String,
    quantity: { type: Number, default: 1 },
    price: { type: Number, default: 0 }, // per unit, before discounts
    totalDiscount: { type: Number, default: 0 },
    sellingPlan: { type: String, default: "" },
    properties: { type: Schema.Types.Mixed, default: {} },
    // commission split for this line, frozen at payment time
    doctorAmt: { type: Number, default: 0 },
    clinicAmt: { type: Number, default: 0 },
    practiceAmt: { type: Number, default: 0 },
    physicianRate: { type: Number, default: 0 },
    clinicRate: { type: Number, default: 0 },
    wholesale: { type: Number, default: 0 },
  },
  { _id: false },
);

const orderSchema = new Schema(
  {
    orderId: { type: String, required: true, unique: true },
    name: { type: String, default: "", index: true },
    orderCreatedAt: { type: Date, index: true },
    processedAt: Date,
    cancelledAt: { type: Date, default: null },
    email: { type: String, default: "", index: true },
    phone: { type: String, default: "" },
    financialStatus: { type: String, default: "", index: true },
    fulfillmentStatus: { type: String, default: "" },
    deliveryStatus: { type: String, default: "Not Shipped" },
    // Shopify's own display status of the first live fulfillment (DELIVERED,
    // IN_TRANSIT, FULFILLED, ...) - '' until something ships. The dashboards'
    // status labels and filters are built from this.
    fulfillmentDisplay: { type: String, default: "" },
    trackingUrl: { type: String, default: "" },
    trackingCompany: { type: String, default: "" },
    estimatedDeliveryAt: { type: Date, default: null },
    currency: { type: String, default: "USD" },
    subtotal: { type: Number, default: 0 },
    totalDiscounts: { type: Number, default: 0 },
    totalShipping: { type: Number, default: 0 },
    totalTax: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    totalRefunded: { type: Number, default: 0 },
    tags: { type: [String], default: [] },
    noteAttributes: { type: Schema.Types.Mixed, default: {} },

    // attribution (see services/ids.server.js)
    isRx: { type: Boolean, default: false, index: true },
    rxId: { type: String, default: "", index: true },
    patientId: { type: String, default: "", index: true },
    doctorId: { type: String, default: "", index: true },
    clinicId: { type: String, default: "", index: true },
    practiceId: { type: String, default: "", index: true },
    wholesaleRole: { type: String, default: "" },
    wsDoctorId: { type: String, default: "", index: true },
    wsClinicId: { type: String, default: "", index: true },
    wsPracticeId: { type: String, default: "", index: true },
    repId: { type: String, default: "", index: true },
    subscription: { type: Boolean, default: false },
    demo: { type: Boolean, default: false, index: true },

    customer: {
      id: { type: String, default: "" },
      first: { type: String, default: "" },
      last: { type: String, default: "" },
      email: { type: String, default: "" },
      phone: { type: String, default: "" },
      tags: { type: [String], default: [] },
    },
    shippingAddress: { type: Schema.Types.Mixed, default: null },
    lineItems: { type: [lineItemSchema], default: [] },
    units: { type: Number, default: 0 },

    commission: {
      logged: { type: Boolean, default: false, index: true },
      loggedAt: Date,
      // resolved (wholesale-fallback-aware) ids the split was credited to
      doctorId: { type: String, default: "", index: true },
      clinicId: { type: String, default: "", index: true },
      practiceId: { type: String, default: "", index: true },
      doctorAmt: { type: Number, default: 0 },
      clinicAmt: { type: Number, default: 0 },
      practiceAmt: { type: Number, default: 0 },
      repId: { type: String, default: "", index: true },
      repAmt: { type: Number, default: 0 },
      solo: { type: Boolean, default: false },
      counted: { type: String, default: "No" }, // Yes / No / Reversed
      month: { type: String, default: "" }, // yyyy-MM the split was counted into
      status: { type: String, default: "Active" }, // Active / Deleted
    },

    sms: {
      paidSentAt: Date,
      fulfilledSentAt: Date,
    },
    // the app's order confirmation email - claimed once, like the SMS
    emails: {
      confirmSentAt: Date,
    },
    // last-seen contact snapshot for the "order updated" SMS diff
    snapshot: {
      phone: String,
      email: String,
      shipping: String,
    },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
orderSchema.index({ doctorId: 1, orderCreatedAt: -1 });
orderSchema.index({ clinicId: 1, orderCreatedAt: -1 });
orderSchema.index({ practiceId: 1, orderCreatedAt: -1 });
orderSchema.index({ "commission.repId": 1, orderCreatedAt: -1 });
orderSchema.index({ "customer.id": 1, orderCreatedAt: -1 });
export const Order = model("Order", orderSchema, "orders");

/* ---------------------------------------------------------------------------
   Monthly Payout Summary - one row per (month, role, id). Amount is only ever
   incremented / decremented by the order pipeline; status, date paid and
   transaction # belong to the finance admin.
   --------------------------------------------------------------------------- */
const monthlyPayoutSchema = new Schema(
  {
    month: { type: String, required: true }, // yyyy-MM
    role: { type: String, required: true }, // Practice / Doctor / Rep
    entityId: { type: String, required: true },
    // record number within (month, role, id): a paid record is closed, and
    // commission logged after it opens the next one (commission.server.js
    // adjustMonthlyPayout) - at most one record per month is not Paid
    seq: { type: Number, default: 0 },
    amount: { type: Number, default: 0 },
    status: { type: String, default: "Pending" },
    datePaid: { type: String, default: "" },
    transactionNo: { type: String, default: "" },
    paidAt: { type: Date, default: null },
    note: { type: String, default: "" },
  },
  { timestamps: true },
);
monthlyPayoutSchema.index({ month: 1, role: 1, entityId: 1, seq: 1 }, { unique: true });
monthlyPayoutSchema.index({ role: 1, entityId: 1 });
export const MonthlyPayout = model(
  "MonthlyPayout",
  monthlyPayoutSchema,
  "monthly_payouts",
);

/** The legacy "Payouts" tab - ad-hoc payments recorded by the admin. */
const payoutSchema = new Schema(
  {
    date: { type: Date, default: Date.now },
    entityId: { type: String, required: true, index: true },
    amount: { type: Number, default: 0 },
    note: { type: String, default: "" },
    method: { type: String, default: "" },
    reference: { type: String, default: "" },
    status: { type: String, default: "Paid" }, // only "Paid" rows count as money sent
  },
  { timestamps: true },
);
export const Payout = model("Payout", payoutSchema, "payouts");

/* ---------------------------------------------------------------------------
   Sales reps - replaces the "Sales Reps" tab. Banking is AES-256-GCM encrypted
   (services/crypto.server.js), never stored in plain text.
   --------------------------------------------------------------------------- */
const salesRepSchema = new Schema(
  {
    repId: { type: String, required: true, unique: true },
    name: { type: String, default: "" },
    email: { type: String, default: "", index: true },
    phone: { type: String, default: "" },
    customerId: { type: String, default: "" },
    assignedPracticeIds: { type: [String], default: [], index: true }, // practice_id OR clinic_id values
    commissionPercent: { type: Number, default: null },
    notes: { type: String, default: "" },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
export const SalesRep = model("SalesRep", salesRepSchema, "sales_reps");

/* ---------------------------------------------------------------------------
   Accounts - every portal user (practice master, clinic, physician, sales rep,
   demo, patient is NOT stored here). Mirrors the role tags on the Shopify
   customer and replaces the "Customer details" / "Clinics" / "Physicians"
   tabs. Kept current by the customers/* webhooks, so "is this a solo
   practice?" and "who are this practice's doctors?" are index lookups.
   --------------------------------------------------------------------------- */
const accountSchema = new Schema(
  {
    customerId: { type: String, required: true, unique: true },
    role: { type: String, default: "", index: true }, // Practice / Clinic / Physician / Sales Rep / Demo
    first: { type: String, default: "" },
    last: { type: String, default: "" },
    email: { type: String, default: "", index: true },
    phone: { type: String, default: "" },
    company: { type: String, default: "" },
    practiceName: { type: String, default: "" },
    clinicName: { type: String, default: "" },
    doctorId: { type: String, default: "", index: true },
    clinicId: { type: String, default: "", index: true },
    clinicIds: { type: [String], default: [] },
    practiceId: { type: String, default: "", index: true },
    repId: { type: String, default: "", index: true },
    wholesale: { type: Boolean, default: false },
    tags: { type: [String], default: [] },
    address: { type: Schema.Types.Mixed, default: null },
    extra: { type: Schema.Types.Mixed, default: {} }, // columns of the sheet with no dedicated field
    // set when the account was created from the app's Accounts page
    provisionedAt: { type: Date, default: null },
    welcomeDueAt: { type: Date, default: null },
    welcomeEmailSentAt: { type: Date, default: null },
    welcomeResult: { type: String, default: "" },    state: { type: String, default: "" }, // Shopify customer state (ENABLED / INVITED / DISABLED)
    demo: { type: Boolean, default: false },
  },
  { timestamps: true },
);
export const Account = model("Account", accountSchema, "accounts");

/** Sequential ids (PRA00001, CLN00001, DOC00001, PAT…, REP…) - replaces the
 *  "rxmaster id auto generator" script and the ID counter cells. */
const counterSchema = new Schema({
  _id: String,
  seq: { type: Number, default: 0 },
});
export const Counter = model("Counter", counterSchema, "counters");

/* ---------------------------------------------------------------------------
   Products - local copy of the Shopify catalogue with the pricing / commission
   metafields, kept current by the products/* webhooks. Replaces the "Products
   master" tab and the 250-capped product loops in the dashboards.
   --------------------------------------------------------------------------- */
const variantSchema = new Schema(
  {
    variantId: String,
    title: String,
    sku: String,
    price: { type: Number, default: 0 },
    compareAtPrice: { type: Number, default: null },
    inventoryQuantity: { type: Number, default: null },
    inventoryItemId: String,
    position: Number,
    available: { type: Boolean, default: true },
    metafields: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

const productSchema = new Schema(
  {
    productId: { type: String, required: true, unique: true },
    title: { type: String, default: "", index: true },
    handle: { type: String, default: "", index: true },
    status: { type: String, default: "ACTIVE", index: true },
    vendor: { type: String, default: "" },
    productType: { type: String, default: "" },
    tags: { type: [String], default: [], index: true },
    image: { type: String, default: "" },
    templateSuffix: { type: String, default: "" },
    variants: { type: [variantSchema], default: [] },
    price: { type: Number, default: 0 }, // first variant
    // custom.* money metafields the commission split reads
    wholesale: { type: Number, default: 0 },
    physicianCommission: { type: Number, default: 0 },
    clinicCommission: { type: Number, default: 0 },
    metafields: { type: Schema.Types.Mixed, default: {} },
    sellingPlanGroups: { type: [Schema.Types.Mixed], default: [] },
    // owner ids parsed from product tags (practice private-label copies)
    doctorId: { type: String, default: "", index: true },
    clinicId: { type: String, default: "", index: true },
    practiceId: { type: String, default: "", index: true },
    masterKey: { type: String, default: "", index: true }, // rxmaster:<key> tag - links every practice copy of one master product
    shopifyUpdatedAt: Date,
  },
  { timestamps: true },
);
export const Product = model("Product", productSchema, "products");

/* ---------------------------------------------------------------------------
   Earning overrides - the $ per unit a practice gives ONE of its clinics or
   physicians on one product, in place of that product's default
   custom.clinic_commission / custom.physician_commission. Keyed by the
   master key (survives a re-created copy), else the product id - see
   services/earnings.server.js productKey().
   --------------------------------------------------------------------------- */
const earningOverrideSchema = new Schema(
  {
    practiceId: { type: String, required: true },
    productKey: { type: String, required: true },
    role: { type: String, required: true }, // physician / clinic
    entityId: { type: String, required: true }, // doctor_id / clinic_id
    amount: { type: Number, default: 0 },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true },
);
earningOverrideSchema.index({ practiceId: 1, productKey: 1, role: 1, entityId: 1 }, { unique: true });
earningOverrideSchema.index({ practiceId: 1, role: 1, entityId: 1 });
export const EarningOverride = model("EarningOverride", earningOverrideSchema, "earning_overrides");

/* ---------------------------------------------------------------------------
   Banking details - replaces the banking metaobjects and the plain-text rep
   banking columns. `data` is an encrypted JSON blob.
   --------------------------------------------------------------------------- */
const bankingSchema = new Schema(
  {
    ownerType: { type: String, required: true }, // practice / clinic / physician / rep
    ownerId: { type: String, required: true },
    data: { type: String, default: "" }, // AES-256-GCM, see services/crypto.server.js
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true },
);
bankingSchema.index({ ownerType: 1, ownerId: 1 }, { unique: true });
export const Banking = model("Banking", bankingSchema, "banking");

/** About Us pages edited from the physician / clinic dashboards. */
const aboutPageSchema = new Schema(
  {
    ownerType: { type: String, required: true },
    ownerId: { type: String, required: true },
    data: { type: Schema.Types.Mixed, default: {} },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true },
);
aboutPageSchema.index({ ownerType: 1, ownerId: 1 }, { unique: true });
export const AboutPage = model("AboutPage", aboutPageSchema, "about_pages");

/** Referral / contact / support form entries. */
const formEntrySchema = new Schema(
  {
    form: { type: String, required: true, index: true },
    data: { type: Schema.Types.Mixed, default: {} },
    customerId: { type: String, default: "" },
    email: { type: String, default: "", index: true },
    status: { type: String, default: "New" },
  },
  { timestamps: true },
);
export const FormEntry = model("FormEntry", formEntrySchema, "form_entries");

/** Demo Practice / Clinic / Physician ids - hidden from finance, never paid. */
const demoAccountSchema = new Schema(
  {
    customerId: { type: String, default: "" },
    email: { type: String, default: "" },
    practiceId: { type: String, default: "" },
    clinicId: { type: String, default: "" },
    doctorId: { type: String, default: "" },
    label: { type: String, default: "" },
  },
  { timestamps: true },
);
export const DemoAccount = model(
  "DemoAccount",
  demoAccountSchema,
  "demo_accounts",
);

/* ---------------------------------------------------------------------------
   Logs. Capped by a TTL index so they never need pruning by hand.
   --------------------------------------------------------------------------- */
const logSchema = new Schema(
  {
    type: { type: String, required: true, index: true }, // customer-tag / sync / webhook / job / email / sms / error
    ref: { type: String, default: "", index: true },
    message: { type: String, default: "" },
    data: { type: Schema.Types.Mixed, default: null },
    ok: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 120 },
  },
  { versionKey: false },
);
export const Log = model("Log", logSchema, "logs");

/** Webhook de-duplication (Shopify re-sends on a slow reply) + a failed-event
 *  list the admin can replay from. */
const webhookEventSchema = new Schema(
  {
    _id: String, // X-Shopify-Webhook-Id
    topic: String,
    ref: String,
    status: { type: String, default: "received" }, // received / done / failed
    error: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 14 },
  },
  { versionKey: false },
);
export const WebhookEvent = model(
  "WebhookEvent",
  webhookEventSchema,
  "webhook_events",
);

/** Short-lived keys: job throttles, "customer already tagged" markers, locks. */
const kvSchema = new Schema(
  {
    _id: String,
    value: { type: Schema.Types.Mixed, default: null },
    expiresAt: { type: Date, default: null, index: { expires: 0 } },
  },
  { versionKey: false },
);
export const Kv = model("Kv", kvSchema, "kv");
