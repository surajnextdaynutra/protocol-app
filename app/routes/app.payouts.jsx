import { useEffect, useState } from "react";
import { Form, useActionData, useFetcher, useLoaderData, useSubmit } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  DataTable,
  InlineStack,
  Modal,
  Page,
  Select,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";

import { ActionResult, Pager, StatusBadge, dateTime, day, money, paging, rx, useBusy } from "../components/admin";
import { BankingRecord } from "../components/banking-record";
import { connectDb } from "../db.server";
import { Account, MonthlyPayout, SalesRep } from "../models/index.server";
import { bankingForPayout } from "../services/banking.server";
import { PAID_EXPR, rebuildMonthlyPayouts, setPayoutRecordStatus } from "../services/commission.server";
import { invalidateResponses } from "../services/response-cache.server";
import { logEvent } from "../services/log.server";
import { auditDeletedOrders } from "../services/orders.server";
import { authenticate } from "../shopify.server";

/* Payouts - the "Monthly Payout Summary": one row per month / role / id.
   Amounts are maintained by the order pipeline; finance marks a record
   Paid (with date + transaction #) or Undoes it. Commission logged after a
   month was paid goes on a NEW record of that month, never on the paid one;
   Undo puts the whole paid amount back to Pending. */

async function nameMap() {
  const map = {};
  const accounts = await Account.find({}, {
    first: 1, last: 1, company: 1, practiceName: 1, clinicName: 1,
    doctorId: 1, clinicId: 1, practiceId: 1, repId: 1,
  }).lean();
  for (const a of accounts) {
    const person = `${a.first} ${a.last}`.trim();
    if (a.repId) map["Rep|" + a.repId] ||= person;
    else if (a.doctorId) map["Doctor|" + a.doctorId] ||= person;
    else if (a.clinicId) map["Clinic|" + a.clinicId] ||= a.company || person;
    else if (a.practiceId) map["Practice|" + a.practiceId] ||= a.company || person;
  }
  // A solo doctor is practice + clinic + doctor on ONE account (it carries a
  // doctor_id), so its practice and clinic have no master account of their
  // own and showed no name. Fall back to the account that holds the id.
  for (const a of accounts) {
    if (a.repId) continue;
    const label = a.company || `${a.first} ${a.last}`.trim();
    if (a.practiceId) map["Practice|" + a.practiceId] ||= a.practiceName || label;
    if (a.clinicId) map["Clinic|" + a.clinicId] ||= a.clinicName || label;
  }
  for (const r of await SalesRep.find({}, { repId: 1, name: 1 }).lean()) map["Rep|" + r.repId] ||= r.name;
  return map;
}

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  await connectDb();
  const { url, page, pageSize, skip } = paging(request);
  const q = (url.searchParams.get("q") || "").trim();
  const role = url.searchParams.get("role") || "";
  const status = url.searchParams.get("status") || "";
  const month = url.searchParams.get("month") || "";

  const filter = { amount: { $ne: 0 } };
  if (role) filter.role = role;
  if (status) filter.status = status === "Paid" ? "Paid" : { $ne: "Paid" };
  if (month) filter.month = month;
  if (q) filter.entityId = rx(q);

  const [rows, total, months, sums, names] = await Promise.all([
    MonthlyPayout.find(filter).sort({ month: -1, role: 1, entityId: 1, seq: 1 }).skip(skip).limit(pageSize).lean(),
    MonthlyPayout.countDocuments(filter),
    MonthlyPayout.distinct("month"),
    MonthlyPayout.aggregate([
      { $match: filter },
      { $group: { _id: null, amount: { $sum: "$amount" }, paid: { $sum: PAID_EXPR } } },
    ]),
    nameMap(),
  ]);
  const sum = { paid: sums[0]?.paid || 0, pending: Math.max(0, (sums[0]?.amount || 0) - (sums[0]?.paid || 0)) };
  return {
    q, role, status, month, page, pageSize, total,
    months: months.sort().reverse(),
    paid: sum.paid || 0,
    pending: sum.pending || 0,
    rows: rows.map((r) => ({
      id: String(r._id),
      month: r.month,
      role: r.role,
      entityId: r.entityId,
      name: names[`${r.role}|${r.entityId}`] || "",
      seq: r.seq || 0,
      amount: r.amount,
      status: r.status === "Paid" ? "Paid" : "Pending",
      datePaid: r.datePaid,
      transactionNo: r.transactionNo,
    })),
  };
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
  const f = await request.formData();
  const intent = f.get("intent");
  // Rebuild the summary amounts from the orders' logged commission
  // (was Payouts.gs recalculateMonthlyPayoutSummary) - preview first.
  if (intent === "rebuild-preview" || intent === "rebuild-apply") {
    const res = await rebuildMonthlyPayouts({ dryRun: intent === "rebuild-preview" });
    const n = res.changed + res.created;
    if (intent === "rebuild-apply") {
      return { ok: true, message: n ? `Payout summary rebuilt from ${res.orders} orders - ${n} row(s) corrected.` : "Already correct - nothing changed." };
    }
    return { ok: true, message: n ? `${n} row(s) differ from the orders - review below.` : `All ${res.rows} payout rows match the orders.`, rebuild: res };
  }
  // "Bank details" popup: the record this row is paid to - read on demand,
  // never sent to the page with the list.
  if (intent === "bank") {
    return { bank: await bankingForPayout(String(f.get("role")), String(f.get("entityId"))) };
  }
  // Every logged order checked against Shopify (was checkAllDeletedOrdersNow).
  if (intent === "deleted-audit") {
    auditDeletedOrders()
      .then((r) => logEvent("job", "deleted-orders-audit", "finished: " + JSON.stringify(r)))
      .catch((err) => logEvent("error", "deleted-orders-audit", String(err), null, false));
    return { ok: true, message: "Checking every order against Shopify in the background - see Sync & logs for 'deleted-orders-audit'." };
  }
  invalidateResponses();
  const status = f.get("status") === "Paid" ? "Paid" : "Pending";
  const res = await setPayoutRecordStatus({ rowId: String(f.get("rowId") || "") }, status, {
    datePaid: f.get("datePaid"),
    transactionNo: f.get("transactionNo"),
  });
  if (!res.ok) return { ok: false, message: res.error };
  const r = res.row;
  return {
    ok: true,
    message: status === "Paid"
      ? `${r.role} ${r.entityId} - ${r.month}: ${money(r.amount)} marked Paid.`
      : `${r.role} ${r.entityId} - ${r.month}: back to Pending - ${money(r.amount)} owed${res.merged ? " (joined with the newer unpaid commission)" : ""}.`,
  };
};

