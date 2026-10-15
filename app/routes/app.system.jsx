import { useState } from "react";
import { Form, useActionData, useLoaderData, useSubmit } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  DataTable,
  FormLayout,
  InlineStack,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";

import { ActionResult, Pager, dateTime, paging, useBusy } from "../components/admin";
import { connectDb } from "../db.server";
import { Log, WebhookEvent } from "../models/index.server";
import { IMPORT_KINDS, importCsv } from "../services/import.server";
import { logEvent } from "../services/log.server";
import { backfillOrders } from "../services/orders.server";
import { listJobs, runJob } from "../services/scheduler.server";
import { authenticate } from "../shopify.server";

/* Sync & logs - run a job now, import the old Google Sheet tabs, pull the
   order history from Shopify, and see what the app has been doing. */

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  await connectDb();
  const { url, page, pageSize, skip } = paging(request, 50);
  const type = url.searchParams.get("type") || "";
  const filter = type ? { type } : {};
  const [logs, logTotal, failed, types] = await Promise.all([
    Log.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(pageSize).lean(),
    Log.countDocuments(filter),
    WebhookEvent.find({ status: "failed" }).sort({ createdAt: -1 }).limit(50).lean(),
    Log.distinct("type"),
  ]);
  return {
    type,
    page,
    pageSize,
    logTotal,
    types: types.sort(),
    jobs: listJobs(),
    importKinds: IMPORT_KINDS,
    logs: logs.map((l) => ({ id: String(l._id), at: dateTime(l.createdAt), type: l.type, ref: l.ref, message: l.message, ok: l.ok })),
    failed: failed.map((w) => ({ id: w._id, at: dateTime(w.createdAt), topic: w.topic, ref: w.ref, error: w.error })),
  };
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
  const f = await request.formData();
  const intent = f.get("intent");
  try {
    if (intent === "job") {
      const name = String(f.get("name"));
      const res = await runJob(name);
      if (res.skipped) return { ok: false, message: `${name} is already running.` };
      return res.ok
        ? { ok: true, message: `${name} finished in ${res.ms} ms: ${JSON.stringify(res.result ?? {})}` }
        : { ok: false, message: `${name} failed: ${res.error}` };
    }
    if (intent === "import") {
      const res = await importCsv(String(f.get("kind")), String(f.get("csv") || ""));
      return res.ok
        ? { ok: true, message: `Imported ${res.imported} of ${res.rows} row(s).` }
        : { ok: false, message: res.error };
    }
    if (intent === "backfill") {
      // A full history import can take minutes - run it in the background.
      const since = String(f.get("since") || "").trim();
      backfillOrders({ sinceIso: since ? new Date(since).toISOString() : undefined })
        .then((r) => logEvent("job", "order-backfill", `finished: ${JSON.stringify(r)}`))
        .catch((err) => logEvent("error", "order-backfill", String(err), null, false));
      return { ok: true, message: "Order history import started. Watch the log below for 'order-backfill'." };
    }
    if (intent === "clearFailed") {
      await WebhookEvent.deleteMany({ status: "failed" });
      return { ok: true, message: "Failed webhook list cleared." };
    }
  } catch (err) {
    return { ok: false, message: String(err.message || err) };
  }
  return { ok: false, message: "Unknown action" };
};

function ImportCard({ kinds, busy }) {
  const [kind, setKind] = useState(kinds[0].id);
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const onFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result || ""));
    reader.readAsText(file);
  };
  return (
    <Card>
      <Form method="post">
        <input type="hidden" name="intent" value="import" />
        <input type="hidden" name="csv" value={csv} />
        <FormLayout>
          <Text as="h2" variant="headingMd">Import from Google Sheets</Text>
          <Text as="p" tone="subdued">
            In the sheet: open a tab, then File → Download → Comma-separated values (.csv). Pick the matching tab
            below and upload it. Importing the same file again changes nothing.
          </Text>
          <FormLayout.Group>
            <Select label="Sheet tab" name="kind" value={kind} onChange={setKind}
              options={kinds.map((k) => ({ label: k.label, value: k.id }))} />
            <div>
              <Text as="p" variant="bodyMd">CSV file</Text>
              <input type="file" accept=".csv,text/csv" onChange={onFile} style={{ marginTop: 6 }} />
              {fileName ? <Text as="p" tone="subdued" variant="bodySm">{fileName} · {csv.length.toLocaleString()} characters</Text> : null}
            </div>
          </FormLayout.Group>
          <InlineStack>
            <Button submit variant="primary" disabled={!csv} loading={busy}>Import</Button>
          </InlineStack>
        </FormLayout>
      </Form>
    </Card>
  );
}

