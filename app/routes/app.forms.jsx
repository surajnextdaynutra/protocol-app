import { useState } from "react";
import { Form, useLoaderData } from "@remix-run/react";
import { BlockStack, Button, Card, DataTable, InlineStack, Page, Select, Text } from "@shopify/polaris";

import { Pager, dateTime, paging } from "../components/admin";
import { connectDb } from "../db.server";
import { FormEntry } from "../models/index.server";
import { authenticate } from "../shopify.server";

/* Form entries - the "Sales Referral Form Data" and "Contact Form
   Submissions" tabs. */

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  await connectDb();
  const { url, page, pageSize, skip } = paging(request, 25);
  const form = url.searchParams.get("form") || "referral";
  const filter = { form };
  const [rows, total] = await Promise.all([
    FormEntry.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
    FormEntry.countDocuments(filter),
  ]);
  return {
    form, page, pageSize, total,
    rows: rows.map((r) => ({ id: String(r._id), at: dateTime(r.createdAt), status: r.status, data: r.data || {} })),
  };
};

const REFERRAL_COLS = [
  ["practiceName", "Practice"], ["contactEmail", "Contact"], ["state", "State"],
  ["numPhysicians", "Physicians"], ["quotePlan", "Plan"], ["repName", "Rep"],
];
const CONTACT_COLS = [["name", "Name"], ["email", "Email"], ["phone", "Phone"], ["message", "Message"], ["pageUrl", "Page"]];

export default function Forms() {
  const data = useLoaderData();
  const [form, setForm] = useState(data.form);
  const [open, setOpen] = useState(null);
  const cols = data.form === "contact" ? CONTACT_COLS : REFERRAL_COLS;

  return (
    <Page title="Form entries" fullWidth>
      <BlockStack gap="400">
        <Card>
          <Form method="get">
            <InlineStack gap="300" blockAlign="end">
              <Select label="Form" name="form" value={form} onChange={setForm}
                options={[{ label: "New client / sales referral", value: "referral" }, { label: "Contact / support", value: "contact" }]} />
              <Button submit variant="primary">Show</Button>
            </InlineStack>
          </Form>
        </Card>
        <Card padding="0">
          <DataTable
            columnContentTypes={["text", ...cols.map(() => "text"), "text"]}
            headings={["Received", ...cols.map((c) => c[1]), ""]}
            rows={data.rows.map((r) => [
              r.at,
              ...cols.map(([k]) => (
                <div key={k} style={{ maxWidth: 260, whiteSpace: "normal" }}>{String(r.data[k] ?? "")}</div>
              )),
              <Button key={r.id} size="micro" onClick={() => setOpen(open === r.id ? null : r.id)}>
                {open === r.id ? "Hide" : "All fields"}
              </Button>,
            ])}
          />
        </Card>
        {data.rows.filter((r) => r.id === open).map((r) => (
          <Card key={r.id}>
            <BlockStack gap="100">
              {Object.entries(r.data).map(([k, v]) => (
                <Text as="p" key={k}><b>{k}:</b> {String(v ?? "")}</Text>
              ))}
            </BlockStack>
          </Card>
        ))}
        <Pager page={data.page} pageSize={data.pageSize} total={data.total} />
      </BlockStack>
    </Page>
  );
}