export default function Payouts() {
  const data = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const busy = useBusy();
  const [q, setQ] = useState(data.q);
  const [role, setRole] = useState(data.role);
  const [status, setStatus] = useState(data.status);
  const [month, setMonth] = useState(data.month);
  const [paying, setPaying] = useState(null);
  const [datePaid, setDatePaid] = useState(day(new Date()));
  const [transactionNo, setTransactionNo] = useState("");

  const [rebuild, setRebuild] = useState(null);
  const [bankFor, setBankFor] = useState(null); // payout row whose bank details are open
  const bankFetcher = useFetcher();
  const openBank = (r) => {
    setBankFor(r);
    bankFetcher.submit({ intent: "bank", role: r.role, entityId: r.entityId }, { method: "post" });
  };
  const bank = bankFor && bankFetcher.state === "idle" ? bankFetcher.data?.bank : null;
  useEffect(() => { if (actionData?.rebuild) setRebuild(actionData.rebuild); }, [actionData]);

  const save = (row, newStatus) => {
    submit(
      { rowId: row.id, status: newStatus, datePaid, transactionNo },
      { method: "post" },
    );
    setPaying(null);
    setTransactionNo("");
  };

  return (
    <Page
      title="Payouts"
      subtitle="Who is owed what, month by month."
      fullWidth
      secondaryActions={[
        { content: "Check payout totals", disabled: busy, onAction: () => submit({ intent: "rebuild-preview" }, { method: "post" }) },
        { content: "Audit deleted orders", disabled: busy, onAction: () => submit({ intent: "deleted-audit" }, { method: "post" }) },
      ]}
    >
      <BlockStack gap="400">
        <ActionResult data={actionData} />
        <InlineStack gap="500">
          <Text as="span">Pending in this view: <b>{money(data.pending)}</b></Text>
          <Text as="span">Paid in this view: <b>{money(data.paid)}</b></Text>
        </InlineStack>
        <Card>
          <Form method="get">
            <InlineStack gap="300" blockAlign="end" wrap>
              <TextField label="ID" name="q" value={q} onChange={setQ} placeholder="PRA… / DOC… / RAP…" autoComplete="off" />
              <Select label="Month" name="month" value={month} onChange={setMonth}
                options={[{ label: "All months", value: "" }, ...data.months.map((m) => ({ label: m, value: m }))]} />
              <Select label="Role" name="role" value={role} onChange={setRole}
                options={[{ label: "All roles", value: "" }, "Practice", "Doctor", "Rep", "Clinic"].map((o) => (typeof o === "string" ? { label: o, value: o } : o))} />
              <Select label="Status" name="status" value={status} onChange={setStatus}
                options={[{ label: "All", value: "" }, { label: "Pending", value: "Pending" }, { label: "Paid", value: "Paid" }]} />
              <Button submit variant="primary">Filter</Button>
            </InlineStack>
          </Form>
        </Card>
        <Card padding="0">
          <DataTable
            columnContentTypes={["text", "text", "text", "text", "numeric", "text", "text", "text", "text"]}
            headings={["Month", "Role", "ID", "Name", "Amount", "Status", "Date paid", "Transaction #", ""]}
            rows={data.rows.map((r) => [
              r.seq ? <InlineStack key={r.id + "m"} gap="100">{r.month}<Badge>{`#${r.seq + 1}`}</Badge></InlineStack> : r.month,
              r.role, r.entityId, r.name, money(r.amount),
              <StatusBadge key={r.id} status={r.status} />,
              r.datePaid, r.transactionNo,
              <InlineStack key={r.id + "a"} gap="200" wrap={false} align="end">
                <Button size="micro" onClick={() => openBank(r)}>Bank details</Button>
                {r.status === "Paid" ? (
                  <Button size="micro" disabled={busy} onClick={() => save(r, "Pending")}>Undo</Button>
                ) : (
                  <Button size="micro" variant="primary" disabled={busy} onClick={() => setPaying(r)}>Mark paid</Button>
                )}
              </InlineStack>,
            ])}
          />
        </Card>
        <Pager page={data.page} pageSize={data.pageSize} total={data.total} />
      </BlockStack>

      <Modal
        open={!!paying}
        onClose={() => setPaying(null)}
        title={paying ? `Mark paid - ${paying.role} ${paying.entityId} (${paying.month})` : ""}
        primaryAction={{ content: "Mark paid", onAction: () => save(paying, "Paid"), disabled: busy }}
        secondaryActions={[{ content: "Cancel", onAction: () => setPaying(null) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p">Amount: <b>{paying ? money(paying.amount) : ""}</b></Text>
            <Text as="p" tone="subdued">Commission logged after this is marked paid goes on a new record for the same month.</Text>
            <TextField label="Date paid" type="date" value={datePaid} onChange={setDatePaid} autoComplete="off" />
            <TextField label="Transaction / confirmation #" value={transactionNo} onChange={setTransactionNo} autoComplete="off" />
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        open={!!bankFor}
        onClose={() => setBankFor(null)}
        title={bankFor ? `Bank details - ${bankFor.role} ${bankFor.entityId}${bankFor.name ? " (" + bankFor.name + ")" : ""}` : ""}
        primaryAction={
          bankFor && bankFor.status !== "Paid" && bank?.found
            ? { content: "Mark paid", onAction: () => { setPaying(bankFor); setBankFor(null); } }
            : undefined
        }
        secondaryActions={[{ content: "Close", onAction: () => setBankFor(null) }]}
      >
        <Modal.Section>
          {!bank ? (
            <InlineStack gap="200" blockAlign="center">
              <Spinner size="small" accessibilityLabel="Loading bank details" />
              <Text as="span" tone="subdued">Loading…</Text>
            </InlineStack>
          ) : bank.found ? (
            <BlockStack gap="300">
              <Text as="p">Amount: <b>{money(bankFor.amount)}</b> · {bankFor.month}</Text>
              {bank.note ? <Text as="p" tone="subdued">{bank.note}</Text> : null}
              <BankingRecord sections={bank.sections} />
              {bank.updatedAt ? <Text as="p" tone="subdued" variant="bodySm">Last updated {dateTime(bank.updatedAt)}</Text> : null}
            </BlockStack>
          ) : (
            <BlockStack gap="200">
              <Text as="p">No banking details saved for {bank.owner}.</Text>
              {bank.note ? <Text as="p" tone="subdued">{bank.note}</Text> : null}
              <Text as="p" tone="subdued">They can add them under Banking Details on their dashboard.</Text>
            </BlockStack>
          )}
        </Modal.Section>
      </Modal>

      {/* Payout totals vs the orders - preview, then apply. Status / Date Paid / Transaction # never change. */}
      <Modal
        open={!!rebuild && rebuild.changed + rebuild.created > 0}
        onClose={() => setRebuild(null)}
        large
        title="Payout totals that differ from the orders"
        primaryAction={{
          content: "Correct these amounts",
          loading: busy,
          onAction: () => { submit({ intent: "rebuild-apply" }, { method: "post" }); setRebuild(null); },
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setRebuild(null) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p">
              Rebuilt from {rebuild?.orders} orders' logged commission: {rebuild?.changed} row(s) with a different amount,{" "}
              {rebuild?.created} missing row(s). Only the amount changes - status, date paid and transaction # stay as they are,
              and a row that now totals $0 is kept, not deleted.
            </Text>
            <DataTable
              columnContentTypes={["text", "text", "text", "numeric", "numeric", "text"]}
              headings={["Month", "Role", "ID", "Now", "Should be", "Status"]}
              rows={(rebuild?.changes || []).map((c) => [
                c.month, c.role, c.entityId, c.from === null ? "(missing)" : money(c.from), money(c.to), c.status,
              ])}
            />
            {(rebuild?.changed || 0) + (rebuild?.created || 0) > (rebuild?.changes || []).length ? (
              <Text as="p" tone="subdued">Showing the first {(rebuild?.changes || []).length}; all are corrected.</Text>
            ) : null}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
