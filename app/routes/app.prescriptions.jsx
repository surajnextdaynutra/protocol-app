import { useState } from "react";
import { Form, useLoaderData } from "@remix-run/react";
import {
  BlockStack,
  Button,
  Card,
  DataTable,
  InlineStack,
  Link,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";

import { Pager, StatusBadge, day, paging, rx } from "../components/admin";
import { connectDb } from "../db.server";
import { Prescription } from "../models/index.server";
import { authenticate } from "../shopify.server";

const STATUSES = ["Created", "Sent", "Opened", "Checkout Started", "Abandoned", "Expired", "Purchased"];

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  await connectDb();
  const { url, page, pageSize, skip } = paging(request);
  const q = (url.searchParams.get("q") || "").trim();
  const status = url.searchParams.get("status") || "";

  const filter = {};
  if (status) filter.status = status;
  if (q) {
    const re = rx(q);
    filter.$or = [
      { rxId: re }, { email: re }, { first: re }, { last: re },
      { patientId: re }, { doctorId: re }, { clinicId: re }, { practiceId: re }, { orderName: re },
    ];
  }
  const [rows, total, counts] = await Promise.all([
    Prescription.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
    Prescription.countDocuments(filter),
    Prescription.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
  ]);
  return {
    q,
    status,
    page,
    pageSize,
    total,
    counts: Object.fromEntries(counts.map((c) => [c._id || "Created", c.n])),
    rows: rows.map((r) => ({
      rxId: r.rxId,
      created: day(r.createdAt),
      patient: `${r.first} ${r.last}`.trim(),
      email: r.email,
      physician: r.physician,
      doctorId: r.doctorId,
      practiceId: r.practiceId,
      items: r.items,
      total: r.total,
      status: r.status,
      expires: day(r.expiresAt),
      order: r.orderName,
      link: r.link,
    })),
  };
};

export default function Prescriptions() {
  const data = useLoaderData();
  const [q, setQ] = useState(data.q);
  const [status, setStatus] = useState(data.status);

  return (
    <Page title="Prescriptions" subtitle="Every protocol written in the builder, purchased or not." fullWidth>
      <BlockStack gap="400">
        <InlineStack gap="300" wrap>
          {STATUSES.map((s) => (
            <Text as="span" key={s} variant="bodySm" tone="subdued">
              {s}: <b>{data.counts[s] || 0}</b>
            </Text>
          ))}
        </InlineStack>
        <Card>
          <Form method="get">
            <InlineStack gap="300" blockAlign="end" wrap>
              <div style={{ minWidth: 280 }}>
                <TextField
                  label="Search"
                  name="q"
                  value={q}
                  onChange={setQ}
                  placeholder="Rx ID, patient, email, doctor / practice id, order"
                  autoComplete="off"
                />
              </div>
              <Select
                label="Status"
                name="status"
                value={status}
                onChange={setStatus}
                options={[{ label: "All statuses", value: "" }, ...STATUSES.map((s) => ({ label: s, value: s }))]}
              />
              <Button submit variant="primary">Filter</Button>
            </InlineStack>
          </Form>
        </Card>
        <Card padding="0">
          <DataTable
            columnContentTypes={["text", "text", "text", "text", "text", "text", "text", "text", "text", "text"]}
            headings={["Rx ID", "Created", "Patient", "Physician", "Practice", "Items", "Total", "Status", "Expires", "Order"]}
            rows={data.rows.map((r) => [
              r.link ? <Link url={r.link} target="_blank" removeUnderline>{r.rxId}</Link> : r.rxId,
              r.created,
              <BlockStack key={r.rxId} gap="0">
                <Text as="span">{r.patient}</Text>
                <Text as="span" tone="subdued" variant="bodySm">{r.email}</Text>
              </BlockStack>,
              `${r.physician || ""} ${r.doctorId ? `(${r.doctorId})` : ""}`.trim(),
              r.practiceId,
              <div key={r.rxId + "i"} style={{ maxWidth: 320, whiteSpace: "normal" }}>{r.items}</div>,
              r.total,
              <StatusBadge key={r.rxId + "s"} status={r.status} />,
              r.expires,
              r.order,
            ])}
          />
        </Card>
        <Pager page={data.page} pageSize={data.pageSize} total={data.total} />
      </BlockStack>
    </Page>
  );
}
