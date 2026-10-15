/* End-to-end smoke test of the server logic against a throw-away in-memory
   MongoDB, with Shopify's Admin API replaced by a stub.

     npm run smoke

   It feeds real webhook-shaped orders through the order pipeline and checks
   the commission split, the payout summary, every dashboard's figures, the
   signed App Proxy access rules, banking encryption and the CSV import. */

import crypto from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";

const SHOP = "smoke-test.myshopify.com";
const SECRET = "smoke-secret";
// a cold first start (binary just downloaded, slow disk) can take a while
const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
Object.assign(process.env, {
  MONGODB_URI: mongo.getUri(),
  MONGODB_DB: "rx_smoke",
  ENCRYPTION_KEY: "smoke-test-encryption-key-0123456789",
  SHOPIFY_API_KEY: "smoke-key",
  SHOPIFY_API_SECRET: SECRET,
  SHOPIFY_APP_URL: "https://rx.example.com",
  SHOPIFY_SHOP: SHOP,
  SCOPES: "read_orders,write_orders,read_customers,write_customers,read_products",
  RX_SCHEDULER: "off",
});

/* ---------------------------- Shopify stub ------------------------------ */
const calls = [];
const customerTags = { 501: [], 502: [] };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  if (!url.includes(SHOP)) {
    if (url.includes("api.brevo.com") || url.includes("tinyurl.com")) throw new Error("no outbound email/SMS in the smoke test");
    return realFetch(input, init);
  }
  if (url.includes("/oauth/")) {
    return Response.json({ access_token: "stub", scope: process.env.SCOPES, expires_in: 86400, refresh_token: "r", refresh_token_expires_in: 8640000 });
  }
  const body = JSON.parse(init.body || (await input.text?.()) || "{}");
  const op = (/(?:query|mutation)\s+(\w+)/.exec(body.query) || [])[1] || "anonymous";
  const v = body.variables || {};
  calls.push(op);
  const id = (g) => String(g || "").split("/").pop();
  const data = {
    RxCustomerTags: () => ({ customer: { id: v.id, tags: customerTags[id(v.id)] || [] } }),
    RxCustomerTagsSet: () => {
      customerTags[id(v.input.id)] = v.input.tags;
      return { customerUpdate: { customer: { id: v.input.id, tags: v.input.tags }, userErrors: [] } };
    },
    RxOrderTags: () => ({ orderUpdate: { order: { id: v.input.id, tags: v.input.tags }, userErrors: [] } }),
    RxTagsAdd: () => ({ tagsAdd: { userErrors: [] } }),
    RxMetafieldsSet: () => ({ metafieldsSet: { metafields: [], userErrors: [] } }),
    RxCustomers: () => ({ customers: { nodes: [] } }),
    RxLegacyBanking: () => ({ metaobjectByHandle: null }),
  }[op];
  return Response.json({ data: data ? data() : {} });
};

