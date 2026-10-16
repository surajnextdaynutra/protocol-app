/* Where a new account lands after logging in from the welcome email's
   [Link]. Shared by the sender (provisioning.server.js) and the Welcome
   email page's preview, so the page shows exactly the link that is sent. */

export const WELCOME_DASHBOARDS = {
  Practice: "/pages/rx-practice-dashboard#getting-started",
  "Practice + Doctor": "/pages/rx-physician-dashboard#getting-started",
  "Master Clinic": "/pages/rx-clinic-dashboard#getting-started",
  Clinic: "/pages/rx-clinic-dashboard#getting-started",
  "Clinic + Doctor": "/pages/rx-clinic-dashboard#getting-started",
  Physician: "/pages/rx-physician-dashboard#getting-started",
  "Sales Rep": "/pages/rx-sales-rep-dashboard#getting-started",
  "Finance Admin": "/pages/shopify-admin",
  // the demo trio is emailed as its physician
  Demo: "/pages/rx-physician-dashboard#getting-started",
};

/**
 * The login link with return_to pointing at the role's own dashboard - never
 * the store's home page. A link with no return_to gets one added. An unknown
 * role keeps the link as typed.
 */
export function welcomeLinkForRole(link, role) {
  link = String(link || "").trim();
  const path = WELCOME_DASHBOARDS[String(role || "").trim()];
  if (!link || !path) return link;
  const value = encodeURIComponent(path);
  if (/[?&]return_to=/.test(link)) return link.replace(/([?&]return_to=)[^&#]*/, "$1" + value);
  const [base, hash] = link.split("#");
  return base + (base.includes("?") ? "&" : "?") + "return_to=" + value + (hash !== undefined ? "#" + hash : "");
}
