import { useEffect } from "react";
import { useNavigation, useRevalidator, useSearchParams } from "@remix-run/react";
import { Badge, Banner, InlineStack, Pagination, Spinner, Text } from "@shopify/polaris";

/* Small pieces shared by the admin pages. */

/** Reloads the page's data every few seconds while `active` (e.g. a Shopify
 *  sync is running) - only while the tab is visible. */
export function useRefreshWhile(active, ms = 4000) {
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => {
      if (revalidator.state === "idle" && !document.hidden) revalidator.revalidate();
    }, ms);
    return () => clearInterval(t);
  }, [active, ms, revalidator]);
}

/** "Syncing with Shopify…" / "Synced with Shopify at …" line for a page that
 *  syncs itself on open (see services/autosync.server.js). */
export function SyncStatus({ sync }) {
  if (!sync) return null;
  if (sync.syncing) {
    return (
      <InlineStack gap="200" blockAlign="center">
        <Spinner size="small" accessibilityLabel="Syncing with Shopify" />
        <Text as="span" tone="subdued" variant="bodySm">Syncing with Shopify…</Text>
      </InlineStack>
    );
  }
  if (sync.error) {
    return <Text as="span" tone="critical" variant="bodySm">Shopify sync failed: {sync.error}</Text>;
  }
  return sync.lastSyncedAt ? (
    <Text as="span" tone="subdued" variant="bodySm">Synced with Shopify at {new Date(sync.lastSyncedAt).toLocaleTimeString()}</Text>
  ) : null;
}

export const money = (n) =>
  Number(n || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });

export const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");

export const dateTime = (d) =>
  d ? new Date(d).toISOString().replace("T", " ").slice(0, 16) : "";

const TONES = {
  Purchased: "success",
  Paid: "success",
  Active: "success",
  done: "success",
  Sent: "info",
  Opened: "info",
  "Checkout Started": "attention",
  Abandoned: "warning",
  Pending: "attention",
  Expired: "critical",
  Deleted: "critical",
  failed: "critical",
};

export function StatusBadge({ status }) {
  if (!status) return null;
  return <Badge tone={TONES[status]}>{status}</Badge>;
}

/** Shows the result of the last form action, and a toast when embedded. */
export function ActionResult({ data }) {
  useEffect(() => {
    if (data?.message && typeof shopify !== "undefined") {
      shopify.toast.show(data.message, { isError: data.ok === false });
    }
  }, [data]);
  if (!data?.message) return null;
  return (
    <Banner tone={data.ok === false ? "critical" : "success"}>
      <p>{data.message}</p>
    </Banner>
  );
}

/** Previous / next links that keep the page's other filters in the URL. */
export function Pager({ page, pageSize, total }) {
  const [params, setParams] = useSearchParams();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const go = (p) => {
    const next = new URLSearchParams(params);
    next.set("page", String(p));
    setParams(next);
  };
  return (
    <InlineStack align="space-between" blockAlign="center">
      <Text as="span" tone="subdued" variant="bodySm">
        {total.toLocaleString()} total · page {page} of {pages}
      </Text>
      <Pagination
        hasPrevious={page > 1}
        onPrevious={() => go(page - 1)}
        hasNext={page < pages}
        onNext={() => go(page + 1)}
      />
    </InlineStack>
  );
}

export function useBusy() {
  return useNavigation().state !== "idle";
}

/** page / pageSize / skip from the request URL. */
export function paging(request, pageSize = 50) {
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page"), 10) || 1);
  return { url, page, pageSize, skip: (page - 1) * pageSize };
}

/** Escapes a user-typed search term for use inside a RegExp. */
export const rx = (s) => new RegExp(String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
