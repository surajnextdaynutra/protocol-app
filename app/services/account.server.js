import { connectDb } from "../db.server";
import { Order } from "../models/index.server";
import { gid, gql } from "./shopify-admin.server";

/* My Account (was "Account Settings API" + the getAccount / updateAccount
   actions duplicated in the dashboard scripts). Always acts on the logged-in
   customer Shopify identified - never on an id sent by the page. */

const ADDRESS_FIELD_LABELS = {
  company: "Clinic / Business Name",
  address1: "Address Line 1",
  address2: "Address Line 2",
  city: "City",
  province: "State / Province",
  zip: "ZIP / Postal Code",
  country: "Country",
};

/** Shopify's address errors ("Province is invalid") turned into one plain
 *  line naming the fields to fix. */
function addressErrorMessage(userErrors) {
  const labels = [];
  for (const e of userErrors) {
    const key = (e.field || [])[(e.field || []).length - 1];
    const label = ADDRESS_FIELD_LABELS[key] || "Address";
    if (!labels.includes(label)) labels.push(label);
  }
  const which = labels.length ? labels.join(", ") : "your Shipping Address";
  return (
    `Your Shipping Address looks incomplete or incorrect (${which}). ` +
    "Please double check that City, State/Province, and Country are spelled correctly and match a real location."
  );
}

/** Placed through the wholesale order page? Its "Wholesale Role" attribute or
 *  any of the wholesale tags / ids marks it. */
const isWholesaleOrder = (o) =>
  !!(o.wholesaleRole || o.wsDoctorId || o.wsClinicId || o.wsPracticeId);

function orderRow(o) {
  const items = (o.lineItems || []).map((li) => ({ title: li.title || "", qty: li.quantity || 1 }));
  return {
    name: o.name || "",
    date: o.orderCreatedAt ? o.orderCreatedAt.toISOString() : "",
    financialStatus: String(o.financialStatus || "").toUpperCase(),
    fulfillmentStatus: String(o.fulfillmentStatus || "UNFULFILLED").toUpperCase(),
    units: items.reduce((s, li) => s + li.qty, 0),
    total: o.total || 0,
    currency: o.currency || "USD",
    items,
  };
}

/** The customer's own orders, newest first. */
export async function orderHistory(customerId, { limit = 20, wholesaleOnly = false } = {}) {
  await connectDb();
  const q = { "customer.id": String(customerId), deletedAt: null };
  if (wholesaleOnly) {
    q.$or = [
      { wholesaleRole: { $ne: "" } },
      { wsDoctorId: { $ne: "" } },
      { wsClinicId: { $ne: "" } },
      { wsPracticeId: { $ne: "" } },
    ];
  }
  const rows = await Order.find(q).sort({ orderCreatedAt: -1 }).limit(Math.min(100, limit)).lean();
  return { ok: true, orders: rows.filter((o) => !wholesaleOnly || isWholesaleOrder(o)).map(orderRow) };
}

export async function getAccount(customerId) {
  if (!customerId) return { ok: false, error: "customerId missing" };
  const data = await gql(
    `#graphql
    query RxAccount($id: ID!) {
      customer(id: $id) {
        firstName lastName email phone
        defaultAddress { id company address1 address2 city province zip country }
      }
    }`,
    { id: gid.customer(customerId) },
  );
  const c = data.customer;
  if (!c) return { ok: false, error: "Customer not found" };
  const a = c.defaultAddress || {};
  return {
    ok: true,
    account: {
      firstName: c.firstName || "",
      lastName: c.lastName || "",
      email: c.email || "",
      phone: c.phone || "",
      addressId: a.id || "",
      company: a.company || "",
      address1: a.address1 || "",
      address2: a.address2 || "",
      city: a.city || "",
      province: a.province || "",
      zip: a.zip || "",
      country: a.country || "",
    },
    // This account's OWN orders = its wholesale orders (patient orders are
    // placed by patient customers).
    orders: (await orderHistory(customerId, { limit: 25 })).orders,
  };
}

/**
 * Saves name / email / phone and the default address. Only the section(s)
 * the page actually sent are touched, so a Personal-only save never blanks
 * the address and vice versa.
 */
export async function updateAccount(customerId, payload) {
  if (!customerId) return { ok: false, error: "customerId missing" };
  const has = (k) => Object.prototype.hasOwnProperty.call(payload, k);
  const touchesPersonal = ["firstName", "lastName", "email", "phone"].some(has);
  const touchesAddress = ["address1", "address2", "city", "province", "zip", "country", "company"].some(has);
  const id = gid.customer(customerId);

  if (touchesPersonal) {
    const missing = [];
    if (!String(payload.firstName || "").trim()) missing.push("First Name");
    if (!String(payload.lastName || "").trim()) missing.push("Last Name");
    if (!String(payload.email || "").trim()) missing.push("Email");
    if (missing.length) return { ok: false, error: "Please fill in: " + missing.join(", ") };
    if (!String(payload.email).includes("@")) {
      return { ok: false, error: "Please enter a valid Email address" };
    }
    const res = await gql(
      `#graphql
      mutation RxAccountUpdate($input: CustomerInput!) {
        customerUpdate(input: $input) { customer { id } userErrors { field message } }
      }`,
      {
        input: {
          id,
          firstName: payload.firstName || "",
          lastName: payload.lastName || "",
          email: payload.email || "",
          phone: payload.phone || null,
        },
      },
    );
    const errs = res.customerUpdate.userErrors;
    if (errs.length) return { ok: false, error: errs.map((e) => e.message).join("; ") };
  }

  if (touchesAddress) {
    const address = {
      company: payload.company || "",
      address1: payload.address1 || "",
      address2: payload.address2 || "",
      city: payload.city || "",
      province: payload.province || "",
      zip: payload.zip || "",
      country: payload.country || "",
    };
    if (payload.addressId) {
      const upd = await gql(
        `#graphql
        mutation RxAddressUpdate($address: MailingAddressInput!, $addressId: ID!, $customerId: ID!) {
          customerAddressUpdate(address: $address, addressId: $addressId, customerId: $customerId) {
            userErrors { field message }
          }
        }`,
        { addressId: payload.addressId, address, customerId: id },
      );
      const errs = upd.customerAddressUpdate.userErrors;
      if (errs.length) return { ok: false, error: addressErrorMessage(errs) };
    } else {
      const created = await gql(
        `#graphql
        mutation RxAddressCreate($customerId: ID!, $address: MailingAddressInput!) {
          customerAddressCreate(customerId: $customerId, address: $address, setAsDefault: true) {
            address { id }
            userErrors { field message }
          }
        }`,
        { customerId: id, address },
      );
      const errs = created.customerAddressCreate.userErrors;
      if (errs.length) return { ok: false, error: addressErrorMessage(errs) };
    }
  }
  return { ok: true };
}