export default function System() {
  const data = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const busy = useBusy();
  const [since, setSince] = useState("");
  const [type, setType] = useState(data.type);

  return (
    <Page title="Sync & logs" fullWidth>
      <BlockStack gap="400">
        <ActionResult data={actionData} />

        <Card padding="0">
          <DataTable
            columnContentTypes={["text", "text", "text"]}
            headings={["Background job", "Schedule (cron)", ""]}
            rows={data.jobs.map((j) => [
              j.name,
              j.schedule,
              <Button key={j.name} size="micro" disabled={busy || j.running}
                onClick={() => submit({ intent: "job", name: j.name }, { method: "post" })}>
                {j.running ? "Running…" : "Run now"}
              </Button>,
            ])}
          />
        </Card>

        <Card>
          <Form method="post">
            <input type="hidden" name="intent" value="backfill" />
            <FormLayout>
              <Text as="h2" variant="headingMd">Import order history from Shopify</Text>
              <Text as="p" tone="subdued">
                Run once after installing. Copies existing orders into the app's database so the dashboards show
                history. Orders older than 60 days need the read_all_orders permission on the app.
              </Text>
              <InlineStack gap="300" blockAlign="end">
                <TextField label="From date (blank = everything)" name="since" type="date" value={since} onChange={setSince} autoComplete="off" />
                <Button submit loading={busy}>Start import</Button>
              </InlineStack>
            </FormLayout>
          </Form>
        </Card>

        <ImportCard kinds={data.importKinds} busy={busy} />

        {data.failed.length ? (
          <Card padding="0">
            <BlockStack>
              <div style={{ padding: 16 }}>
                <InlineStack align="space-between">
                  <Text as="h2" variant="headingMd">Failed webhooks</Text>
                  <Button size="micro" onClick={() => submit({ intent: "clearFailed" }, { method: "post" })}>Clear list</Button>
                </InlineStack>
              </div>
              <DataTable
                columnContentTypes={["text", "text", "text", "text"]}
                headings={["When", "Topic", "Ref", "Error"]}
                rows={data.failed.map((w) => [w.at, w.topic, w.ref, <div key={w.id} style={{ maxWidth: 520, whiteSpace: "normal" }}>{w.error}</div>])}
              />
            </BlockStack>
          </Card>
        ) : null}

        <Card>
          <Form method="get">
            <InlineStack gap="300" blockAlign="end">
              <Select label="Activity log" name="type" value={type} onChange={setType}
                options={[{ label: "Everything", value: "" }, ...data.types.map((t) => ({ label: t, value: t }))]} />
              <Button submit>Show</Button>
            </InlineStack>
          </Form>
        </Card>
        <Card padding="0">
          <DataTable
            columnContentTypes={["text", "text", "text", "text"]}
            headings={["When (UTC)", "Type", "Ref", "Message"]}
            rows={data.logs.map((l) => [
              l.at,
              l.ok ? l.type : <Badge key={l.id} tone="critical">{l.type}</Badge>,
              l.ref,
              <div key={l.id + "m"} style={{ maxWidth: 720, whiteSpace: "normal", wordBreak: "break-word" }}>{l.message}</div>,
            ])}
          />
        </Card>
        <Pager page={data.page} pageSize={data.pageSize} total={data.logTotal} />
      </BlockStack>
    </Page>
  );
}
