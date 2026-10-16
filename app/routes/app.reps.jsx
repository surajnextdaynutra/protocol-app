import { useState } from "react";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import {
  BlockStack,
  Button,
  Card,
  Checkbox,
  FormLayout,
  InlineStack,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";

import { ActionResult, money, useBusy } from "../components/admin";
import { connectDb } from "../db.server";
import { Account, MonthlyPayout, SalesRep } from "../models/index.server";
import { PAID_EXPR } from "../services/commission.server";
import { authenticate } from "../shopify.server";

/* Sales reps - replaces the "Sales Reps" tab. The practices (or practice-less
   clinics) listed on a rep are what earn that rep commission; nothing is
   decided by tags. */

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  await connectDb();
  const [reps, owed, practices] = await Promise.all([
    SalesRep.find({}).sort({ name: 1 }).lean(),
    MonthlyPayout.aggregate([
      { $match: { role: "Rep" } },
      { $group: { _id: "$entityId", amount: { $sum: "$amount" }, paid: { $sum: PAID_EXPR } } },
    ]),
    Account.find({ practiceId: { $ne: "" } }, { practiceId: 1, company: 1, first: 1, last: 1, doctorId: 1, clinicId: 1 }).lean(),
  ]);
  const totals = {};
  for (const o of owed) {
    totals[o._id] = { paid: o.paid, pending: Math.max(0, o.amount - o.paid) };
  }
  const practiceNames = {};
  for (const a of practices) {
    const isMaster = !a.doctorId && !a.clinicId;
    if (isMaster || !practiceNames[a.practiceId]) {
      practiceNames[a.practiceId] = a.company || `${a.first} ${a.last}`.trim();
    }
  }
  return {
    practiceNames,
    reps: reps.map((r) => ({
      repId: r.repId,
      name: r.name || "",
      email: r.email || "",
      notes: r.notes || "",
      active: r.active !== false,
      assigned: (r.assignedPracticeIds || []).join(", "),
      paid: totals[r.repId]?.paid || 0,
      pending: totals[r.repId]?.pending || 0,
    })),
  };
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
  await connectDb();
  const f = await request.formData();
  const repId = String(f.get("repId") || "").trim();
  if (!repId) return { ok: false, message: "Rep ID is required." };
  const assigned = String(f.get("assigned") || "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  // a practice belongs to one rep
  await SalesRep.updateMany({ repId: { $ne: repId } }, { $pull: { assignedPracticeIds: { $in: assigned } } });
  await SalesRep.updateOne(
    { repId },
    {
      $set: {
        name: String(f.get("name") || "").trim(),
        email: String(f.get("email") || "").trim().toLowerCase(),
        notes: String(f.get("notes") || ""),
        active: f.get("active") === "true",
        assignedPracticeIds: assigned,
      },
    },
    { upsert: true },
  );
  return { ok: true, message: `Saved ${repId}.` };
};

function RepCard({ rep, practiceNames, busy, isNew }) {
  const [v, setV] = useState(rep);
  const set = (k) => (val) => setV((s) => ({ ...s, [k]: val }));
  const names = v.assigned
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((id) => (practiceNames[id] ? `${practiceNames[id]} (${id})` : id));

  return (
    <Card>
      <Form method="post">
        <FormLayout>
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h2" variant="headingMd">{isNew ? "Add a sales rep" : `${v.name || v.repId}`}</Text>
            {!isNew ? (
              <Text as="span" tone="subdued" variant="bodySm">
                Paid {money(rep.paid)} · Pending {money(rep.pending)}
              </Text>
            ) : null}
          </InlineStack>
          <FormLayout.Group>
            {isNew ? (
              <TextField label="Rep ID" name="repId" value={v.repId} onChange={set("repId")} placeholder="RAP…" autoComplete="off"
                helpText="Normally created from Accounts → role Sales Rep, which also makes the Shopify login." />
            ) : (
              <>
                <input type="hidden" name="repId" value={v.repId} />
                <TextField label="Rep ID" value={v.repId} disabled autoComplete="off" />
              </>
            )}
            <TextField label="Name" name="name" value={v.name} onChange={set("name")} autoComplete="off" />
            <TextField label="Email" name="email" value={v.email} onChange={set("email")} autoComplete="off" />
          </FormLayout.Group>
          <TextField
            label="Assigned practice ID(s)"
            name="assigned"
            value={v.assigned}
            onChange={set("assigned")}
            autoComplete="off"
            helpText={names.length ? names.join(" · ") : "Comma-separated practice ids (PRA…); a clinic id (CLN…) for a clinic with no parent practice."}
          />
          <TextField label="Notes" name="notes" value={v.notes} onChange={set("notes")} autoComplete="off" />
          <input type="hidden" name="active" value={String(v.active)} />
          <InlineStack gap="400" blockAlign="center">
            <Checkbox label="Active (earns commission)" checked={v.active} onChange={set("active")} />
            <Button submit variant="primary" loading={busy}>Save</Button>
          </InlineStack>
        </FormLayout>
      </Form>
    </Card>
  );
}

export default function Reps() {
  const { reps, practiceNames } = useLoaderData();
  const actionData = useActionData();
  const busy = useBusy();
  return (
    <Page title="Sales reps" subtitle="Which practices each rep is paid commission on.">
      <BlockStack gap="400">
        <ActionResult data={actionData} />
        {reps.map((r) => (
          <RepCard key={r.repId} rep={r} practiceNames={practiceNames} busy={busy} />
        ))}
        <RepCard
          isNew
          rep={{ repId: "", name: "", email: "", notes: "", active: true, assigned: "", paid: 0, pending: 0 }}
          practiceNames={practiceNames}
          busy={busy}
        />
      </BlockStack>
    </Page>
  );
}
