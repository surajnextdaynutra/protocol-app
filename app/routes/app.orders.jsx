import { useState } from "react";
import { Form, useActionData, useLoaderData, useSubmit } from "@remix-run/react";
import {
  BlockStack,
  Button,
  Card,
  DataTable,
  InlineStack,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";

import { ActionResult, Pager, StatusBadge, SyncStatus, day, money, paging, rx, useBusy, useRefreshWhile } from "../components/admin";
import { connectDb } from "../db.server";
import { Order } from "../models/index.server";
import { resyncOrderCommission } from "../services/commission.server";
import { fetchOrders, processOrder, syncRecentOrders } from "../services/orders.server";
import { autoSync } from "../services/autosync.server";
import { authenticate } from "../shopify.server";

/* Orders & commissions - the ledger that used to be the "Order Commission
   Log" tab: one row per order with its Doctor / Clinic / Practice / Rep split. */

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  await connectDb();
  // Every open / refresh pulls the last 2 days of orders from Shopify (catches
  // anything a webhook missed); at most once a minute.
  const sync = autoSync("orders-recent", () => syncRecentOrders({ days: 2 }), { minIntervalMs: 60_000 });
  const { url, page, pageSize, skip } = paging(request);
  const q = (url.searchParams.get("q") || "").trim();
  const view = url.searchParams.get("view") || "ledger";

  const filter = {};
  if (view === "ledger") filter["commission.logged"] = true;
  else if (view === "rx") filter.tags = "rx";
  else if (view === "unlogged") Object.assign(filter, { tags: "rx", "commission.logged": { $ne: true } });
  else if (view === "deleted") filter["commission.status"] = "Deleted";
  if (q) {
    const re = rx(q);
    filter.$or = [
      { name: re }, { email: re }, { doctorId: re }, { clinicId: re }, { practiceId: re },
      { rxId: re }, { "commission.repId": re }, { "customer.last": re },
    ];
  }
  const [rows, total, sums] = await Promise.all([
    Order.find(filter).sort({ orderCreatedAt: -1 }).skip(skip).limit(pageSize).lean(),
    Order.countDocuments(filter),
    Order.aggregate([
      { $match: { "commission.logged": true, "commission.status": { $ne: "Deleted" }, demo: { $ne: true } } },
      {
        $group: {
          _id: null,
          doctor: { $sum: "$commission.doctorAmt" },
          clinic: { $sum: "$commission.clinicAmt" },
          practice: { $sum: "$commission.practiceAmt" },
          rep: { $sum: "$commission.repAmt" },
          n: { $sum: 1 },
        },
      },
    ]),
  ]);
  return {
    sync,
    q,
    view,
    page,
    pageSize,
    total,
    sums: sums[0] || { doctor: 0, clinic: 0, practice: 0, rep: 0, n: 0 },
    rows: rows.map((o) => ({
      id: o.orderId,
      name: o.name,
      date: day(o.orderCreatedAt),
      customer: [o.customer?.first, o.customer?.last].filter(Boolean).join(" "),
      doctor: o.commission?.doctorId || o.doctorId || o.wsDoctorId,
      clinic: o.commission?.clinicId || o.clinicId || o.wsClinicId,
      practice: o.commission?.practiceId || o.practiceId || o.wsPracticeId,
      total: o.total,
      c: o.commission || {},
      delivery: o.deliveryStatus,
      financial: o.financialStatus,
      wholesale: o.wholesaleRole,
      demo: o.demo,
    })),
  };
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  const orderId = String(form.get("orderId") || "");
  try {
    if (intent === "resync") {
      const c = await resyncOrderCommission(orderId);
      return { ok: !!c, message: c ? "Commission recalculated at today's product rates." : "Order not found." };
    }
    if (intent === "refetch") {
      const [o] = await fetchOrders(`id:${orderId}`, { max: 1 });
      if (!o) return { ok: false, message: "Shopify did not return this order." };
      await processOrder(o, { source: "admin" });
      return { ok: true, message: `${o.name} refreshed from Shopify.` };
    }
  } catch (err) {
    return { ok: false, message: String(err.message || err) };
  }
  return { ok: false, message: "Unknown action" };
};

