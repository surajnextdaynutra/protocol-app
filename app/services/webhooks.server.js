import { connectDb } from "../db.server";
import { WebhookEvent } from "../models/index.server";
import { refreshAccountFromWebhook, removeAccount } from "./accounts.server";
import { logEvent } from "./log.server";
import { processOrder, processOrderDelete, processOrderUpdate } from "./orders.server";
import { pullMasterFromBase, pullStockFromInventoryLevel } from "./catalog.server";
import { removeProduct, syncProduct } from "./products.server";
import { invalidateResponses } from "./response-cache.server";

/* Shopify webhooks. The signature is verified by the route
   (authenticate.webhook) before anything here runs. Each delivery is
   answered at once and processed in the background, so Shopify never
   re-sends because of a slow reply; a re-delivery of the same webhook id is
   dropped. Failures are kept in `webhook_events` for the admin to see. */

const handlers = {
  ORDERS_CREATE: (p) => processOrder(p, { source: "orders/create" }),
  ORDERS_PAID: (p) => processOrder(p, { source: "orders/paid" }),
  ORDERS_UPDATED: (p) => processOrderUpdate(p),
  ORDERS_FULFILLED: (p) => processOrderUpdate(p),
  ORDERS_PARTIALLY_FULFILLED: (p) => processOrderUpdate(p),
  ORDERS_CANCELLED: (p) => processOrderUpdate(p),
  ORDERS_DELETE: (p) => processOrderDelete(p),
  // re-read live - a webhook payload without tags must never delete an account
  CUSTOMERS_CREATE: (p) => refreshAccountFromWebhook(p),
  CUSTOMERS_UPDATE: (p) => refreshAccountFromWebhook(p),
  CUSTOMERS_DELETE: (p) => removeAccount(p.id),
  PRODUCTS_CREATE: (p) => syncProduct(p.id),
  PRODUCTS_UPDATE: async (p) => {
    await syncProduct(p.id);
    // a base product edited in Shopify admin -> its master in the app follows
    if (/(^|,s*)rxbase:/i.test(String(p.tags || "")) && !/practice_id:/i.test(String(p.tags || ""))) {
      await pullMasterFromBase(p.id);
    }
  },
  // stock edited in Shopify admin (products/update doesn't fire for stock)
  INVENTORY_LEVELS_UPDATE: (p) => pullStockFromInventoryLevel(p),
  PRODUCTS_DELETE: (p) => removeProduct(p.id),
};

export function handlesTopic(topic) {
  return !!handlers[topic];
}

/** Registers the delivery and runs its handler in the background. */
export async function acceptWebhook({ topic, webhookId, payload }) {
  const handler = handlers[topic];
  if (!handler) return;
  await connectDb();
  const id = webhookId || `${topic}:${payload?.id}:${Date.now()}`;
  try {
    await WebhookEvent.create({ _id: id, topic, ref: String(payload?.name || payload?.id || "") });
  } catch (err) {
    if (err?.code === 11000) return; // duplicate delivery
    throw err;
  }
  Promise.resolve()
    .then(() => handler(payload))
    // an order / customer / product changed - storefront answers must be re-read
    .finally(invalidateResponses)
    .then(() => WebhookEvent.updateOne({ _id: id }, { $set: { status: "done" } }))
    .catch((err) => {
      logEvent("error", topic, String(err?.stack || err), { id: payload?.id }, false);
      return WebhookEvent.updateOne(
        { _id: id },
        { $set: { status: "failed", error: String(err).slice(0, 1000) } },
      );
    })
    .catch(() => {});
}
