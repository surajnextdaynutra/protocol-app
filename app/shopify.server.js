import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { MongoDBSessionStorage } from "@shopify/shopify-app-session-storage-mongodb";
import { MONGODB_DB, MONGODB_URI } from "./db.server";

export const apiVersion = ApiVersion.July26;

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new MongoDBSessionStorage(new URL(MONGODB_URI), MONGODB_DB),
  // Private app installed on the one store only - no App Store review.
  distribution: AppDistribution.SingleMerchant,
  hooks: {
    // On install / every new session: the store gets the custom.* product
    // metafield definitions the app and theme use, if it doesn't have them
    // yet - no manual setup. Background, so opening the app never waits on it.
    afterAuth: async () => {
      import("./services/catalog.server.js")
        .then((m) => m.ensureProductMetafieldDefinitions())
        .catch((err) => console.warn("[rx] metafield definitions:", err.message || err));
    },
  },
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
