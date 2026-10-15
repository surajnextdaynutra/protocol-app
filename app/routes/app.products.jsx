import { useEffect, useState } from "react";
import { Form, useActionData, useLoaderData, useSubmit } from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  DataTable,
  FormLayout,
  InlineStack,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";

import { ActionResult, SyncStatus, money, useBusy, useRefreshWhile } from "../components/admin";
import { connectDb } from "../db.server";
import { Product } from "../models/index.server";
import {
  MASTER_COLUMNS,
  cleanupDuplicateCopies,
  deleteMaster,
  ensureProductMetafieldDefinitions,
  forceResyncCopies,
  importMastersFromStore,
  listMasters,
  refreshMastersFromBase,
  runProductSync,
  saveMaster,
  syncMasterPrices,
  syncSharedInventory,
} from "../services/catalog.server";
import { logEvent } from "../services/log.server";
import { syncAllProducts } from "../services/products.server";
import { autoSync } from "../services/autosync.server";
import { authenticate } from "../shopify.server";

/* Products - the master list (was the "Products" sheet tab). Each master
   becomes a base product plus one copy per practice in Shopify. */

const MULTILINE = new Set(["Description", "Storage Instructions", "Directions & Usage", "Peptides Support + Keywords", "Metafields", "Images"]);

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  await connectDb();
  // Every open / refresh re-reads the store catalogue from Shopify (no
  // "Refresh local catalogue" click needed); at most once a minute.
  const sync = autoSync("product-catalogue", syncAllProducts, { minIntervalMs: 60_000 });
  // the custom.* product metafield definitions the app and theme rely on (a fresh store has none)
  autoSync("metafield-defs", ensureProductMetafieldDefinitions, { minIntervalMs: 6 * 3600_000 });
  const [masters, copyCounts, mirrorTotal, practiceCount] = await Promise.all([
    listMasters(),
    Product.aggregate([{ $match: { masterKey: { $ne: "" } } }, { $group: { _id: "$masterKey", n: { $sum: 1 } } }]),
    Product.countDocuments({}),
    Product.distinct("practiceId", { practiceId: { $ne: "" }, masterKey: { $ne: "" } }),
  ]);
  const counts = Object.fromEntries(copyCounts.map((c) => [c._id, c.n]));
  return {
    sync,
    columns: MASTER_COLUMNS,
    mirrorTotal,
    practiceCount: practiceCount.length,
    masters: masters.map((m) => ({ masterKey: m.masterKey, row: m.row || {}, copies: counts[m.masterKey] || 0 })),
  };
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
  const f = await request.formData();
  const intent = f.get("intent");
  // Long-running jobs answer at once and report into Sync & logs.
  const background = (name, job) => {
    job()
      .then((r) => logEvent("job", name, "finished: " + JSON.stringify(r)))
      .catch((err) => logEvent("error", name, String(err), null, false));
    return { ok: true, message: `${name} started - see Sync & logs for the result.` };
  };
  try {
    if (intent === "save") {
      const row = {};
      for (const [k, v] of f.entries()) if (k.startsWith("c:")) row[k.slice(2)] = String(v);
      const key = await saveMaster(row);
      return { ok: true, message: `Saved ${key}. It reaches Shopify on the next product sync (or press "Sync to Shopify now").` };
    }
    if (intent === "delete") {
      await deleteMaster(String(f.get("masterKey")));
      return { ok: true, message: "Removed from the master list. Products already in Shopify were not touched." };
    }
    if (intent === "import-store") {
      const res = await importMastersFromStore();
      // then make every physician's practice its copies, like the old 30-minute run
      if (res.imported) background("product-copies", runProductSync);
      return {
        ok: true,
        message:
          `Imported ${res.imported} master product(s) from the store` +
          (res.skippedExisting ? ` (${res.skippedExisting} already in the list, left as they are)` : "") +
          (res.adoptedAsBase ? `; ${res.adoptedAsBase} store product(s) tagged as the base` : "") +
          (res.imported ? ". Practice copies are being created now - see Sync & logs." : "."),
      };
    }
    // Duplicate copies (was cleanupLegacyDoctorTaggedCopies) - preview, then delete.
    if (intent === "dupes-preview" || intent === "dupes-delete") {
      const res = await cleanupDuplicateCopies({ dryRun: intent === "dupes-preview" });
      const n = res.duplicates + res.legacy;
      if (intent === "dupes-delete") {
        return { ok: true, message: `Deleted ${res.deleted} extra copies (kept the oldest copy for each practice).` +
          (res.skipped ? ` ${res.skipped} group(s) left for review - see Sync & logs.` : "") };
      }
      return {
        ok: true,
        message: n
          ? `${n} extra copies found (${res.duplicates} duplicates, ${res.legacy} leftover per-doctor copies) - review below.`
          : `No duplicate copies across ${res.groups} practice/product pairs.` + (res.skipped ? ` ${res.skipped} pair(s) only have per-doctor copies - left as they are.` : ""),
        dupes: n ? res : null,
      };
    }
    // Rewrite every copy from its master even if it looks unchanged (was forceResyncPracticeMetafields_).
    if (intent === "force-resync") return background("product-copies (force)", forceResyncCopies);
    if (intent === "sync") return background("product-copies", runProductSync);
    if (intent === "prices") return background("price-sync", syncMasterPrices);
    if (intent === "inventory") return background("shared-inventory", syncSharedInventory);
    // Vendor / sales channels / stock back from the base products, then the copies follow.
    if (intent === "from-base") {
      return background("refresh-from-base", () => refreshMastersFromBase().then(async (r) => ({ ...r, sync: await runProductSync() })));
    }
    if (intent === "mirror") return background("products", syncAllProducts);
  } catch (err) {
    return { ok: false, message: String(err.message || err) };
  }
  return { ok: false, message: "Unknown action" };
};

