import { useRef, useState } from "react";
import { Form, useActionData, useLoaderData, useSubmit } from "@remix-run/react";
import { Banner, BlockStack, Button, Card, DataTable, FormLayout, InlineStack, List, Page, Text, TextField } from "@shopify/polaris";

import { ActionResult, useBusy } from "../components/admin";
import { importMetafieldsCsv, metafieldsCsvImported, runProductSync } from "../services/catalog.server";
import { logEvent } from "../services/log.server";
import { listCounters, setCounter } from "../services/provisioning.server";
import { listSettings, setSetting } from "../services/settings.server";
import { authenticate } from "../shopify.server";

/* Settings - replaces the "Settings" tab and every script property (Brevo
   keys, kill switches, commission rate, email / SMS wording). Changes apply
   within 30 seconds; nothing needs a redeploy. */

const GROUPS = [
  ["general", "General"],
  ["channels", "Email / SMS switches"],
  ["brevo", "Brevo"],
  ["forms", "Website forms"],
  ["commission", "Commission"],
  ["products", "Product copies"],
  ["demo", "Demo accounts"],
];
// Email / SMS wording, the welcome email and reminder timing are edited on the
// Emails page (one tab per message) - not listed here, so not edited twice.
const ON_EMAILS_PAGE = new Set(["reminders", "email", "sms", "welcome"]);

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const rows = await listSettings();
  return {
    // a stored secret is never sent back to the browser
    settings: rows.map((r) => (r.secret ? { ...r, value: "", hasValue: !!r.value } : r)),
    counters: await listCounters(),
    csvImported: await metafieldsCsvImported(),
  };
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
  const f = await request.formData();
  const intent = f.get("intent");
  // One-time: product metafields from a Shopify "Export products" CSV.
  if (intent === "mf-csv-preview" || intent === "mf-csv-import") {
    const file = f.get("csv");
    if (!file || typeof file.text !== "function" || !file.size) return { ok: false, message: "Choose the products CSV file first." };
    try {
      const res = await importMetafieldsCsv(await file.text(), { dryRun: intent === "mf-csv-preview" });
      if (!res.dryRun) {
        // the practice copies get the same values on this sync
        runProductSync()
          .then((r) => logEvent("job", "product-copies", "after metafield CSV import: " + JSON.stringify(r)))
          .catch((err) => logEvent("error", "product-copies", String(err), null, false));
      }
      return {
        ok: true,
        csv: res,
        message: res.dryRun
          ? `Preview: ${res.matched.length} of ${res.products} products matched - nothing saved yet.`
          : `Imported metafields for ${res.updatedMasters} products. The practice copies are being updated now (see Sync & logs).`,
      };
    } catch (err) {
      return { ok: false, message: String(err.message || err) };
    }
  }
  if (intent === "counters") {
    for (const [k, v] of f.entries()) {
      if (k.startsWith("counter:")) await setCounter(k.slice(8), v);
    }
    return { ok: true, message: "ID counters saved." };
  }
  const secretKeys = new Set(String(f.get("secretKeys") || "").split(",").filter(Boolean));
  let n = 0;
  for (const [k, v] of f.entries()) {
    if (!k.startsWith("s:")) continue;
    const key = k.slice(2);
    if (secretKeys.has(key) && !String(v).trim()) continue; // blank = keep the stored secret
    await setSetting(key, v);
    n++;
  }
  return { ok: true, message: `Saved ${n} setting(s).` };
};

function Group({ title, rows, busy }) {
  const [values, setValues] = useState(Object.fromEntries(rows.map((r) => [r.key, r.value])));
  return (
    <Card>
      <Form method="post">
        <input type="hidden" name="secretKeys" value={rows.filter((r) => r.secret).map((r) => r.key).join(",")} />
        <FormLayout>
          <Text as="h2" variant="headingMd">{title}</Text>
          {rows.map((r) => {
            const long = String(r.value).length > 70 || /_BODY$|_JSON$/.test(r.key);
            return (
              <TextField
                key={r.key}
                label={r.key}
                name={"s:" + r.key}
                value={values[r.key]}
                onChange={(v) => setValues((s) => ({ ...s, [r.key]: v }))}
                helpText={r.notes}
                multiline={long ? 4 : false}
                type={r.secret ? "password" : "text"}
                placeholder={r.secret && r.hasValue ? "•••••••• (saved - leave blank to keep)" : undefined}
                autoComplete="off"
              />
            );
          })}
          <InlineStack>
            <Button submit variant="primary" loading={busy}>Save {title.toLowerCase()}</Button>
          </InlineStack>
        </FormLayout>
      </Form>
    </Card>
  );
}

/* One-time tool: product metafields (and their definitions) from a Shopify
   "Export products" CSV. Preview first; after the import it only shows when
   it ran. */
