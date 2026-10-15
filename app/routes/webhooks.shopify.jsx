import { authenticate } from "../shopify.server";
import { acceptWebhook } from "../services/webhooks.server";

// Every orders/*, customers/* and products/* subscription in shopify.app.toml
// points here; the topic decides the handler (services/webhooks.server.js).
export const action = async ({ request }) => {
  const { topic, payload, webhookId } = await authenticate.webhook(request);
  await acceptWebhook({ topic, payload, webhookId });
  return new Response();
};