function MasterForm({ columns, master, busy, onClose }) {
  const [row, setRow] = useState(() => Object.fromEntries(columns.map((c) => [c, master?.row?.[c] ?? ""])));
  // columns that came in through a CSV import but are not in the standard list
  const extra = Object.keys(master?.row || {}).filter((c) => !columns.includes(c));
  return (
    <Card>
      <Form method="post" onSubmit={onClose}>
        <input type="hidden" name="intent" value="save" />
        {extra.map((c) => (
          <input key={c} type="hidden" name={"c:" + c} value={String(master.row[c] ?? "")} />
        ))}
        <FormLayout>
          <Text as="h2" variant="headingMd">{master ? `Edit ${master.masterKey}` : "New master product"}</Text>
          {columns.map((c) => (
            <TextField
              key={c}
              label={c}
              name={"c:" + c}
              value={String(row[c] ?? "")}
              onChange={(v) => setRow((s) => ({ ...s, [c]: v }))}
              multiline={MULTILINE.has(c) ? 3 : false}
              disabled={c === "Master Key" && !!master}
              helpText={HELP[c]}
              autoComplete="off"
            />
          ))}
          {master ? <input type="hidden" name="c:Master Key" value={master.masterKey} /> : null}
          <InlineStack gap="300">
            <Button submit variant="primary" loading={busy}>Save</Button>
            <Button onClick={onClose}>Cancel</Button>
          </InlineStack>
        </FormLayout>
      </Form>
    </Card>
  );
}

const HELP = {
  "Master Key": "Leave blank to use the title (e.g. Zinc Glycinate -> base tagged rxbase:Zinc Glycinate, copies rxcopy:Zinc Glycinate). Never change it afterwards.",
  Price: "Used only when a product is first created.",
  "Compare At Price": "Used only when a product is first created.",
  Inventory: "The shared stock number across every copy.",
  Status: "active / draft / archived",
  Published: "TRUE = on every sales channel, FALSE = on none.",
  Vendor: "Blank = the PRODUCT_VENDOR setting (Protocol Therapeutics).",
  Tags: "Comma-separated; added to every copy.",
  "Purchase Options": "A selling plan group id (gid://shopify/SellingPlanGroup/…) turns subscriptions on. Blank = one-time only.",
  Metafields: 'Optional JSON: [{"namespace":"custom","key":"…","type":"…","value":"…"}]',
  Images: "Comma-separated image URLs; the first is the featured image.",
  "MSRP Low": "A practice copy launches at this price.",
  "Related Categories": "Separate values with a pipe |",
  Highlights: "Separate values with a pipe |",
  "Formulation Features": "Comma-separated file URLs.",
};