function MetafieldCsvImport({ done, result, busy }) {
  const formRef = useRef(null);
  const submit = useSubmit();
  const [fileName, setFileName] = useState("");
  // Polaris buttons don't send name/value, so the intent is set here
  const send = (intent) => {
    const fd = new FormData(formRef.current);
    if (!fd.get("csv")?.size) return;
    fd.set("intent", intent);
    submit(fd, { method: "post", encType: "multipart/form-data" });
  };
  if (done && !result) {
    return (
      <Card>
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">Import product metafields (one time)</Text>
          <Text as="p" tone="subdued">
            Done on {new Date(done.at).toLocaleString()} - metafields imported for {done.masters} products.
          </Text>
        </BlockStack>
      </Card>
    );
  }
  return (
    <Card>
      <Form method="post" encType="multipart/form-data" ref={formRef} onSubmit={(e) => e.preventDefault()}>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">Import product metafields (one time)</Text>
          <Text as="p" tone="subdued">
            Upload a Shopify products export (Products → Export → CSV) that includes metafields. Missing metafield
            definitions are created, each product's values are saved on the matching master product (matched by
            title) and its base product, and the practice copies get them on the sync that runs right after.
            Preview first - nothing is saved until you press Import.
          </Text>
          <input type="file" name="csv" accept=".csv,text/csv" onChange={(e) => setFileName(e.target.files?.[0]?.name || "")} />
          <InlineStack gap="200">
            <Button onClick={() => send("mf-csv-preview")} disabled={!fileName} loading={busy}>Preview</Button>
            {result?.dryRun && result.matched.length ? (
              <Button onClick={() => send("mf-csv-import")} disabled={!fileName} variant="primary" loading={busy}>
                Import {result.matched.length} products
              </Button>
            ) : null}
          </InlineStack>
          {result?.dryRun && result.matched.length ? (
            <Text as="p" tone="subdued" variant="bodySm">Check the list below, then press Import (keep the same file selected).</Text>
          ) : null}
          {result ? <CsvResult r={result} /> : null}
        </BlockStack>
      </Form>
    </Card>
  );
}

function CsvResult({ r }) {
  return (
    <BlockStack gap="300">
      {r.matched.length ? (
        <DataTable
          columnContentTypes={["text", "text", "numeric"]}
          headings={["Product in the file", "Master product", "Metafields"]}
          rows={r.matched.map((m) => [m.title, m.master, m.fields])}
        />
      ) : null}
      {r.unmatched.length ? (
        <Banner tone="warning" title={`${r.unmatched.length} product(s) have no master product with the same title - skipped`}>
          <List>{r.unmatched.map((u) => <List.Item key={u}>{u}</List.Item>)}</List>
        </Banner>
      ) : null}
      {r.referencesNotFound.length ? (
        <Banner tone="info" title={`${r.referencesNotFound.length} reference(s) point to something this store doesn't have - skipped`}>
          <List>{r.referencesNotFound.slice(0, 10).map((u) => <List.Item key={u}>{u}</List.Item>)}</List>
        </Banner>
      ) : null}
      {r.definitions ? (
        <Text as="p">
          Metafield definitions created: {r.definitions.created.length ? r.definitions.created.join(", ") : "none needed"}
          {r.definitions.failed.length ? ` - failed: ${r.definitions.failed.join("; ")}` : ""}
        </Text>
      ) : null}
      {r.baseErrors?.length ? (
        <Banner tone="critical" title="Some base products were not updated">
          <List>{r.baseErrors.map((u) => <List.Item key={u}>{u}</List.Item>)}</List>
        </Banner>
      ) : null}
      {r.skippedColumns.length ? (
        <Text as="p" tone="subdued" variant="bodySm">Not imported: {r.skippedColumns.join(", ")}</Text>
      ) : null}
    </BlockStack>
  );
}

export default function Settings() {
  const { settings, counters, csvImported } = useLoaderData();
  const actionData = useActionData();
  const busy = useBusy();
  const known = new Set(GROUPS.map((g) => g[0]));
  const other = settings.filter((s) => !known.has(s.group) && !ON_EMAILS_PAGE.has(s.group));
  const [counterValues, setCounterValues] = useState(Object.fromEntries(counters.map((c) => [c.prefix, String(c.seq)])));

  return (
    <Page title="Settings">
      <BlockStack gap="400">
        <ActionResult data={actionData} />
        <Card>
          <InlineStack align="space-between" blockAlign="center" gap="300">
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">Emails &amp; SMS</Text>
              <Text as="p" tone="subdued">
                Prescription emails, reminders and their timing, SMS messages and the welcome email are edited on the
                Emails page - one tab per message, with a preview and a test send.
              </Text>
            </BlockStack>
            <Button url="/app/emails">Open Emails</Button>
          </InlineStack>
        </Card>
        {GROUPS.map(([id, title]) => {
          const rows = settings.filter((s) => s.group === id);
          return rows.length ? <Group key={id} title={title} rows={rows} busy={busy} /> : null;
        })}
        {other.length ? <Group title="Other (imported)" rows={other} busy={busy} /> : null}
        <MetafieldCsvImport done={csvImported} result={actionData?.csv} busy={busy} />
        <Card>
          <Form method="post">
            <input type="hidden" name="intent" value="counters" />
            <FormLayout>
              <Text as="h2" variant="headingMd">ID counters</Text>
              <Text as="p" tone="subdued">
                The last number used for each id prefix. The next account gets the following number.
              </Text>
              <FormLayout.Group condensed>
                {counters.map((c) => (
                  <TextField
                    key={c.prefix}
                    label={c.prefix}
                    name={"counter:" + c.prefix}
                    type="number"
                    value={counterValues[c.prefix]}
                    onChange={(v) => setCounterValues((s) => ({ ...s, [c.prefix]: v }))}
                    autoComplete="off"
                  />
                ))}
              </FormLayout.Group>
              <InlineStack>
                <Button submit loading={busy}>Save counters</Button>
              </InlineStack>
            </FormLayout>
          </Form>
        </Card>
      </BlockStack>
    </Page>
  );
}
