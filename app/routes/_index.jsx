import { redirect } from "@remix-run/node";

// Nothing public lives at the app's root - Shopify admin opens /app.
export const loader = async ({ request }) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  throw redirect("/auth/login");
};
