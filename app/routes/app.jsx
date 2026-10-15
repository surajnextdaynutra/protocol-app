import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import { Banner } from "@shopify/polaris";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";

import { authenticate } from "../shopify.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    readOnly: /^(1|true|yes|on)$/i.test(String(process.env.RX_READ_ONLY || "")),
  };
};

export default function App() {
  const { apiKey, readOnly } = useLoaderData();

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">
          Overview
        </Link>
        <Link to="/app/prescriptions">Prescriptions</Link>
        <Link to="/app/orders">Orders &amp; commissions</Link>
        <Link to="/app/payouts">Payouts</Link>
        <Link to="/app/accounts">Accounts</Link>
        <Link to="/app/emails">Emails</Link>
        <Link to="/app/reps">Sales reps</Link>
        <Link to="/app/products">Products</Link>
        <Link to="/app/banking">Banking details</Link>
        <Link to="/app/forms">Form entries</Link>
        <Link to="/app/settings">Settings</Link>
        <Link to="/app/system">Sync &amp; logs</Link>
      </NavMenu>
      {readOnly ? (
        <div style={{ padding: "12px 16px 0" }}>
          <Banner tone="warning" title="Read-only mode">
            <p>
              RX_READ_ONLY is on: the app reads from Shopify but does not tag orders or customers, change
              products, or send email / SMS.
            </p>
          </Banner>
        </div>
      ) : null}
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs Remix to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
