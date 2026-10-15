import { connectDb } from "../db.server";
import { Order, Prescription, RX_OPEN_STATUSES } from "../models/index.server";
import { fillTemplate, sendEmail, sendSms } from "./brevo.server";
import { recordOrderPayoutIfNew, reverseOrderCommission } from "./commission.server";
import {
  addTag,
  attrIds,
  hasTag,
  isAttributable,
  isDemoIds,
  itemsHaveRealPlan,
  orderAttrs,
  setIdTag,
  tagList,
  tagVal,
  tagsFingerprint,
} from "./ids.server";
import { kvGet, kvSet, logEvent, withLock } from "./log.server";
import { getSettings, isTrue, setSetting } from "./settings.server";
import {
  READ_ONLY,
  addOrderTags,
  escQ,
  getCustomerTags,
  gql,
  gqlAll,
  legacyId,
  searchCustomers,
  setCustomerTags,
  setOrderTags,
} from "./shopify-admin.server";

/* The order pipeline (was Sweep.gs + the webhook half of WebApp.gs).

   Every orders/* webhook lands here. A paid order is copied into MongoDB,
   tagged in Shopify (order + customer), matched to its prescription and has
   its commission split logged - all within about a second of payment. The
   scheduler's `syncRecentOrders` re-runs the same code over the last 30 days
   as a safety net for a missed webhook; every step is idempotent. */

/* ------------------------- delivery status ------------------------------ */

// Ranked worst-to-best so the most-advanced status across fulfillments wins.
const SHIPMENT_STATUS_RANK = [
  "label_printed",
  "label_purchased",
  "attempted_delivery",
  "ready_for_pickup",
  "picked_up",
  "confirmed",
  "in_transit",
  "out_for_delivery",
  "delivered",
];

/** "Not Shipped" (no fulfillment), "Shipped" (no carrier status yet) or the
 *  carrier's own status Title Cased ("In Transit", "Delivered", …). */