/* ------------------------------ helpers --------------------------------- */
let passed = 0;
const failures = [];
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
function check(name, actual, expected) {
  const ok = typeof expected === "number" ? near(actual, expected) : actual === expected;
  if (ok) passed++;
  else failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const { connectDb } = await import("../app/db.server.js");
const M = await import("../app/models/index.server.js");
const { sessionStorage } = await import("../app/shopify.server.js");
const { Session } = await import("@shopify/shopify-api");
const orders = await import("../app/services/orders.server.js");
const { practiceDashboard, practicePeriodOrders } = await import("../app/services/dashboards/practice.server.js");
const { physicianDashboard } = await import("../app/services/dashboards/physician.server.js");
const { clinicDashboard } = await import("../app/services/dashboards/clinic.server.js");
const { repDashboard } = await import("../app/services/dashboards/rep.server.js");
const { financeDashboard, setPayoutStatus } = await import("../app/services/dashboards/finance.server.js");
const { loadBanking, saveBanking } = await import("../app/services/banking.server.js");
const { importCsv } = await import("../app/services/import.server.js");
const rx = await import("../app/services/prescriptions.server.js");
const { handleProxy } = await import("../app/api/index.server.js");
const { nextId } = await import("../app/services/provisioning.server.js");

await connectDb();
await sessionStorage.storeSession(
  new Session({
    id: `offline_${SHOP}`,
    shop: SHOP,
    state: "",
    isOnline: false,
    accessToken: "stub",
    scope: process.env.SCOPES,
    expires: new Date(Date.now() + 86400000),
  }),
);

/* -------------------------------- seed ---------------------------------- */
const acct = (customerId, role, o) =>
  M.Account.create({ customerId, role, wholesale: true, first: role, last: customerId, email: `${customerId}@example.com`, ...o });
await acct("900", "Practice", { practiceId: "PRA1", company: "Hill Country Practice", tags: ["practice_id:PRA1", "wholesale"] });
await acct("901", "Clinic", { practiceId: "PRA1", clinicId: "CLN1", clinicIds: ["CLN1"], company: "North Clinic", tags: ["clinic_id:CLN1", "practice_id:PRA1", "wholesale"] });
await acct("902", "Physician", { practiceId: "PRA1", clinicId: "CLN1", clinicIds: ["CLN1"], doctorId: "DOC1", tags: ["doctor_id:DOC1", "clinic_id:CLN1", "practice_id:PRA1", "wholesale"] });
await acct("903", "Physician", { practiceId: "PRA1", clinicId: "CLN1", clinicIds: ["CLN1"], doctorId: "DOC2", tags: ["doctor_id:DOC2", "clinic_id:CLN1", "practice_id:PRA1", "wholesale"] });
await acct("909", "Practice + Doctor", { practiceId: "PRA9", clinicId: "CLN9", clinicIds: ["CLN9"], doctorId: "DOC9", tags: ["doctor_id:DOC9", "clinic_id:CLN9", "practice_id:PRA9", "wholesale"] });
await M.Account.create({ customerId: "950", role: "Sales Rep", repId: "RAP1", first: "Sally", last: "Rep", email: "sally@example.com", tags: ["rep_id:RAP1", "wholesale_rep"] });
await M.SalesRep.create({ repId: "RAP1", name: "Sally Rep", assignedPracticeIds: ["PRA1"] });
await M.Product.create({ productId: "100", title: "Omega XP", status: "ACTIVE", price: 100, wholesale: 40, physicianCommission: 10, clinicCommission: 5, variants: [{ variantId: "1", price: 100 }] });

const created = new Date(Date.now() - 3600_000);
await M.Prescription.create({
  rxId: "RX-1", patientId: "PT-1", first: "Pat", last: "Ient", email: "pat@example.com", physician: "Dr One - North Clinic",
  doctorId: "DOC1", clinicId: "CLN1", practiceId: "PRA1", items: "Omega XP ×2 (One time)", total: "$200.00",
  link: "https://example.com/cart", status: "Sent", confirmed: true, createdAt: created,
});
await M.Prescription.create({
  rxId: "RX-2", patientId: "PT-2", first: "Open", last: "Case", email: "open@example.com", physician: "Dr One",
  doctorId: "DOC1", clinicId: "CLN1", practiceId: "PRA1", items: "Omega XP (Monthly)", total: "$100.00", status: "Sent",
});

const now = new Date().toISOString();
const orderA = {
  id: 1001, name: "#1001", email: "pat@example.com", created_at: now, financial_status: "paid", fulfillment_status: null,
  tags: "", currency: "USD", total_price: "212.00", subtotal_price: "200.00",
  note_attributes: [{ name: "Rx ID", value: "RX-1" }],
  customer: { id: 501, first_name: "Pat", last_name: "Ient", email: "pat@example.com", tags: "" },
  line_items: [{ id: 1, product_id: 100, variant_id: 1, title: "Omega XP", quantity: 2, price: "100.00", properties: [] }],
  fulfillments: [],
};
// a solo physician's order placed from the product page (ids are line item properties)
const orderB = {
  id: 1002, name: "#1002", email: "solo-patient@example.com", created_at: now, financial_status: "paid", fulfillment_status: null,
  tags: "", currency: "USD", total_price: "100.00", subtotal_price: "100.00", note_attributes: [],
  customer: { id: 502, first_name: "Solo", last_name: "Patient", email: "solo-patient@example.com", tags: "" },
  line_items: [{ id: 2, product_id: 100, variant_id: 1, title: "Omega XP", quantity: 1, price: "100.00",
    properties: [{ name: "Doctor ID", value: "DOC9" }, { name: "Practice ID", value: "PRA9" }, { name: "Patient ID", value: "ANON-77" }] }],
  fulfillments: [],
};
// an ordinary store order with no portal ids at all
const orderC = { ...orderB, id: 1003, name: "#1003", customer: null, email: "walkin@example.com",
  line_items: [{ id: 3, product_id: 100, title: "Omega XP", quantity: 1, price: "100.00", properties: [] }] };

/* ------------------------------ pipeline -------------------------------- */
const resA = await orders.processOrder(orderA, { source: "smoke" });
check("order A logged", resA.logged, true);
await orders.processOrder(orderA, { source: "smoke" }); // webhook re-delivery
await orders.processOrder(orderB, { source: "smoke" });
const resC = await orders.processOrder(orderC, { source: "smoke" });
check("order C is not an Rx order", /not an rx order/.test(resC.skipped || ""), true);

const a = await M.Order.findOne({ orderId: "1001" }).lean();
check("A doctor id (from the prescription)", a.doctorId, "DOC1");
check("A doctor amount", a.commission.doctorAmt, 20);
check("A clinic amount", a.commission.clinicAmt, 10);
check("A practice amount", a.commission.practiceAmt, 90);
check("A rep", a.commission.repId, "RAP1");
check("A rep amount", a.commission.repAmt, 2);
check("A tagged rx", a.tags.includes("rx") && a.tags.includes("doctor_id:DOC1") && a.tags.includes("rx_id:RX-1"), true);
check("A tagged only once", calls.filter((c) => c === "RxOrderTags").length, 2); // A + B, not the re-delivery
check("patient customer tagged", (customerTags[501] || []).includes("doctor_id:DOC1"), true);
check("prescription closed", (await M.Prescription.findOne({ rxId: "RX-1" }).lean()).status, "Purchased");

const b = await M.Order.findOne({ orderId: "1002" }).lean();
check("B is solo", b.commission.solo, true);
check("B doctor gets the whole margin", b.commission.doctorAmt, 60);
check("B practice amount", b.commission.practiceAmt, 0);

const payout = async (role, id) => (await M.MonthlyPayout.findOne({ role, entityId: id }).lean())?.amount;
check("payout: practice gets one combined row", await payout("Practice", "PRA1"), 120);
check("payout: no separate doctor row inside a practice", await payout("Doctor", "DOC1"), undefined);
check("payout: solo doctor", await payout("Doctor", "DOC9"), 60);
check("payout: rep", await payout("Rep", "RAP1"), 2);

/* ------------------------------ dashboards ------------------------------ */
const pd = await practiceDashboard({ practice: "PRA1" });
check("practice: ok", pd.ok, true);
check("practice: sales", pd.sales.allTime, 200);
check("practice: practice commission", pd.practiceCommissionTotal, 90);
check("practice: physician commission", pd.physicianCommissionTotal, 20);
check("practice: clinic listed", pd.clinics.find((c) => c.id === "CLN1")?.name, "North Clinic");
check("practice: both doctors listed", pd.clinics.find((c) => c.id === "CLN1").doctors.length, 2);
check("practice: open prescription counted", pd.totalPrescriptions, 2);
check("practice: open this month", pd.commission.open, 120);
check("practice: csv rows", (await practicePeriodOrders("PRA1", 0, 0)).totals.total, 120);

const ph = await physicianDashboard({ doctor: "DOC1", practice: "PRA1" });
check("physician: not solo", ph.solo, false);
check("physician: own earnings only", ph.commission.total, 20);
check("physician: recent rows (1 order + 1 open)", ph.recent.length, 2);
const solo = await physicianDashboard({ doctor: "DOC9", practice: "PRA9" });
check("solo physician: solo", solo.solo, true);
check("solo physician: full margin", solo.commission.total, 60);
check("solo physician: payment history", solo.payouts[0]?.amount, 60);

const cd = await clinicDashboard({ clinic: "CLN1" });
check("clinic: clinic earnings", cd.commission.total, 10);
check("clinic: doctors seeded", cd.doctors.length, 2);

const rd = await repDashboard({ rep: "RAP1" });
check("rep: ok", rd.ok, true);
check("rep: orders", rd.totals.orders, 1);
check("rep: commission", rd.commission.total, 2);
check("rep: practice row", rd.practices[0]?.id, "PRA1");

const fd = await financeDashboard({});
check("finance: commission pool", fd.totals.revenueAllTime, 180);
check("finance: practice owed", fd.commission.practiceTotal, 120);
check("finance: physician owed", fd.commission.physicianTotal, 60);
check("finance: rep owed", fd.commission.repTotal, 2);
check("finance: store orders incl. non-Rx", fd.totals.shopifyOrdersCount, 3);

const month = (await M.MonthlyPayout.findOne({ role: "Practice" }).lean()).month;
check("finance: mark paid", (await setPayoutStatus({ month, role: "Practice", id: "PRA1", status: "Paid", datePaid: "2026-10-14", confirmationNum: "TX1" })).ok, true);
check("practice sees it paid", (await practiceDashboard({ practice: "PRA1" })).commission.paid, 120);

/* ------------------------- signed App Proxy calls ----------------------- */
function proxyRequest(resource, params, customerId, body) {
  const q = { ...params, shop: SHOP, path_prefix: "/apps/rx", timestamp: String(Math.floor(Date.now() / 1000)) };
  if (customerId) q.logged_in_customer_id = customerId;
  const message = Object.keys(q).sort().map((k) => `${k}=${q[k]}`).join("");
  q.signature = crypto.createHmac("sha256", SECRET).update(message).digest("hex");
  const url = `https://rx.example.com/proxy/${resource}?${new URLSearchParams(q)}`;
  return new Request(url, body ? { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(body) } : {});
}
const call = async (...args) => (await handleProxy(proxyRequest(...args), args[0])).json();

check("proxy: practice master allowed", (await call("practice", { action: "dashboard", practice: "PRA1" }, "900")).ok, true);
check("proxy: other practice refused", (await call("practice", { action: "dashboard", practice: "PRA1" }, "909")).ok, false);
check("proxy: logged-out refused", (await call("practice", { action: "dashboard", practice: "PRA1" }, "")).ok, false);
check("proxy: doctor sees own dashboard", (await call("physician", { action: "dashboard", doctor: "DOC1", practice: "PRA1" }, "902")).ok, true);
check("proxy: doctor cannot see a colleague", (await call("physician", { action: "dashboard", doctor: "DOC2", practice: "PRA1" }, "902")).ok, false);
check("proxy: practice master may drill into its doctor", (await call("practice", { action: "dashboard", doctor: "DOC2" }, "900")).ok, true);
check("proxy: doctor cannot open the practice dashboard", (await call("practice", { action: "dashboard", practice: "PRA1" }, "902")).ok, false);
check("proxy: doctor cannot open the clinic dashboard", (await call("clinic", { action: "dashboard", clinic: "CLN1" }, "902")).ok, false);
check("proxy: doctor cannot read practice banking", !!(await call("practice", { action: "load", practice_id: "PRA1" }, "902")).error, true);
check("proxy: clinic account sees its dashboard", (await call("clinic", { action: "dashboard", clinic: "CLN1" }, "901")).ok, true);
check("proxy: clinic account may view its own doctor", (await call("practice", { action: "dashboard", doctor: "DOC1" }, "901")).ok, true);
check("proxy: clinic account cannot open the practice", (await call("practice", { action: "dashboard", practice: "PRA1" }, "901")).ok, false);
check("proxy: solo owner sees own practice", (await call("practice", { action: "dashboard", practice: "PRA9" }, "909")).ok, true);
check("proxy: solo owner reads own banking", (await call("practice", { action: "load", practice_id: "PRA9" }, "909")).found, false);
check("proxy: member may read practice info", (await call("physician", { action: "practiceInfo", practice: "PRA1" }, "902")).physicianCount, 2);
check("proxy: doctor writes an Rx under own ids", (await call("builder", {}, "902", { action: "confirm", rxId: "RX-9", doctorId: "DOC1", clinicId: "CLN1", practiceId: "PRA1", first: "A", email: "a@example.com" })).ok, true);
check("proxy: doctor cannot write an Rx as a colleague", (await call("builder", {}, "902", { action: "confirm", rxId: "RX-10", doctorId: "DOC2", clinicId: "CLN1", practiceId: "PRA1" })).ok, false);
check("proxy: patient account cannot write an Rx", (await call("builder", {}, "501", { action: "confirm", rxId: "RX-11" })).ok, false);
check("proxy: rep sees own", (await call("rep", { action: "repdash", rep: "RAP1" }, "950")).ok, true);
check("proxy: finance refused for a rep", (await call("finance", { action: "admindash" }, "950")).ok, false);
check("proxy: clinic name is public (storefront bar)", (await call("physician", { action: "clinicName", clinic: "CLN1" }, "")).clinicName, "North Clinic");
check("proxy: physician list is public and has no email", (await (await handleProxy(proxyRequest("physicians", { action: "customers" }, ""), "physicians")).json()).some((c) => "email" in c), false);
check("proxy: cart tracking is open", (await call("cart", {}, "", { action: "track", rxId: "RX-2", event: "opened" })).ok, true);
check("cart tracking moved the status", (await M.Prescription.findOne({ rxId: "RX-2" }).lean()).status, "Opened");
let badSig = 200;
try {
  const res = await handleProxy(new Request(`https://rx.example.com/proxy/practice?action=ping&shop=${SHOP}&signature=bad&timestamp=1`), "practice");
  badSig = res.status;
} catch (e) {
  badSig = e instanceof Response ? e.status : 500;
}
check("proxy: bad signature rejected", badSig >= 400, true);

/* ------------------------- builder / banking / misc --------------------- */
const confirm = await rx.confirmRx({ rxId: "RX-3", clientType: "existing", customerId: "501", first: "New", email: "new@example.com", doctorId: "DOC1", clinicId: "CLN1", practiceId: "PRA1", items: "Omega XP", total: "100" });
check("confirmRx saved", confirm.saved, true);
check("confirmRx is idempotent", (await rx.confirmRx({ rxId: "RX-3" })).saved, false);
check("send without Brevo reports failure", (await rx.sendRx({ rxId: "RX-3", channel: "email", email: "new@example.com" })).ok, false);
check("whatsapp send marks Sent", (await rx.sendRx({ rxId: "RX-3", channel: "whatsapp" })).ok && (await M.Prescription.findOne({ rxId: "RX-3" }).lean()).status, "Sent");

const saved = await saveBanking("practice", "PRA1", [{ key: "bank_name", value: "First Bank" }, { key: "bank_holder_account_number", value: "000123456789" }, { key: "not_allowed", value: "x" }], "900", { lock: false });
check("banking saved", saved.ok, true);
const raw = await M.Banking.findOne({ ownerType: "practice", ownerId: "PRA1" }).lean();
check("banking is encrypted at rest", raw.data.includes("000123456789"), false);
const loaded = await loadBanking("practice", "PRA1");
check("banking round-trips", loaded.fields.bank_holder_account_number, "000123456789");
check("banking drops unknown keys", loaded.fields.not_allowed, undefined);

check("id generator continues from existing ids", await nextId("PRA"), "PRA10");
const imp = await importCsv("monthlyPayouts", "Month,Role,ID,Amount,Status,Date Paid,Transaction #\n2026-08,Practice,PRA7,\"$1,250.50\",Paid,2026-09-05,TX9\n2026-08,Practice,PRA7,49.50,Paid,,\n");
check("csv import merges split months", imp.ok && (await payout("Practice", "PRA7")), 1300);

/* ----------------------------- order deleted ---------------------------- */
await orders.processOrderDelete({ id: 1001 });
check("delete reverses the practice payout", await payout("Practice", "PRA1"), 0);
check("delete reverses the rep payout", await payout("Rep", "RAP1"), 0);
check("deleted order leaves the ledger", (await financeDashboard({})).totals.revenueAllTime, 60);
await orders.processOrderDelete({ id: 1001 }); // repeat delivery
check("second delete is a no-op", await payout("Practice", "PRA1"), 0);

/* -------------------------------- result -------------------------------- */
console.log(`\n${passed} checks passed, ${failures.length} failed`);
for (const f of failures) console.log("  FAIL  " + f);
const mongoose = (await import("../app/db.server.js")).default;
await mongoose.disconnect();
await mongo.stop();
process.exit(failures.length ? 1 : 0);
