import { useState } from "react";
import { useLoaderData } from "@remix-run/react";
import { BlockStack, Button, Card, DataTable, Modal, Page, Text } from "@shopify/polaris";

import { dateTime } from "../components/admin";
import { BankingRecord } from "../components/banking-record";
import { connectDb } from "../db.server";
import { Account } from "../models/index.server";
import { bankingSections, listBanking } from "../services/banking.server";
import { authenticate } from "../shopify.server";

/* Banking details saved from the practice / clinic / sales rep dashboards.
   Stored encrypted; shown here so finance can pay people. The table is the
   summary; "View more" opens every field of the record in a popup. */

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  let rows = [];
  let error = "";
  try {
    rows = await listBanking();
  } catch (err) {
    error = String(err.message || err);
  }
  // updatedBy holds a customer id - show who that is
  await connectDb();
  const ids = [...new Set(rows.map((r) => r.updatedBy).filter((v) => /^\d+$/.test(String(v))))];
  const who = Object.fromEntries(
    (await Account.find({ customerId: { $in: ids } }, { customerId: 1, email: 1, first: 1, last: 1 }).lean())
      .map((a) => [a.customerId, `${a.first} ${a.last}`.trim() || a.email]),
  );
  const pick = (f, ...keys) => keys.map((k) => f[k]).find(Boolean) || "";
  return {
    error,
    rows: rows.map((r) => ({
      owner: `${r.ownerType} ${r.ownerId}`,
      holder: pick(r.fields, "account_holder_business_name", "holderBusinessName"),
      bank: pick(r.fields, "bank_name", "bankName"),
      routing: pick(r.fields, "bank_routing_ach", "bankRouting"),
      account: pick(r.fields, "bank_holder_account_number", "accountNumber"),
      bankAddress: [
        pick(r.fields, "bank_address_1", "bankAddress1"),
        pick(r.fields, "bank_city", "bankCity"),
        pick(r.fields, "bank_state", "bankState"),
        pick(r.fields, "bank_zip_postal", "bankZip"),
      ].filter(Boolean).join(", "),
      holderAddress: [
        pick(r.fields, "account_holder_address_1", "holderAddress1"),
        pick(r.fields, "account_holder_city", "holderCity"),
        pick(r.fields, "account_holder_state", "holderState"),
        pick(r.fields, "account_holder_zip_postal", "holderZip"),
      ].filter(Boolean).join(", "),
      phone: pick(r.fields, "account_holder_phone", "holderPhone"),
      updated: dateTime(r.updatedAt),
      updatedBy: who[r.updatedBy] || r.updatedBy || "",
      // every field, for the "View more" popup
      decryptError: r.fields.error || "",
      sections: r.fields.error ? [] : bankingSections(r.fields),
    })),
  };
};

export default function BankingPage() {
  const { rows, error } = useLoaderData();
  const [open, setOpen] = useState(null); // row shown in the popup
  return (
    <Page title="Banking details" subtitle="Encrypted at rest. Visible to store staff who can open this app." fullWidth>
      <BlockStack gap="400">
        {error ? <Text as="p" tone="critical">{error}</Text> : null}
        <Card padding="0">
          <DataTable
            columnContentTypes={["text", "text", "text", "text", "text", "text", "text", "text", "text", "text"]}
            headings={["Owner", "Account holder", "Bank", "Routing (ACH)", "Account #", "Bank address", "Holder address", "Phone", "Updated", ""]}
            rows={rows.map((r) => [
              r.owner, r.holder, r.bank, r.routing, r.account, r.bankAddress, r.holderAddress, r.phone, r.updated,
              <Button key={r.owner} size="micro" onClick={() => setOpen(r)}>View more</Button>,
            ])}
          />
        </Card>
      </BlockStack>

      <Modal
        open={!!open}
        onClose={() => setOpen(null)}
        title={open ? `Banking details - ${open.owner}` : ""}
        secondaryActions={[{ content: "Close", onAction: () => setOpen(null) }]}
      >
        <Modal.Section>
          {open?.decryptError ? (
            <Text as="p" tone="critical">{open.decryptError}</Text>
          ) : (
            <BlockStack gap="400">
              <BankingRecord sections={open?.sections} />
              <Text as="p" tone="subdued" variant="bodySm">
                Last updated {open?.updated}{open?.updatedBy ? ` by ${open.updatedBy}` : ""}
              </Text>
            </BlockStack>
          )}
        </Modal.Section>
      </Modal>
    </Page>
  );
}