export default function Products() {
  const data = useLoaderData();
  const actionData = useActionData();
  useRefreshWhile(data.sync?.syncing);
  const submit = useSubmit();
  const busy = useBusy();
  const [editing, setEditing] = useState(null); // masterKey | "new" | null
  const run = (intent, extra = {}) => submit({ intent, ...extra }, { method: "post" });
  const current = data.masters.find((m) => m.masterKey === editing);
  const [dupes, setDupes] = useState(null);
  useEffect(() => { if (actionData && "dupes" in actionData) setDupes(actionData.dupes); }, [actionData]);

  return (
    <Page
      title="Products"
      subtitle={`${data.masters.length} master products · copies for ${data.practiceCount} practices · ${data.mirrorTotal} products in the local catalogue`}
      fullWidth
      primaryAction={{ content: "New master product", onAction: () => setEditing("new") }}
      secondaryActions={[
        { content: "Import from store", disabled: busy, onAction: () => run("import-store") },
        { content: "Sync to Shopify now", disabled: busy, onAction: () => run("sync") },
        { content: "Force full re-sync", disabled: busy, onAction: () => run("force-resync") },
        { content: "Find duplicate copies", disabled: busy, onAction: () => run("dupes-preview") },
        { content: "Push master prices", disabled: busy, onAction: () => run("prices") },
        { content: "Sync inventory", disabled: busy, onAction: () => run("inventory") },
        { content: "Refresh from base products", disabled: busy, onAction: () => run("from-base") },
        { content: "Refresh local catalogue", disabled: busy, onAction: () => run("mirror") },
      ]}
    >
      <BlockStack gap="400">
        <ActionResult data={actionData} />
        <SyncStatus sync={data.sync} />
        {dupes ? (
          <Banner
            tone="warning"
            title={`${dupes.duplicates + dupes.legacy} extra product copies`}
            action={{ content: "Delete the extra copies", onAction: () => { run("dupes-delete"); setDupes(null); }, disabled: busy }}
            secondaryAction={{ content: "Cancel", onAction: () => setDupes(null) }}
          >
            <BlockStack gap="200">
              <p>
                For each practice the <b>oldest</b> copy of a product is kept; the newer duplicates and any leftover
                per-doctor copies (from the old one-copy-per-doctor setup) are deleted from Shopify. A practice is never
                left without the product.
              </p>
              <DataTable
                columnContentTypes={["text", "text", "text", "text"]}
                headings={["Product", "Practice", "Why", "Created"]}
                rows={dupes.sample.map((s) => [s.title, s.practiceId, s.kind, String(s.createdAt || "").slice(0, 10)])}
              />
              {dupes.duplicates + dupes.legacy > dupes.sample.length ? <p>…and {dupes.duplicates + dupes.legacy - dupes.sample.length} more.</p> : null}
            </BlockStack>
          </Banner>
        ) : null}
        {!data.masters.length ? (
          <Banner
            tone="warning"
            title="No master products yet - so no practice gets product copies"
            action={{ content: "Import from store", onAction: () => run("import-store"), disabled: busy }}
          >
            <p>
              Each physician's practice gets one copy of every master product, tagged{" "}
              <b>practice_id:&lt;practice&gt;</b> and <b>rxcopy:&lt;Master Key&gt;</b> (e.g. rxcopy:Zinc Glycinate) - the
              same as the old Rx-Product-Sync script. Import the masters from the products already in your store, or
              the "Products" tab of the old sheet (Sync &amp; logs → Import from Google Sheets), or add them here.
            </p>
          </Banner>
        ) : null}
        {editing ? (
          <MasterForm
            key={editing}
            columns={data.columns}
            master={editing === "new" ? null : current}
            busy={busy}
            onClose={() => setEditing(null)}
          />
        ) : null}
        <Card padding="0">
          <DataTable
            columnContentTypes={["text", "text", "text", "text", "numeric", "numeric", "numeric", "numeric", "numeric", "text"]}
            headings={["Master key", "Title", "SKU", "Status", "Price", "Wholesale", "MSRP low", "Inventory", "Copies", ""]}
            rows={data.masters.map((m) => [
              m.masterKey,
              m.row.Title || "",
              m.row.SKU || "",
              m.row.Status || "active",
              m.row.Price ? money(String(m.row.Price).replace(/[^0-9.]/g, "")) : "",
              m.row["Wholsale Price"] ? money(String(m.row["Wholsale Price"]).replace(/[^0-9.]/g, "")) : "",
              m.row["MSRP Low"] ? money(String(m.row["MSRP Low"]).replace(/[^0-9.]/g, "")) : "",
              m.row.Inventory ?? "",
              m.copies,
              <InlineStack key={m.masterKey} gap="200" wrap={false}>
                <Button size="micro" onClick={() => setEditing(m.masterKey)}>Edit</Button>
                <Button size="micro" tone="critical" disabled={busy} onClick={() => run("delete", { masterKey: m.masterKey })}>
                  Remove
                </Button>
              </InlineStack>,
            ])}
          />
        </Card>
      </BlockStack>
    </Page>
  );
}