export default function Orders() {
  const data = useLoaderData();
  const actionData = useActionData();
  useRefreshWhile(data.sync?.syncing);
  const submit = useSubmit();
  const busy = useBusy();
  const [q, setQ] = useState(data.q);
  const [view, setView] = useState(data.view);
  const run = (intent, orderId) => submit({ intent, orderId }, { method: "post" });

  return (
    <Page title="Orders & commissions" subtitle="The commission split is frozen on each order the moment it is paid." fullWidth>
      <BlockStack gap="400">
        <ActionResult data={actionData} />
        <SyncStatus sync={data.sync} />
        <InlineStack gap="500" wrap>
          <Text as="span">Logged orders: <b>{data.sums.n}</b></Text>
          <Text as="span">Physicians: <b>{money(data.sums.doctor)}</b></Text>
          <Text as="span">Clinics: <b>{money(data.sums.clinic)}</b></Text>
          <Text as="span">Practices: <b>{money(data.sums.practice)}</b></Text>
          <Text as="span">Reps: <b>{money(data.sums.rep)}</b></Text>
        </InlineStack>
        <Card>
          <Form method="get">
            <InlineStack gap="300" blockAlign="end" wrap>
              <div style={{ minWidth: 280 }}>
                <TextField label="Search" name="q" value={q} onChange={setQ} placeholder="Order #, email, doctor / clinic / practice / rep id" autoComplete="off" />
              </div>
              <Select
                label="Show"
                name="view"
                value={view}
                onChange={setView}
                options={[
                  { label: "Commission ledger", value: "ledger" },
                  { label: "All Rx orders", value: "rx" },
                  { label: "Rx orders with no commission logged", value: "unlogged" },
                  { label: "Deleted in Shopify (reversed)", value: "deleted" },
                  { label: "Every store order", value: "all" },
                ]}
              />
              <Button submit variant="primary">Filter</Button>
            </InlineStack>
          </Form>
        </Card>
        <Card padding="0">
          <DataTable
            columnContentTypes={["text", "text", "text", "text", "text", "text", "numeric", "numeric", "numeric", "numeric", "numeric", "text", "text", "text"]}
            headings={["Order", "Date", "Customer", "Doctor", "Clinic", "Practice", "Order total", "Doctor $", "Clinic $", "Practice $", "Rep $", "Delivery", "Ledger", ""]}
            rows={data.rows.map((o) => [
              `${o.name}${o.wholesale ? " (wholesale)" : ""}${o.demo ? " (demo)" : ""}`,
              o.date,
              o.customer,
              o.doctor,
              o.clinic,
              o.practice,
              money(o.total),
              o.c.logged ? money(o.c.doctorAmt) : "-",
              o.c.logged ? money(o.c.clinicAmt) : "-",
              o.c.logged ? money(o.c.practiceAmt) : "-",
              o.c.logged ? `${money(o.c.repAmt)}${o.c.repId ? ` (${o.c.repId})` : ""}` : "-",
              o.delivery,
              o.c.logged ? <StatusBadge key={o.id} status={o.c.status} /> : o.financial,
              <InlineStack key={o.id + "a"} gap="200" wrap={false}>
                <Button size="micro" disabled={busy} onClick={() => run("refetch", o.id)}>Refresh</Button>
                {o.c.logged && o.c.status !== "Deleted" ? (
                  <Button size="micro" disabled={busy} onClick={() => run("resync", o.id)}>Recalculate</Button>
                ) : null}
              </InlineStack>,
            ])}
          />
        </Card>
        <Pager page={data.page} pageSize={data.pageSize} total={data.total} />
      </BlockStack>
    </Page>
  );
}