export function formatDeliveryStatus(order) {
  const fulfillments = (order?.fulfillments || []).filter(
    (f) => String(f.status || "").toLowerCase() !== "cancelled",
  );
  if (!fulfillments.length) return "Not Shipped";
  const statuses = fulfillments
    .map((f) => String(f.shipment_status || "").toLowerCase())
    .filter(Boolean);
  if (!statuses.length) return "Shipped";
  const best = statuses.sort(
    (a, b) => SHIPMENT_STATUS_RANK.indexOf(b) - SHIPMENT_STATUS_RANK.indexOf(a),
  )[0];
  return best.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const liveFulfillment = (order) =>
  (order?.fulfillments || []).find(
    (x) => String(x.status || "").toLowerCase() !== "cancelled",
  );

/** Raw display status of the first live fulfillment, in Shopify's GraphQL
 *  vocabulary: the carrier status when there is one, else FULFILLED. */
export function fulfillmentDisplayStatus(order) {
  const f = (order?.fulfillments || []).find(
    (x) => String(x.status || "").toLowerCase() !== "cancelled",
  );
  if (!f) return "";
  return f.shipment_status ? String(f.shipment_status).toUpperCase() : "FULFILLED";
}

function trackingUrlOf(order, fulfillment) {
  const pick = (f) => f && (f.tracking_url || (f.tracking_urls && f.tracking_urls[0]));
  if (pick(fulfillment)) return pick(fulfillment);
  const list = order.fulfillments || [];
  for (let i = list.length - 1; i >= 0; i--) if (pick(list[i])) return pick(list[i]);
  return "";
}

/* ------------------------- order -> document ---------------------------- */

const num = (v) => Number(v) || 0;

function refundedTotal(o) {
  let total = 0;
  for (const r of o.refunds || []) {
    for (const t of r.transactions || []) {
      if (t.kind === "refund" && t.status === "success") total += num(t.amount);
    }
  }
  return total;
}

/** The fields of a REST-shaped Shopify order the portal keeps. */
function orderFields(o, ids, demo) {
  const cust = o.customer || {};
  const lineItems = (o.line_items || []).map((li) => {
    const props = {};
    for (const p of li.properties || []) if (p && p.name) props[p.name] = p.value;
    return {
      lineItemId: String(li.id || ""),
      productId: li.product_id ? String(li.product_id) : "",
      variantId: li.variant_id ? String(li.variant_id) : "",
      title: li.title || "",
      variantTitle: li.variant_title || "",
      sku: li.sku || "",
      quantity: li.quantity || 1,
      price: num(li.price),
      totalDiscount: num(li.total_discount),
      sellingPlan: li.selling_plan_allocation?.selling_plan?.name || li.selling_plan_name || "",
      properties: props,
    };
  });
  const tags = tagList(o.tags);
  return {
    name: o.name || "",
    orderCreatedAt: o.created_at ? new Date(o.created_at) : new Date(),
    processedAt: o.processed_at ? new Date(o.processed_at) : null,
    cancelledAt: o.cancelled_at ? new Date(o.cancelled_at) : null,
    email: String(o.email || cust.email || "").toLowerCase(),
    phone: o.phone || "",
    financialStatus: String(o.financial_status || "").toLowerCase(),
    fulfillmentStatus: String(o.fulfillment_status || "").toLowerCase(),
    deliveryStatus: formatDeliveryStatus(o),
    fulfillmentDisplay: fulfillmentDisplayStatus(o),
    trackingUrl: trackingUrlOf(o),
    trackingCompany: liveFulfillment(o)?.tracking_company || "",
    estimatedDeliveryAt: liveFulfillment(o)?.estimated_delivery_at
      ? new Date(liveFulfillment(o).estimated_delivery_at)
      : null,
    currency: o.currency || "USD",
    subtotal: num(o.current_subtotal_price ?? o.subtotal_price),
    totalDiscounts: num(o.current_total_discounts ?? o.total_discounts),
    totalShipping: num(o.total_shipping_price_set?.shop_money?.amount),
    totalTax: num(o.current_total_tax ?? o.total_tax),
    total: num(o.current_total_price ?? o.total_price),
    totalRefunded: refundedTotal(o),
    tags,
    noteAttributes: orderAttrs(o),
    isRx: isAttributable(ids),
    rxId: ids.rxId,
    patientId: ids.patientId,
    doctorId: ids.doctorId,
    clinicId: ids.clinicId,
    practiceId: ids.practiceId,
    wholesaleRole: ids.wholesaleRole,
    wsDoctorId: ids.wsDoctorId,
    wsClinicId: ids.wsClinicId,
    wsPracticeId: ids.wsPracticeId,
    subscription:
      !!ids.subscription || lineItems.some((li) => !!li.sellingPlan) || hasTag(tags, "subscription"),
    demo,
    customer: {
      id: cust.id ? String(cust.id) : "",
      first: cust.first_name || "",
      last: cust.last_name || "",
      email: String(cust.email || "").toLowerCase(),
      phone: cust.phone || "",
      tags: tagList(cust.tags),
    },
    shippingAddress: o.shipping_address || null,
    lineItems,
    units: lineItems.reduce((n, li) => n + li.quantity, 0),
  };
}

/** The buyer's tags: from the payload when Shopify sent them, otherwise one
 *  lookup (only needed for the id-less "Buy again" fallback). */
async function buyerTags(o) {
  const cust = o.customer;
  if (!cust?.id) return [];
  if (cust.tags != null) return tagList(cust.tags);
  try {
    return (await getCustomerTags(cust.id)) || [];
  } catch {
    return [];
  }
}

/**
 * Upserts one order into MongoDB. Line items that already carry a frozen
 * commission split keep it - a later webhook must not zero them.
 */
async function saveOrder(o, ids, demo) {
  await connectDb();
  const fields = orderFields(o, ids, demo);
  const existing = await Order.findOne(
    { orderId: String(o.id) },
    { lineItems: 1, commission: 1 },
  ).lean();
  if (existing?.commission?.logged) {
    const byId = new Map(existing.lineItems.map((li) => [li.lineItemId, li]));
    fields.lineItems = fields.lineItems.map((li) => {
      const old = byId.get(li.lineItemId);
      return old
        ? {
            ...li,
            doctorAmt: old.doctorAmt,
            clinicAmt: old.clinicAmt,
            practiceAmt: old.practiceAmt,
            physicianRate: old.physicianRate,
            clinicRate: old.clinicRate,
            wholesale: old.wholesale,
          }
        : li;
    });
  }
  return Order.findOneAndUpdate(
    { orderId: String(o.id) },
    { $set: fields, $setOnInsert: { orderId: String(o.id) } },
    { upsert: true, new: true },
  ).lean();
}

/* ------------------------------ tagging --------------------------------- */

/**
 * Tags a paid Shopify order with rx / rx_id / patient_id / doctor_id /
 * clinic_id / practice_id (+ subscription, wholesale markers, rx_demo). Each
 * id prefix is REPLACED, never appended. Never writes a rep_id: tag - rep
 * attribution comes from the SalesRep assignment, not a tag. Returns true on
 * success or when already fully tagged.
 */
export async function tagRxOrder(o, ids, demo) {
  try {
    if (!o?.id) return false;
    const tags = tagList(o.tags);
    const before = tagsFingerprint(tags);

    addTag(tags, "rx");
    setIdTag(tags, "rx_id:", ids.rxId);
    setIdTag(tags, "patient_id:", ids.patientId);
    setIdTag(tags, "doctor_id:", ids.doctorId);
    setIdTag(tags, "clinic_id:", ids.clinicId);
    setIdTag(tags, "practice_id:", ids.practiceId);
    if (ids.subscription) addTag(tags, "subscription");

    // Extra role marker for a wholesale-page order - additional to, never a
    // replacement for, the id tags.
    if (ids.wholesaleRole === "clinic") addTag(tags, "clinicwholesale");
    else if (ids.wholesaleRole === "practice") addTag(tags, "practicewholesale");
    else if (ids.wholesaleRole === "physician") addTag(tags, "physicianwholesale");

    if (demo) addTag(tags, "rx_demo");

    // Wholesale-page ids get their OWN prefix so the order stays out of the
    // clinical dashboards' plain doctor_id:/clinic_id:/practice_id: totals.
    setIdTag(tags, "wholesale_doctor_id:", ids.wsDoctorId);
    setIdTag(tags, "wholesale_clinic_id:", ids.wsClinicId);
    setIdTag(tags, "wholesale_practice_id:", ids.wsPracticeId);

    if (tagsFingerprint(tags) === before) return true;
    const saved = await setOrderTags(o.id, tags);
    o.tags = saved.join(", ");
    await Order.updateOne({ orderId: String(o.id) }, { $set: { tags: saved } });
    return true;
  } catch (err) {
    logEvent("error", o?.name || o?.id, "tagRxOrder: " + err, null, false);
    return false;
  }
}

/** True when doctor_id:<id> is currently on some OTHER customer. Fails open. */
async function doctorIdBelongsToAnotherCustomer(newDoctorId, thisCustomerId) {
  try {
    const list = await searchCustomers(`tag:'doctor_id:${escQ(newDoctorId)}'`, 10);
    return list.some((c) => String(c.id) !== String(thisCustomerId));
  } catch {
    return false;
  }
}

/**
 * Tags the CUSTOMER with the same ids so Shopify admin can segment patients
 * by physician / clinic. Each id prefix is replaced. Guards:
 *  - Practice Master (clinic_id/practice_id present, no doctor_id) never gets
 *    a doctor_id written back on.
 *  - An existing doctor_id is never changed to one that already belongs to a
 *    different customer.
 *  - A demo order never re-tags the buyer's real record.
 * Every actual change is written to the customer tag log.
 */
export async function tagRxCustomer(o, ids, demo) {
  try {
    const customerId = o.customer?.id;
    if (!customerId) return false;
    if (!ids.doctorId && !ids.patientId && !ids.clinicId && !ids.practiceId) return true;
    if (demo) return true;

    const doneKey =
      "rxcust:" + customerId + ":" +
      [ids.doctorId, ids.patientId, ids.clinicId, ids.practiceId].join("|");
    if (await kvGet(doneKey)) return true;

    const current = await getCustomerTags(customerId);
    if (!current) return false;
    const tags = tagList(current);
    const original = tags.slice();
    const before = tagsFingerprint(tags);

    const currentDoctorId = tagVal(tags, "doctor_id:");
    const hasPracticeOrClinic = tags.some((t) => {
      const tl = t.toLowerCase();
      return tl.startsWith("practice_id:") || tl.startsWith("clinic_id:");
    });
    const isPracticeMasterShaped = !currentDoctorId && hasPracticeOrClinic;
    const isDoctorIdChanging =
      currentDoctorId &&
      ids.doctorId &&
      currentDoctorId.toLowerCase() !== ids.doctorId.toLowerCase();
    const collision =
      isDoctorIdChanging &&
      (await doctorIdBelongsToAnotherCustomer(ids.doctorId, customerId));

    addTag(tags, "rx");
    if (ids.patientId) addTag(tags, "patient");
    if (isPracticeMasterShaped && ids.doctorId) {
      logEvent("customer-tag", customerId, `blocked doctor_id:${ids.doctorId} (Practice Master guard, order ${o.id})`);
    } else if (collision) {
      logEvent("customer-tag", customerId, `BLOCKED doctor_id change ${currentDoctorId} -> ${ids.doctorId} - already belongs to another customer (order ${o.id})`);
    } else {
      setIdTag(tags, "doctor_id:", ids.doctorId);
    }
    setIdTag(tags, "patient_id:", ids.patientId);
    setIdTag(tags, "clinic_id:", ids.clinicId);
    setIdTag(tags, "practice_id:", ids.practiceId);

    if (tagsFingerprint(tags) === before) {
      await kvSet(doneKey, 1, 21600);
      return true;
    }

    let ok = true;
    try {
      await setCustomerTags(customerId, tags);
      await kvSet(doneKey, 1, 21600);
    } catch {
      ok = false;
    }
    logEvent(
      "customer-tag",
      customerId,
      `order ${o.name || o.id}`,
      { orderId: String(o.id), before: original, after: tags },
      ok,
    );
    return ok;
  } catch (err) {
    logEvent("error", o?.name || o?.id, "tagRxCustomer: " + err, null, false);
    return false;
  }
}

/* ------------------------- prescription match --------------------------- */

/**
 * Closes the prescription a paid order fulfils. Priority:
 *   1) the order's exact Rx ID
 *   2) same Patient ID note attribute, prescription created before the order
 *   3) same customer email, prescription created before the order
 * A prescription already tied to another order is never taken again.
 * Returns the prescription (lean) or null.
 */
async function closePrescription(o, ids) {
  await connectDb();
  const paidAt = o.created_at ? new Date(o.created_at) : new Date();
  const set = {
    status: "Purchased",
    purchasedAt: paidAt,
    orderName: o.name || "",
    orderId: String(o.id),
  };
  const attrs = orderAttrs(o);

  if (attrs["Rx ID"]) {
    const rx = await Prescription.findOneAndUpdate(
      { rxId: String(attrs["Rx ID"]).trim() },
      { $set: set },
      { new: true },
    ).lean();
    if (rx) return rx;
  }
  const already = await Prescription.findOne({ orderId: String(o.id) }).lean();
  if (already) return already;

  const open = { status: { $in: RX_OPEN_STATUSES }, createdAt: { $lte: paidAt } };
  const patientId = String(attrs["Patient ID"] || "").trim();
  if (patientId) {
    const rx = await Prescription.findOneAndUpdate(
      { ...open, patientId },
      { $set: set },
      { new: true, sort: { createdAt: 1 } },
    ).lean();
    if (rx) return rx;
  }
  const email = String(o.email || "").toLowerCase();
  if (email && !isAttributable(ids)) {
    // weakest match - only for an order that carries no ids of its own
    return Prescription.findOneAndUpdate(
      { ...open, email },
      { $set: set },
      { new: true, sort: { createdAt: 1 } },
    ).lean();
  }
  return null;
}

/** Ids for tagging: the prescription's own ids win over a weak order match. */
function mergeRxIds(ids, rx) {
  if (!rx) return ids;
  return {
    ...ids,
    rxId: ids.rxId || rx.rxId,
    patientId: ids.patientId || rx.patientId,
    doctorId: ids.doctorId || rx.doctorId,
    clinicId: ids.clinicId || rx.clinicId,
    practiceId: ids.practiceId || rx.practiceId,
    subscription: ids.subscription || itemsHaveRealPlan(rx.items),
  };
}

/**
 * Ids already stamped on the order as tags fill any gap. An rx-builder order
 * carries only "Rx ID" as an attribute - its doctor / clinic / practice came
 * from the prescription - so an order tagged before this app existed has
 * those ids nowhere else.
 */
function mergeTagIds(ids, tags) {
  const list = tagList(tags);
  const fill = (key, prefix) => {
    if (!ids[key]) ids[key] = tagVal(list, prefix);
  };
  fill("rxId", "rx_id:");
  fill("patientId", "patient_id:");
  fill("doctorId", "doctor_id:");
  fill("clinicId", "clinic_id:");
  fill("practiceId", "practice_id:");
  fill("wsDoctorId", "wholesale_doctor_id:");
  fill("wsClinicId", "wholesale_clinic_id:");
  fill("wsPracticeId", "wholesale_practice_id:");
  if (!ids.wholesaleRole) {
    if (hasTag(list, "clinicwholesale")) ids.wholesaleRole = "clinic";
    else if (hasTag(list, "practicewholesale")) ids.wholesaleRole = "practice";
    else if (hasTag(list, "physicianwholesale")) ids.wholesaleRole = "physician";
  }
  return ids;
}

/* ------------------------------- SMS ------------------------------------ */

function contactOf(order) {
  const attr = orderAttrs(order);
  const cust = order.customer || {};
  const ship = order.shipping_address || {};
  const bill = order.billing_address || {};
  return {
    digits: String(
      order.phone || cust.phone || attr["Patient Phone"] || ship.phone || bill.phone || "",
    ).replace(/[^0-9]/g, ""),
    firstName:
      String(
        attr["Patient First Name"] || cust.first_name || ship.first_name || bill.first_name || "",
      ).trim() || "there",
  };
}

/** Go-live cutoff for the order-paid SMS: the configured date, else captured
 *  the first time the feature runs so the backlog never gets a message. */
async function paidSmsSince(cfg) {
  const startAt = String(cfg.ORDER_PAID_SMS_START_AT || "").trim();
  if (startAt && !isNaN(Date.parse(startAt))) return Date.parse(startAt);
  const stored = Number(cfg.ORDER_PAID_SMS_SINCE);
  if (stored > 0) return stored;
  const since = Date.now() - 120000; // 2-min grace for processing lag
  await setSetting("ORDER_PAID_SMS_SINCE", String(since));
  return since;
}

/**
 * "We've received your order" SMS for EVERY paid order with a phone, Rx or
 * not. Sent exactly once: claimed on the order document first, and mirrored
 * as the paid_sms_sent order tag.
 */
export async function sendOrderPaidSms(o) {
  try {
    if (!o?.id) return;
    if (hasTag(o.tags, "paid_sms_sent")) return;
    const cfg = await getSettings();
    if (READ_ONLY || isTrue(cfg.SMS_DISABLED) || !cfg.BREVO_API_KEY) return;
    if (!isTrue(cfg.ORDER_PAID_SMS_ENABLED || "TRUE")) return;
    const bodyTpl = String(cfg.ORDER_PAID_BODY || "").trim();
    if (!bodyTpl) return;

    const createdMs = o.created_at ? new Date(o.created_at).getTime() : 0;
    if (createdMs && createdMs < (await paidSmsSince(cfg))) return;

    const { digits, firstName } = contactOf(o);
    if (!digits) return;

    const claimed = await Order.updateOne(
      { orderId: String(o.id), "sms.paidSentAt": { $exists: false } },
      { $set: { "sms.paidSentAt": new Date() } },
    );
    if (!claimed.modifiedCount) return;

    await sendSms(
      digits,
      fillTemplate(bodyTpl, { name: firstName, "order-number": o.name || "" }),
    );
    addOrderTags(o.id, ["paid_sms_sent"]).catch(() => {});
  } catch (err) {
    logEvent("error", o?.name || o?.id, "sendOrderPaidSms: " + err, null, false);
  }
}

/* ------------------------ order confirmation email ----------------------- */

const escHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * The app's own order confirmation email (ORDER_CONFIRM_* on the Emails
 * page): products with their images, totals and the shipping address, sent
 * once per paid order through Brevo. The order is re-read from Shopify so
 * the images and totals are the same whichever way the order arrived
 * (webhook or the safety-net sync).
 */
