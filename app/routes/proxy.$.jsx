import { handleProxy } from "../api/index.server";

/* Storefront API, reached through Shopify's App Proxy:
     https://<store>/apps/rx/<resource>?action=<name>   ->   /proxy/<resource>
   Shopify signs every request and adds the logged-in customer's id, so the
   pages send no password and no CORS setup is needed. */

export const loader = ({ request, params }) => handleProxy(request, params["*"]);
export const action = ({ request, params }) => handleProxy(request, params["*"]);
