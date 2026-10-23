import { connectDb } from "../db.server";
import { Order } from "../models/index.server";
import { normalizePhone, validateAddress, validatePersonal } from "./account-validate.server";
import { gid, gql } from "./shopify-admin.server";

/* My Account (was "Account Settings API" + the getAccount / updateAccount
   actions duplicated in the dashboard scripts). Always acts on the logged-in
   customer Shopify identified - never on an id sent by the page. */

const FIELD_LABELS = {
  firstName: "First Name",
  lastName: "Last Name",
  email: "Email",
  phone: "Phone",
  company: "Clinic / Business Name",
  address1: "Address Line 1",
  address2: "Address Line 2",
  city: "City",
  province: "State / Province",
  zip: "ZIP / Postal Code",
  country: "Country",
};
// Shopify's userErrors field names -> the page's data-acct-field keys
const SHOPIFY_FIELD_KEYS = { provinceCode: "province", countryCode: "country", first_name: "firstName", last_name: "lastName" };

/** Shopify userErrors keyed by page field, e.g. { phone: "Phone has already been taken" }.
 *  Errors Shopify doesn't tie to a known field go under fallbackKey. */
function shopifyFieldErrors(userErrors, fallbackKey) {
  const out = {};
  for (const e of userErrors) {
    const path = e.field || [];
    let key = path[path.length - 1];
    key = SHOPIFY_FIELD_KEYS[key] || key;
    if (!FIELD_LABELS[key]) key = fallbackKey;
    if (!out[key]) out[key] = e.message;
  }
  return out;
}

/** { ok:false, error, fieldErrors } - error names every field to fix. */
function fieldFailure(fieldErrors, extra = {}) {
  const labels = Object.keys(fieldErrors).map((k) => FIELD_LABELS[k] || k);
  return {
    ok: false,
    error: `Please fix: ${labels.join(", ")}.`,
    fieldErrors,
    ...extra,
  };
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
  if (!touchesPersonal && !touchesAddress) return { ok: false, error: "Nothing to save - no account fields were sent." };
  const id = gid.customer(customerId);
  const str = (k) => String(payload[k] ?? "").trim();

  // Both sections are checked before either is saved, so one bad field
  // never leaves a half-saved account.
  const fieldErrors = {
    ...(touchesPersonal ? validatePersonal(payload) : {}),
    ...(touchesAddress ? validateAddress(payload) : {}),
  };
  if (Object.keys(fieldErrors).length) return fieldFailure(fieldErrors);

  let personalSaved = false;
  let addressId = String(payload.addressId || "");
  if (touchesPersonal) {
    const res = await gql(
      `#graphql
      mutation RxAccountUpdate($input: CustomerInput!) {
        customerUpdate(input: $input) { customer { id } userErrors { field message } }
      }`,
      {
        input: {
          id,
          firstName: str("firstName"),
          lastName: str("lastName"),
          email: str("email"),
          phone: normalizePhone(str("phone")) || null,
        },
      },
    );
    const errs = res.customerUpdate.userErrors;
    if (errs.length) return fieldFailure(shopifyFieldErrors(errs, "email"));
    personalSaved = true;
  }

  if (touchesAddress) {
    const address = {
      company: str("company"),
      address1: str("address1"),
      address2: str("address2"),
      city: str("city"),
      province: str("province"),
      zip: str("zip"),
      country: str("country"),
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
      if (errs.length) return fieldFailure(shopifyFieldErrors(errs, "address1"), { personalSaved });
    } else if (Object.values(address).some(Boolean)) {
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
      if (errs.length) return fieldFailure(shopifyFieldErrors(errs, "address1"), { personalSaved });
      // the page keeps it, so its next save updates this address instead of adding another
      addressId = created.customerAddressCreate.address?.id || "";
    }
  }
  return { ok: true, addressId };
}