export async function sendOrderConfirmEmail(o) {
  try {
    if (!o?.id) return;
    const cfg = await getSettings();
    if (READ_ONLY || isTrue(cfg.EMAIL_DISABLED) || !cfg.BREVO_API_KEY) return;
    if (!isTrue(cfg.ORDER_CONFIRM_EMAIL_ENABLED)) return;
    const bodyTpl = String(cfg.ORDER_CONFIRM_BODY || "").trim();
    if (!bodyTpl) return;
    // same go-live cutoff as the order-paid SMS - the backlog is never emailed
    const createdMs = o.created_at ? new Date(o.created_at).getTime() : 0;
    if (createdMs && createdMs < (await paidSmsSince(cfg))) return;

    const data = await gql(
      `#graphql
      query RxOrderForEmail($id: ID!) {
        order(id: $id) {
          name email createdAt statusPageUrl currencyCode
          customer { firstName email }
          customAttributes { key value }
          shippingAddress { name address1 address2 city provinceCode zip country }
          currentSubtotalPriceSet { shopMoney { amount } }
          currentTotalDiscountsSet { shopMoney { amount } }
          totalShippingPriceSet { shopMoney { amount } }
          currentTotalTaxSet { shopMoney { amount } }
          currentTotalPriceSet { shopMoney { amount } }
          lineItems(first: 100) {
            nodes {
              title variantTitle quantity
              image { url(transform: { maxWidth: 160, maxHeight: 160 }) }
              discountedTotalSet { shopMoney { amount } }
              sellingPlan { name }
            }
          }
        }
      }`,
      { id: `gid://shopify/Order/${o.id}` },
    );
    const ord = data.order;
    if (!ord) return;
    const attr = Object.fromEntries((ord.customAttributes || []).map((a) => [a.key, a.value]));
    const to = String(ord.email || ord.customer?.email || attr["Patient Email"] || "").trim();
    if (!to) {
      logEvent("email", o.name || o.id, "order confirmation NOT sent: the order has no email address", null, false);
      return;
    }

    const claimed = await Order.updateOne(
      { orderId: String(o.id), "emails.confirmSentAt": { $exists: false } },
      { $set: { "emails.confirmSentAt": new Date() } },
    );
    if (!claimed.modifiedCount) return;

    const fmt = (set) =>
      Number(set?.shopMoney?.amount || 0).toLocaleString("en-US", { style: "currency", currency: ord.currencyCode || "USD" });
    const items = (ord.lineItems?.nodes || [])
      .map((li) => {
        const sub = [li.variantTitle && li.variantTitle !== "Default Title" ? li.variantTitle : "", li.sellingPlan?.name || ""]
          .filter(Boolean)
          .join(" · ");
        const img = li.image?.url
          ? `<img src="${escHtml(li.image.url)}" alt="${escHtml(li.title)}" width="64" height="64" style="display:block; width:64px; height:64px; object-fit:contain; border:1px solid #e5e7eb; border-radius:6px;" />`
          : "";
        return (
          `<tr>` +
          `<td width="76" style="padding:14px 12px 14px 0; border-bottom:1px solid #e5e7eb;">${img}</td>` +
          `<td style="padding:14px 0; border-bottom:1px solid #e5e7eb; font-family:Arial, Helvetica, sans-serif; font-size:15px; line-height:22px; color:#333333;">` +
          `<strong>${escHtml(li.title)}</strong>` +
          (sub ? `<br /><span style="font-size:13px; color:#777777;">${escHtml(sub)}</span>` : "") +
          `<br /><span style="font-size:13px; color:#777777;">Qty: ${Number(li.quantity) || 0}</span></td>` +
          `<td align="right" style="padding:14px 0; border-bottom:1px solid #e5e7eb; font-family:Arial, Helvetica, sans-serif; font-size:15px; color:#333333; white-space:nowrap;">${fmt(li.discountedTotalSet)}</td>` +
          `</tr>`
        );
      })
      .join("");
    const a = ord.shippingAddress;
    const address = a
      ? [a.name, a.address1, a.address2, [a.city, a.provinceCode, a.zip].filter(Boolean).join(" "), a.country]
          .filter(Boolean)
          .map(escHtml)
          .join("<br />")
      : "";
    const discount = Number(ord.currentTotalDiscountsSet?.shopMoney?.amount || 0);
    const name = String(attr["Patient First Name"] || ord.customer?.firstName || a?.name?.split(" ")[0] || "").trim() || "there";
    const values = {
      name: escHtml(name),
      "order-number": escHtml(ord.name),
      order_date: new Date(ord.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
      items,
      subtotal: fmt(ord.currentSubtotalPriceSet),
      discount_row: discount
        ? `<tr><td>Discount</td><td align="right">-${fmt(ord.currentTotalDiscountsSet)}</td></tr>`
        : "",
      shipping: fmt(ord.totalShippingPriceSet),
      tax: fmt(ord.currentTotalTaxSet),
      total: fmt(ord.currentTotalPriceSet),
      shipping_address: address,
      order_status_link: escHtml(ord.statusPageUrl || ""),
    };
    try {
      await sendEmail({
        to,
        subject: fillTemplate(cfg.ORDER_CONFIRM_SUBJECT || "", { name, "order-number": ord.name }),
        htmlBody: fillTemplate(bodyTpl, values),
      });
    } catch (err) {
      // not sent -> release the claim so the next webhook / sync can retry
      await Order.updateOne({ orderId: String(o.id) }, { $unset: { "emails.confirmSentAt": "" } });
      throw err;
    }
    logEvent("email", to, `order confirmation ${ord.name} sent`);
    addOrderTags(o.id, ["confirm_email_sent"]).catch(() => {});
  } catch (err) {
    logEvent("error", o?.name || o?.id, "sendOrderConfirmEmail: " + err, null, false);
  }
}

/** One-time "your order is on its way" SMS once a tracking link exists. */
export async function sendOrderFulfilledSms(o, fulfillment) {
  try {
    if (!o?.id) return;
    if (hasTag(o.tags, "fulfilled_sms_sent")) return;
    const cfg = await getSettings();
    if (READ_ONLY || isTrue(cfg.SMS_DISABLED) || !cfg.BREVO_API_KEY) return;
    if (!isTrue(cfg.ORDER_FULFILLED_SMS_ENABLED)) return;
    const template = String(cfg.ORDER_FULFILLED_BODY || "").trim();
    if (!template) return;
    // Same go-live cutoff as the order-paid SMS - never text the backlog.
    const createdMs = o.created_at ? new Date(o.created_at).getTime() : 0;
    if (createdMs && createdMs < (await paidSmsSince(cfg))) return;

    // No tracking link yet: leave unclaimed so a later update can send it.
    const trackingUrl = trackingUrlOf(o, fulfillment);
    if (!trackingUrl) return;
    const { digits, firstName } = contactOf(o);
    if (!digits) return;

    const claimed = await Order.updateOne(
      { orderId: String(o.id), "sms.fulfilledSentAt": { $exists: false } },
      { $set: { "sms.fulfilledSentAt": new Date() } },
    );
    if (!claimed.modifiedCount) return;

    await sendSms(
      digits,
      fillTemplate(template, { "First Name": firstName, "Tracking Link": trackingUrl }),
    );
    addOrderTags(o.id, ["fulfilled_sms_sent"]).catch(() => {});
  } catch (err) {
    logEvent("error", o?.name || o?.id, "sendOrderFulfilledSms: " + err, null, false);
  }
}

async function sendOrderUpdatedSms(o, summary) {
  const cfg = await getSettings();
  if (READ_ONLY || isTrue(cfg.SMS_DISABLED) || !cfg.BREVO_API_KEY) return;
  if (!isTrue(cfg.ORDER_UPDATED_SMS_ENABLED || "TRUE")) return;
  const template = String(cfg.ORDER_UPDATED_BODY || "").trim();
  if (!template) return;
  const { digits, firstName } = contactOf(o);
  if (!digits) return;
  await sendSms(
    digits,
    fillTemplate(template, {
      "First Name": firstName,
      "order-number": String(o.name || o.order_number || o.id),
      "Order Update Summary": String(summary || "Details have been modified.").trim(),
    }),
  );
}

/** Phone / email / shipping address as one comparable snapshot. Every phone
 *  slot is folded in, so editing only the shipping phone still registers. */
function contactSnapshot(o) {
  const cust = o.customer || {};
  const ship = o.shipping_address || {};
  const bill = o.billing_address || {};
  const attr = orderAttrs(o);
  const phone = [o.phone, ship.phone, bill.phone, cust.phone, attr["Patient Phone"]]
    .map((v) => String(v || "").replace(/[^0-9]/g, ""))
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort()
    .join("|");
  const shipping = [
    ship.address1,
    ship.address2,
    ship.city,
    ship.province || ship.province_code,
    ship.zip,
    ship.country || ship.country_code,
  ]
    .map((v) => String(v || "").trim().toLowerCase())
    .filter(Boolean)
    .join(", ");
  return {
    phone,
    email: String(o.email || cust.email || "").trim().toLowerCase(),
    shipping,
  };
}

function diffSnapshots(prior, cur) {
  const changes = [];
  const check = (key, label) => {
    const a = prior[key] || "";
    const b = cur[key] || "";
    if (a === b) return;
    changes.push(`${label} ${!a && b ? "added" : a && !b ? "removed" : "updated"}`);
  };
  check("phone", "Mobile number");
  check("email", "Email address");
  check("shipping", "Shipping address");
  return changes;
}

/* ----------------------------- entry points ----------------------------- */

/**
 * A paid (or about-to-be-paid) order. Called by orders/create, orders/paid
 * and the safety-net sync - safe to call any number of times for one order.
 */
export async function processOrder(o, { source = "webhook" } = {}) {
  if (!o?.id) return { ok: false, error: "missing order" };
  return withLock("order:" + o.id, async () => {
    const ctags = await buyerTags(o);
    let ids = attrIds(o, ctags);
    const paid = String(o.financial_status || "").toLowerCase() === "paid";

    // A weak (patient / email) prescription match can supply ids the order
    // itself does not carry, so resolve it before tagging.
    const rx = paid ? await closePrescription(o, ids) : null;
    ids = mergeTagIds(mergeRxIds(ids, rx), o.tags);
    const demo = await isDemoIds(ids);

    const doc = await saveOrder(o, ids, demo);
    // First sighting: store the contact baseline so the very first
    // orders/updated webhook is never mistaken for a change.
    if (!doc.snapshot?.email && !doc.snapshot?.phone && !doc.snapshot?.shipping) {
      await Order.updateOne({ _id: doc._id }, { $set: { snapshot: contactSnapshot(o) } });
    }

    if (!paid) return { ok: true, skipped: "not paid yet" };

    await sendOrderPaidSms(o);
    await sendOrderConfirmEmail(o);
    if (!isAttributable(ids)) return { ok: true, skipped: "not an rx order (sms handled)" };

    const customerTagged = await tagRxCustomer(o, ids, demo); // customer first, then the order
    const tagged = await tagRxOrder(o, ids, demo);
    const logged = await recordOrderPayoutIfNew(doc, ids);
    if (logged || source !== "sync") {
      logEvent("webhook", o.name, `paid order processed (${source})`, {
        tagged,
        customerTagged,
        logged,
        rxId: ids.rxId,
        doctor: ids.doctorId,
        clinic: ids.clinicId,
        practice: ids.practiceId,
      });
    }
    return { ok: true, tagged, customerTagged, logged, rxId: ids.rxId, order: o.name };
  });
}

/**
 * orders/updated: refreshes the local copy (delivery status, refunds, tags),
 * sends the fulfilled SMS once tracking exists, and texts the customer when
 * their phone, email or shipping address was changed.
 */
export async function processOrderUpdate(o) {
  if (!o?.id) return { ok: false, error: "missing order" };
  // Paid after creation (manual payment, bank transfer) -> full pipeline.
  const res = await processOrder(o, { source: "update" });
  return withLock("order:" + o.id, async () => {
    await sendOrderFulfilledSms(o);
    const doc = await Order.findOne({ orderId: String(o.id) }, { snapshot: 1 }).lean();
    const cur = contactSnapshot(o);
    const prior = doc?.snapshot || {};
    const changes = diffSnapshots(prior, cur);
    if (!changes.length) return res;
    await Order.updateOne({ orderId: String(o.id) }, { $set: { snapshot: cur } });
    const summary = changes.join(", ");
    await sendOrderUpdatedSms(o, summary).catch(() => {});
    logEvent("webhook", o.name, "order contact details changed: " + summary);
    return { ...res, changes: summary };
  });
}

/** orders/delete: the order is gone from Shopify - reverse its commission. */
export async function processOrderDelete(payload) {
  const reversed = await reverseOrderCommission(payload?.id, payload?.name || "");
  await Order.updateOne(
    { orderId: String(payload?.id) },
    { $set: { deletedAt: new Date() } },
  );
  return { ok: true, reversed, orderId: payload?.id };
}

/* -------------------- safety-net sync from Shopify ---------------------- */

const ORDER_SYNC_QUERY = `#graphql
  query RxOrdersSync($query: String!, $after: String) {
    orders(first: 50, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id legacyResourceId name email phone createdAt processedAt cancelledAt tags
        displayFinancialStatus displayFulfillmentStatus currencyCode
        customAttributes { key value }
        currentSubtotalPriceSet { shopMoney { amount } }
        currentTotalDiscountsSet { shopMoney { amount } }
        totalShippingPriceSet { shopMoney { amount } }
        currentTotalTaxSet { shopMoney { amount } }
        currentTotalPriceSet { shopMoney { amount } }
        totalRefundedSet { shopMoney { amount } }
        customer { id legacyResourceId firstName lastName email phone tags }
        shippingAddress { firstName lastName phone address1 address2 city province provinceCode zip country countryCodeV2 }
        billingAddress { firstName lastName phone }
        fulfillments(first: 10) { status displayStatus estimatedDeliveryAt trackingInfo(first: 3) { company url } }
        lineItems(first: 100) {
          nodes {
            id title variantTitle sku quantity
            originalUnitPriceSet { shopMoney { amount } }
            totalDiscountSet { shopMoney { amount } }
            product { id }
            variant { id }
            customAttributes { key value }
            sellingPlan { name }
          }
        }
      }
    }
  }`;

const money = (set) => set?.shopMoney?.amount ?? "0";

// GraphQL displayStatus values that carry no carrier information.
const NO_SHIPMENT_STATUS = new Set(["fulfilled", "submitted", "not_delivered", "canceled", "failure"]);

/** A GraphQL order node -> the REST shape the webhooks deliver, so both paths
 *  run through exactly the same code. */
export function gqlOrderToRest(n) {
  const addr = (a) =>
    a && {
      first_name: a.firstName,
      last_name: a.lastName,
      phone: a.phone,
      address1: a.address1,
      address2: a.address2,
      city: a.city,
      province: a.province,
      province_code: a.provinceCode,
      zip: a.zip,
      country: a.country,
      country_code: a.countryCodeV2,
    };
  const refunded = Number(money(n.totalRefundedSet)) || 0;
  return {
    id: String(n.legacyResourceId || legacyId(n.id)),
    name: n.name,
    email: n.email,
    phone: n.phone,
    created_at: n.createdAt,
    processed_at: n.processedAt,
    cancelled_at: n.cancelledAt,
    tags: (n.tags || []).join(", "),
    financial_status: String(n.displayFinancialStatus || "").toLowerCase(),
    fulfillment_status: String(n.displayFulfillmentStatus || "").toLowerCase(),
    currency: n.currencyCode,
    note_attributes: (n.customAttributes || []).map((a) => ({ name: a.key, value: a.value })),
    current_subtotal_price: money(n.currentSubtotalPriceSet),
    current_total_discounts: money(n.currentTotalDiscountsSet),
    total_shipping_price_set: { shop_money: { amount: money(n.totalShippingPriceSet) } },
    current_total_tax: money(n.currentTotalTaxSet),
    current_total_price: money(n.currentTotalPriceSet),
    refunds: refunded
      ? [{ transactions: [{ kind: "refund", status: "success", amount: refunded }] }]
      : [],
    customer: n.customer && {
      id: String(n.customer.legacyResourceId || legacyId(n.customer.id)),
      first_name: n.customer.firstName,
      last_name: n.customer.lastName,
      email: n.customer.email,
      phone: n.customer.phone,
      tags: (n.customer.tags || []).join(", "),
    },
    shipping_address: addr(n.shippingAddress),
    billing_address: addr(n.billingAddress),
    fulfillments: (n.fulfillments || []).map((f) => {
      const ds = String(f.displayStatus || "").toLowerCase();
      return {
        status: String(f.status || "").toLowerCase(),
        shipment_status: NO_SHIPMENT_STATUS.has(ds) ? "" : ds,
        tracking_urls: (f.trackingInfo || []).map((t) => t.url).filter(Boolean),
        tracking_url: f.trackingInfo?.[0]?.url || "",
        tracking_company: f.trackingInfo?.[0]?.company || "",
        estimated_delivery_at: f.estimatedDeliveryAt || null,
      };
    }),
    line_items: (n.lineItems?.nodes || []).map((li) => ({
      id: legacyId(li.id),
      product_id: li.product ? legacyId(li.product.id) : null,
      variant_id: li.variant ? legacyId(li.variant.id) : null,
      title: li.title,
      variant_title: li.variantTitle,
      sku: li.sku,
      quantity: li.quantity,
      price: money(li.originalUnitPriceSet),
      total_discount: money(li.totalDiscountSet),
      selling_plan_name: li.sellingPlan?.name || "",
      properties: (li.customAttributes || []).map((a) => ({ name: a.key, value: a.value })),
    })),
  };
}

/** Orders from Shopify matching a search query, as REST-shaped objects. */
export async function fetchOrders(query, { max = 2000 } = {}) {
  const nodes = await gqlAll(ORDER_SYNC_QUERY, { query }, (d) => d.orders, { max });
  return nodes.map(gqlOrderToRest);
}

/**
 * Re-runs the pipeline over the last `days` of orders. Catches a missed
 * webhook, refreshes delivery status, and confirms deletions: a logged order
 * that Shopify no longer returns is checked by id and, only on a confirmed
 * "not found", reversed.
 */
export async function syncRecentOrders({ days } = {}) {
  const cfg = await getSettings();
  days = days || Number(cfg.ORDER_SYNC_DAYS) || 30;
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const orders = await fetchOrders(`created_at:>='${since.toISOString()}'`, { max: 20000 });
  let processed = 0;
  for (const o of orders) {
    try {
      await processOrder(o, { source: "sync" });
      processed++;
    } catch (err) {
      logEvent("error", o.name, "syncRecentOrders: " + err, null, false);
    }
  }

  // Deletion check for orders the fetch no longer returns.
  const seen = new Set(orders.map((o) => String(o.id)));
  const suspects = await Order.find(
    {
      orderCreatedAt: { $gte: since },
      deletedAt: null,
      orderId: { $nin: [...seen] },
    },
    { orderId: 1, name: 1 },
  ).lean();
  let deleted = 0;
  for (const s of suspects) {
    try {
      const data = await gql(
        `#graphql
        query RxOrderExists($id: ID!) { order(id: $id) { id } }`,
        { id: `gid://shopify/Order/${s.orderId}` },
      );
      if (data.order === null) {
        await processOrderDelete({ id: s.orderId, name: s.name });
        deleted++;
      }
    } catch {
      // any error = not confirmed deleted; under-detecting is the safe side
    }
  }
  logEvent("job", "order-sync", `orders=${orders.length} processed=${processed} deleted=${deleted}`);
  return { fetched: orders.length, processed, deleted };
}

/**
 * Manual audit over EVERY logged order, not just the recent sync window
 * (was Payouts.gs checkAllDeletedOrdersNow): each one still counted is
 * looked up by id, and only a confirmed "not found" is reversed. One Shopify
 * call per order, so it is a button, never a timer.
 */
export async function auditDeletedOrders() {
  await connectDb();
  const rows = await Order.find(
    { deletedAt: null, "commission.status": { $ne: "Deleted" } },
    { orderId: 1, name: 1 },
  ).lean();
  let deleted = 0;
  let unsure = 0;
  for (const s of rows) {
    try {
      const data = await gql(
        `#graphql
        query RxOrderStillThere($id: ID!) { order(id: $id) { id } }`,
        { id: `gid://shopify/Order/${s.orderId}` },
      );
      if (data.order === null) {
        await processOrderDelete({ id: s.orderId, name: s.name });
        deleted++;
      }
    } catch {
      unsure++; // any error = not confirmed deleted; under-detecting is the safe side
    }
  }
  logEvent("job", "deleted-orders-audit", `checked=${rows.length} deleted=${deleted} couldNotCheck=${unsure}`);
  return { checked: rows.length, deleted, couldNotCheck: unsure };
}

/** Full history import, used once after install (admin -> Sync). */
export async function backfillOrders({ sinceIso } = {}) {
  const query = sinceIso ? `created_at:>='${sinceIso}'` : "status:any";
  const orders = await fetchOrders(query, { max: 200000 });
  let processed = 0;
  for (const o of orders) {
    try {
      await processOrder(o, { source: "sync" });
      processed++;
    } catch (err) {
      logEvent("error", o.name, "backfillOrders: " + err, null, false);
    }
  }
  logEvent("job", "order-backfill", `orders=${orders.length} processed=${processed}`);
  return { fetched: orders.length, processed };
}
