import { useEffect, useState } from "react";
import { Form, useActionData, useFetcher, useLoaderData, useRevalidator, useSubmit } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  DataTable,
  FormLayout,
  InlineStack,
  Link,
  Modal,
  Page,
  Select,
  Spinner,
  Tag,
  Text,
  TextField,
} from "@shopify/polaris";

import { ActionResult, Pager, SyncStatus, dateTime, paging, rx, useBusy } from "../components/admin";
import { connectDb } from "../db.server";
import { Account, Product, SalesRep } from "../models/index.server";
import { MasterProduct, practiceCopiesInProgress } from "../services/catalog.server";
import { syncAllAccounts } from "../services/accounts.server";
import { BULK_TEMPLATE_HEADER, bulkJobStatus, previewBulkAccounts, startBulkImport } from "../services/bulk-accounts.server";
import { autoSync } from "../services/autosync.server";
import {
  ROLES,
  createPortalAccount,
  deletePortalAccount,
  getAccountDetail,
  hasDueWelcomeEmails,
  retryWelcomeEmail,
  sendDueWelcomeEmailsSoon,
  updatePortalAccount,
} from "../services/provisioning.server";
import { getSettings } from "../services/settings.server";
import { authenticate } from "../shopify.server";

/* Accounts - replaces the "Customer details" sheet. Create a practice /
   clinic / physician / sales rep / demo account here; the Shopify customer,
   its ids and role tags, the rep assignment and the welcome email follow.
   Each row can be edited (live Shopify customer, in a popup) or deleted
   (removes the customer from the store). */

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  await connectDb();
  // The Edit popup asks for one customer's live details.
  const detailId = new URL(request.url).searchParams.get("detail");
  if (detailId) return getAccountDetail(detailId);
  // The bulk-import popup polls its running import here.
  const bulkId = new URL(request.url).searchParams.get("bulk");
  if (bulkId) return bulkJobStatus(bulkId);
  // Welcome emails already due (e.g. the app restarted before its timer
  // fired) go out now - they never wait on the background scheduler alone.
  if (await hasDueWelcomeEmails()) sendDueWelcomeEmailsSoon(0);
  // Every open / refresh pulls the accounts from Shopify (no Re-sync click);
  // the list below is what was stored, and refreshes when the sync finishes.
  const sync = autoSync("accounts", syncAllAccounts, { minIntervalMs: 30_000 });
  const { url, page, pageSize, skip } = paging(request);
  const q = (url.searchParams.get("q") || "").trim();
  const role = url.searchParams.get("role") || "";

  const filter = {};
  if (role) filter.role = role;
  if (q) {
    const re = rx(q);
    filter.$or = [
      { first: re }, { last: re }, { email: re }, { company: re },
      { doctorId: re }, { clinicId: re }, { practiceId: re }, { repId: re },
    ];
  }
  const cfg = await getSettings();
  const [rows, total, practices, clinics, reps, roles] = await Promise.all([
    Account.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(pageSize).lean(),
    Account.countDocuments(filter),
    Account.find({ practiceId: { $ne: "" }, doctorId: "", clinicId: "" }, { first: 1, last: 1, company: 1, practiceId: 1 }).lean(),
    Account.find({ clinicId: { $ne: "" }, doctorId: "" }, { first: 1, last: 1, company: 1, clinicId: 1, practiceId: 1 }).lean(),
    // only reps that still have an account - a deleted rep must not be offered
    Account.distinct("repId", { repId: { $ne: "" } }).then((ids) =>
      SalesRep.find({ repId: { $in: ids } }, { repId: 1, name: 1 }).sort({ name: 1 }).lean()),
    Account.distinct("role"),
  ]);
  const label = (a, id) => `${a.company || `${a.first} ${a.last}`.trim() || id} (${id})`;

  // Product copies per physician's practice - created automatically when the
  // physician is added; the page polls while any are still being created.
  const pracIds = [...new Set(rows.filter((a) => a.doctorId && a.practiceId).map((a) => a.practiceId))];
  const [copyCounts, masterCount] = await Promise.all([
    pracIds.length
      ? Product.aggregate([
          { $match: { practiceId: { $in: pracIds }, masterKey: { $ne: "" } } },
          { $group: { _id: "$practiceId", n: { $sum: 1 } } },
        ])
      : [],
    MasterProduct.countDocuments(),
  ]);
  const copies = Object.fromEntries(copyCounts.map((c) => [c._id, c.n]));
  const creating = new Set(practiceCopiesInProgress());
  return {
    sync,
    q, role, page, pageSize, total,
    roles: roles.filter(Boolean).sort(),
    roleOptions: ROLES,
    welcomeDelay: Number(cfg.WELCOME_EMAIL_DELAY_MINUTES) >= 0 ? Number(cfg.WELCOME_EMAIL_DELAY_MINUTES) : 30,
    bulkTemplate: BULK_TEMPLATE_HEADER,
    practiceOptions: practices.map((a) => ({ label: label(a, a.practiceId), value: a.practiceId })),
    clinicOptions: clinics.map((a) => ({ label: label(a, a.clinicId), value: a.clinicId })),
    repOptions: reps.map((r) => ({ label: `${r.name || r.repId} (${r.repId})`, value: r.repId })),
    rows: rows.map((a) => ({
      customerId: a.customerId,
      role: a.role,
      name: `${a.first} ${a.last}`.trim(),
      company: a.company,
      email: a.email,
      ids: [a.repId, a.practiceId, a.clinicId, a.doctorId].filter(Boolean).join(" · "),
      // physicians only: "creating" | number of this practice's product copies
      copies: a.doctorId && a.practiceId
        ? creating.has(a.practiceId) ? "creating" : copies[a.practiceId] || 0
        : null,
      masterCount,
      state: a.state,
      demo: a.demo,
      provisioned: !!a.provisionedAt,
      welcome: a.welcomeEmailSentAt
        ? "Sent " + dateTime(a.welcomeEmailSentAt)
        : a.welcomeResult ||
          (a.welcomeDueAt
            ? // a physician's welcome waits for their practice's products
              a.doctorId && a.practiceId &&
              (creating.has(a.practiceId) || (masterCount && (copies[a.practiceId] || 0) < masterCount))
              ? "Waiting for products - sends when ready"
              : "Due " + dateTime(a.welcomeDueAt)
            : ""),
    })),
  };
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
  const f = await request.formData();
  const intent = f.get("intent");
  try {
    if (intent === "create") {
      const res = await createPortalAccount(Object.fromEntries(f));
      if (!res.ok) return { ok: false, message: res.error };
      let message = res.updated
        ? `Already in Shopify - updated it instead (was ${res.previousRole}). Tags: ${res.tags.join(", ")}`
        : `Created. Tags: ${res.tags.join(", ")}`;
      if (res.updated && res.welcomeAlreadySent) message += " · Welcome email was already sent before, so it isn't sent again.";
      if (res.tags.some((t) => /^doctor_id:/i.test(t))) {
        message += " · Its practice's products are being created automatically; the welcome email goes out once they are ready.";
      }
      return { ok: true, message };
    }
    // Bulk accounts from a CSV: preview (nothing created), then import.
    if (intent === "bulk-preview") {
      const res = await previewBulkAccounts(String(f.get("csv") || ""));
      if (!res.ok) return { bulk: { ok: false, error: res.error } };
      return { bulk: { ok: true, counts: res.counts, rows: res.rows.map(({ _raw, ...r }) => r) } };
    }
    if (intent === "bulk-import") {
      const res = await startBulkImport(String(f.get("csv") || ""), { sendWelcome: f.get("sendWelcome") !== "false" });
      return { bulk: res.ok ? { ok: true, jobId: res.jobId, total: res.total } : { ok: false, error: res.error } };
    }
    if (intent === "sync") {
      const res = await syncAllAccounts();
      return { ok: true, message: `Synced ${res.synced} accounts from Shopify (${res.removed} removed).` };
    }
    if (intent === "welcome") {
      await retryWelcomeEmail(f.get("customerId"));
      return { ok: true, message: "Welcome email is being sent now - the result shows in the Welcome email column and in Sync & logs." };
    }
    if (intent === "update") {
      const res = await updatePortalAccount(f.get("customerId"), Object.fromEntries(f));
      return res.ok ? { ok: true, message: res.message } : { ok: false, message: res.error };
    }
    if (intent === "delete") {
      const res = await deletePortalAccount(f.get("customerId"));
      return res.ok ? { ok: true, message: res.message } : { ok: false, message: res.error };
    }
  } catch (err) {
    return { ok: false, message: String(err.message || err) };
  }
  return { ok: false, message: "Unknown action" };
};

function CreateForm({ data, busy, onBulk }) {
  const [v, setV] = useState({
    role: "Practice", firstName: "", lastName: "", email: "", clinicLocation: "",
    repId: "", parentPracticeId: "", parentClinicId: "", sendWelcome: true,
  });
  const set = (k) => (val) => setV((s) => ({ ...s, [k]: val }));
  const needsPractice = v.role === "Clinic";
  const optionalPractice = v.role === "Master Clinic";
  const needsClinic = v.role === "Physician";
  const takesRep = !["Sales Rep", "Demo"].includes(v.role);

  return (
    <Card>
      <Form method="post">
        <input type="hidden" name="intent" value="create" />
        <FormLayout>
          <Text as="h2" variant="headingMd">Create an account</Text>
          <FormLayout.Group>
            <Select label="Role" name="role" value={v.role} onChange={set("role")} options={data.roleOptions.map((r) => ({ label: r, value: r }))}
              helpText={v.role === "Demo" ? "Creates the shared demo Practice / Clinic / Physician trio from one email." : undefined} />
            <TextField label="First name" name="firstName" value={v.firstName} onChange={set("firstName")} autoComplete="off" />
            <TextField label="Last name" name="lastName" value={v.lastName} onChange={set("lastName")} autoComplete="off" disabled={v.role === "Demo"} />
            <TextField label="Email" name="email" type="email" value={v.email} onChange={set("email")} autoComplete="off" />
          </FormLayout.Group>
          <FormLayout.Group>
            {needsPractice || optionalPractice ? (
              <Select label={needsPractice ? "Parent practice" : "Parent practice (optional)"} name="parentPracticeId"
                value={v.parentPracticeId} onChange={set("parentPracticeId")}
                options={[{ label: "Select…", value: "" }, ...data.practiceOptions]} />
            ) : null}
            {needsClinic ? (
              <Select label="Parent clinic" name="parentClinicId" value={v.parentClinicId} onChange={set("parentClinicId")}
                options={[{ label: "Select…", value: "" }, ...data.clinicOptions]} />
            ) : null}
            {takesRep ? (
              <Select label="Sales representative (optional)" name="repId" value={v.repId} onChange={set("repId")}
                options={[{ label: "None", value: "" }, ...data.repOptions]} />
            ) : null}
            {v.role !== "Sales Rep" && v.role !== "Demo" ? (
              <TextField label="Clinic location (optional)" name="clinicLocation" value={v.clinicLocation} onChange={set("clinicLocation")}
                helpText="Shown on the storefront as the clinic name." autoComplete="off" />
            ) : null}
          </FormLayout.Group>
          {v.role !== "Demo" ? (
            <InlineStack gap="300" blockAlign="start">
              {/* unticked Polaris checkboxes post nothing - send the value explicitly */}
              <input type="hidden" name="sendWelcome" value={String(v.sendWelcome)} />
              <Checkbox label="Send welcome email" checked={v.sendWelcome} onChange={set("sendWelcome")}
                helpText={v.sendWelcome
                  ? ["Physician", "Practice + Doctor"].includes(v.role)
                    ? `Goes out once this practice's products are created (at least ${data.welcomeDelay} min after the account is created).`
                    : `Goes out ${data.welcomeDelay} minutes after the account is created.`
                  : "Not scheduled - use Re-send on the account's row to send it later."} />
              <Link url="/app/emails?tab=welcome">Edit welcome email</Link>
            </InlineStack>
          ) : null}
          <InlineStack gap="300">
            <Button submit variant="primary" loading={busy}>Create in Shopify</Button>
            <Button onClick={onBulk}>Add bulk accounts</Button>
          </InlineStack>
        </FormLayout>
      </Form>
    </Card>
  );
}

const STATUS_TONE = { ready: "success", update: "info", error: "critical" };
const STATUS_TEXT = { ready: "Ready", update: "Will update", error: "Error" };

/* "Add bulk accounts": CSV -> preview (nothing created) -> Import, which
   creates each account through the same path as the single form (ids,
   tags, rep, product copies, welcome email) and shows live progress. */
function BulkModal({ open, onClose, data }) {
  const fetcher = useFetcher();
  const poll = useFetcher();
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [sendWelcome, setSendWelcome] = useState(true);
  const [preview, setPreview] = useState(null);
  const [jobId, setJobId] = useState("");
  const job = jobId && poll.data?.id === jobId ? poll.data : null;

  useEffect(() => {
    const b = fetcher.data?.bulk;
    if (!b) return;
    if (b.jobId) setJobId(b.jobId);
    else setPreview(b);
  }, [fetcher.data]);

  // progress while the import runs
  useEffect(() => {
    if (!jobId || job?.finished) return undefined;
    poll.load(`/app/accounts?bulk=${jobId}`);
    const t = setInterval(() => { if (poll.state === "idle") poll.load(`/app/accounts?bulk=${jobId}`); }, 2000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, job?.finished]);

  const reset = () => { setCsv(""); setFileName(""); setPreview(null); setJobId(""); };
  const close = () => { reset(); onClose(job?.finished); };
  const onFile = (e) => {
    const file = e.target.files?.[0];
    setPreview(null);
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result || ""));
    reader.readAsText(file);
  };
  const busy = fetcher.state !== "idle";
  const importable = preview?.ok ? preview.counts.ready + preview.counts.update : 0;
  const templateHref = "data:text/csv;charset=utf-8," + encodeURIComponent(data.bulkTemplate + "\n");

  return (
    <Modal
      open={open}
      onClose={close}
      size="large"
      title="Add bulk accounts"
      primaryAction={
        jobId
          ? { content: job?.finished ? "Done" : "Importing…", onAction: close, loading: !job?.finished, disabled: !job?.finished }
          : preview?.ok
            ? { content: `Import ${importable} account${importable === 1 ? "" : "s"}`, disabled: !importable || busy, loading: busy,
                onAction: () => fetcher.submit({ intent: "bulk-import", csv, sendWelcome: String(sendWelcome) }, { method: "post" }) }
            : { content: "Preview", disabled: !csv || busy, loading: busy,
                onAction: () => fetcher.submit({ intent: "bulk-preview", csv }, { method: "post" }) }
      }
      secondaryActions={jobId ? [] : [
        ...(preview ? [{ content: "Choose another file", onAction: reset }] : []),
        { content: "Cancel", onAction: close },
      ]}
    >
      <Modal.Section>
        {jobId ? (
          <BlockStack gap="300">
            <Text as="p">
              {job ? `${job.done} of ${job.total} done - ${job.created} created, ${job.updated} updated, ${job.failed} failed` : "Starting…"}
            </Text>
            {job?.finished ? (
              <Banner tone={job.failed ? "warning" : "success"}>
                <p>
                  Import finished. Physicians' practices get their products automatically, and welcome emails go out
                  {" "}{sendWelcome ? "as scheduled (a physician's once its products are ready)" : "only where the file says yes"}.
                </p>
              </Banner>
            ) : null}
            <DataTable
              columnContentTypes={["numeric", "text", "text", "text"]}
              headings={["Row", "Email", "Role", "Result"]}
              rows={(job?.results || []).map((r) => [
                r.line, r.email, r.role,
                <Text key={r.line} as="span" tone={r.ok ? "success" : "critical"}>{r.message}</Text>,
              ])}
            />
          </BlockStack>
        ) : (
          <BlockStack gap="400">
            <Text as="p">
              Upload a CSV with these columns: <b>Role, First Name, Last Name, Email</b> (required) and <b>Sales Rep,
              Clinic Location, Parent Practice, Parent Clinic, Send Welcome</b> (optional). A Clinic needs a Parent Practice
              and a Physician a Parent Clinic - a PRA… / CLN… id, its tag (practice_id:PRA1 / clinic_id:CLN1), the email of
              that practice / clinic account (a Practice + Doctor works for both), or the email of a row in the same file.
              Sales Rep is a RAP id, rep email or rep name.
            </Text>
            <InlineStack gap="400" blockAlign="center">
              <input type="file" accept=".csv,text/csv" onChange={onFile} />
              <a href={templateHref} download="bulk-accounts-template.csv" style={{ color: "var(--p-color-text-link)" }}>Download CSV template</a>
            </InlineStack>
            {fileName ? <Text as="p" tone="subdued" variant="bodySm">{fileName}</Text> : null}
            <Checkbox label="Send welcome emails" checked={sendWelcome} onChange={setSendWelcome}
              helpText="For rows without their own Send Welcome value. A physician's email waits until its practice's products are created." />
            {preview && !preview.ok ? <Banner tone="critical"><p>{preview.error}</p></Banner> : null}
            {preview?.ok ? (
              <BlockStack gap="200">
                <InlineStack gap="200">
                  <Badge tone="success">{`${preview.counts.ready} ready`}</Badge>
                  <Badge tone="info">{`${preview.counts.update} will update`}</Badge>
                  <Badge tone={preview.counts.error ? "critical" : undefined}>{`${preview.counts.error} with errors (skipped)`}</Badge>
                </InlineStack>
                <DataTable
                  columnContentTypes={["numeric", "text", "text", "text", "text", "text", "text", "text"]}
                  headings={["Row", "Status", "Role", "Name", "Email", "Parent", "Sales rep", "Details"]}
                  rows={preview.rows.map((r) => [
                    r.line,
                    <Badge key={r.line} tone={STATUS_TONE[r.status]}>{STATUS_TEXT[r.status]}</Badge>,
                    r.role, r.name, r.email, r.parent, r.rep,
                    <Text key={r.line + "m"} as="span" tone={r.status === "error" ? "critical" : "subdued"}>{r.message || r.clinicLocation}</Text>,
                  ])}
                />
                <Text as="p" tone="subdued" variant="bodySm">Rows are created in this order (reps, practices, clinics, physicians) so parents exist first. Nothing has been created yet.</Text>
              </BlockStack>
            ) : null}
          </BlockStack>
        )}
      </Modal.Section>
    </Modal>
  );
}

/** Form state from a loaded customer (flat, so it posts as plain fields). */
const formFrom = (d) => ({
  first: d.first, last: d.last, email: d.email, phone: d.phone, note: d.note,
  taxExempt: d.taxExempt, otherTags: d.otherTags, clinicLocation: d.clinicLocation,
  repId: d.repId, addressPhone: d.address.phone,
  company: d.address.company, address1: d.address.address1, address2: d.address.address2,
  city: d.address.city, provinceCode: d.address.provinceCode, zip: d.address.zip, countryCode: d.address.countryCode,
});

/** Shopify-style customer editor, loaded live when it opens. */
function EditModal({ row, repOptions, onClose }) {
  const detailFetcher = useFetcher();
  const saver = useFetcher();
  const [v, setV] = useState(null);
  const set = (k) => (val) => setV((s) => ({ ...s, [k]: val }));
  const customerId = row?.customerId;

  useEffect(() => {
    setV(null);
    if (customerId) detailFetcher.load(`/app/accounts?detail=${encodeURIComponent(customerId)}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  // customerId is undefined while the popup is closed - never match that.
  const loaded = detailFetcher.data?.detail;
  const detail = customerId && loaded?.customerId === customerId ? loaded : null;
  // Fill once per opening - a failed save revalidates this fetcher and must
  // not wipe what was typed.
  useEffect(() => {
    if (detail) setV((cur) => cur || formFrom(detail));
  }, [detail]);

  // Close once a save succeeds; the page list revalidates on its own.
  useEffect(() => {
    if (saver.state === "idle" && saver.data?.ok) {
      if (typeof shopify !== "undefined") shopify.toast.show(saver.data.message);
      onClose();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saver.state, saver.data]);

  const saving = saver.state !== "idle";
  const save = () =>
    saver.submit({ intent: "update", customerId, ...v, taxExempt: String(!!v.taxExempt) }, { method: "post", action: "/app/accounts" });
  const loadError = detailFetcher.data && detailFetcher.data.ok === false && detailFetcher.state === "idle" ? detailFetcher.data.error : "";

  return (
    <Modal
      open={!!row}
      onClose={onClose}
      large
      title={row ? `Edit ${row.name || row.email}` : ""}
      primaryAction={{ content: "Save", onAction: save, loading: saving, disabled: !v || saving }}
      secondaryActions={[{ content: "Cancel", onAction: onClose }]}
    >
      {!v ? (
        <Modal.Section>
          {loadError ? (
            <Banner tone="critical"><p>{loadError}</p></Banner>
          ) : (
            <InlineStack align="center"><Spinner accessibilityLabel="Loading customer" size="large" /></InlineStack>
          )}
        </Modal.Section>
      ) : (
        <>
          {saver.data?.ok === false ? (
            <Modal.Section><Banner tone="critical"><p>{saver.data.message}</p></Banner></Modal.Section>
          ) : null}
          <Modal.Section>
            <FormLayout>
              <Text as="h3" variant="headingSm">Customer overview</Text>
              <FormLayout.Group>
                <TextField label="First name" value={v.first} onChange={set("first")} autoComplete="off" />
                <TextField label="Last name" value={v.last} onChange={set("last")} autoComplete="off" />
              </FormLayout.Group>
              <FormLayout.Group>
                <TextField label="Email" type="email" value={v.email} onChange={set("email")} autoComplete="off"
                  helpText="This is the portal login email." />
                <TextField label="Phone number" type="tel" value={v.phone} onChange={set("phone")} autoComplete="off"
                  helpText="International format, e.g. +1 555 123 4567." />
              </FormLayout.Group>
            </FormLayout>
          </Modal.Section>
          <Modal.Section>
            <FormLayout>
              <Text as="h3" variant="headingSm">Default address</Text>
              <TextField label="Company" value={v.company} onChange={set("company")} autoComplete="off"
                helpText="Shown as the Business on this page." />
              <TextField label="Address" value={v.address1} onChange={set("address1")} autoComplete="off" />
              <TextField label="Apartment, suite, etc." value={v.address2} onChange={set("address2")} autoComplete="off" />
              <FormLayout.Group condensed>
                <TextField label="City" value={v.city} onChange={set("city")} autoComplete="off" />
                <TextField label="State / province code" value={v.provinceCode} onChange={set("provinceCode")} autoComplete="off" placeholder="NY" />
                <TextField label="ZIP / postal code" value={v.zip} onChange={set("zip")} autoComplete="off" />
                <TextField label="Country code" value={v.countryCode} onChange={set("countryCode")} autoComplete="off" placeholder="US" />
              </FormLayout.Group>
              <TextField label="Address phone" type="tel" value={v.addressPhone} onChange={set("addressPhone")} autoComplete="off" />
            </FormLayout>
          </Modal.Section>
          <Modal.Section>
            <FormLayout>
              <Text as="h3" variant="headingSm">Portal</Text>
              <BlockStack gap="100">
                <Text as="p" tone="subdued">Role: {detail.role || "-"} · Login: {detail.state || "-"}</Text>
                <InlineStack gap="100">{detail.systemTags.map((t) => <Tag key={t}>{t}</Tag>)}</InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">
                  Role and id tags are fixed here so an edit can't change the account's role.
                </Text>
              </BlockStack>
              <FormLayout.Group>
                {detail.role !== "Sales Rep" ? (
                  <TextField label="Clinic location" value={v.clinicLocation} onChange={set("clinicLocation")} autoComplete="off"
                    helpText="Shown on the storefront as the clinic name." />
                ) : null}
                {detail.assignId ? (
                  <Select label="Sales representative" value={v.repId} onChange={set("repId")}
                    options={[{ label: "None", value: "" }, ...repOptions]}
                    helpText={`Assigned per practice - applies to everyone in ${detail.assignId}.`} />
                ) : null}
              </FormLayout.Group>
            </FormLayout>
          </Modal.Section>
          <Modal.Section>
            <FormLayout>
              <Text as="h3" variant="headingSm">Tax, tags and notes</Text>
              <Checkbox label="Collect tax" checked={!v.taxExempt} onChange={(on) => set("taxExempt")(!on)} />
              <TextField label="Other tags" value={v.otherTags} onChange={set("otherTags")} autoComplete="off"
                helpText="Comma-separated." />
              <TextField label="Notes" value={v.note} onChange={set("note")} multiline={3} autoComplete="off" />
            </FormLayout>
          </Modal.Section>
        </>
      )}
    </Modal>
  );
}

/** "Delete customer?" confirmation - deletes from the Shopify store. */
function DeleteModal({ row, onClose }) {
  const fetcher = useFetcher();
  const deleting = fetcher.state !== "idle";
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      if (typeof shopify !== "undefined") shopify.toast.show(fetcher.data.message);
      onClose();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  return (
    <Modal
      open={!!row}
      onClose={onClose}
      title={row ? `Delete ${row.name || row.email}?` : ""}
      primaryAction={{
        content: "Delete customer",
        destructive: true,
        loading: deleting,
        onAction: () => fetcher.submit({ intent: "delete", customerId: row.customerId }, { method: "post", action: "/app/accounts" }),
      }}
      secondaryActions={[{ content: "Cancel", onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="300">
          {fetcher.data?.ok === false ? <Banner tone="critical"><p>{fetcher.data.message}</p></Banner> : null}
          <Text as="p">
            This permanently deletes <b>{row?.email}</b> ({row?.role}{row?.ids ? `, ${row.ids}` : ""}) from your Shopify
            store. They lose portal access straight away. This can't be undone.
          </Text>
          <Text as="p">
            If this leaves their practice with no physician, that practice's product copies are deleted from the
            store at the same time.
          </Text>
          <Text as="p" tone="subdued">
            Shopify won't delete a customer who has orders - it will say so here.
          </Text>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

export default function Accounts() {
  const data = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const busy = useBusy();
  const [q, setQ] = useState(data.q);
  const [role, setRole] = useState(data.role);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [bulkOpen, setBulkOpen] = useState(false);

  // While any physician's product copies are being created, refresh the list
  // every few seconds so the count appears without clicking anything.
  const revalidator = useRevalidator();
  // ...and while a welcome email is waiting for those products, so "Sent" appears by itself
  const anyCreating = data.sync?.syncing ||
    data.rows.some((r) => r.copies === "creating" || String(r.welcome).startsWith("Waiting for products"));
  useEffect(() => {
    if (!anyCreating) return undefined;
    const t = setInterval(() => {
      if (revalidator.state === "idle" && !document.hidden) revalidator.revalidate();
    }, 4000);
    return () => clearInterval(t);
  }, [anyCreating, revalidator]);

  return (
    <Page
      title="Accounts"
      subtitle="Practices, clinics, physicians and sales reps."
      fullWidth
      secondaryActions={[{ content: "Re-sync from Shopify", disabled: busy, onAction: () => submit({ intent: "sync" }, { method: "post" }) }]}
    >
      <BlockStack gap="400">
        <ActionResult data={actionData} />
        <SyncStatus sync={data.sync} />
        <CreateForm data={data} busy={busy} onBulk={() => setBulkOpen(true)} />
        <BulkModal open={bulkOpen} data={data} onClose={(imported) => { setBulkOpen(false); if (imported) revalidator.revalidate(); }} />
        <Card>
          <Form method="get">
            <InlineStack gap="300" blockAlign="end" wrap>
              <div style={{ minWidth: 280 }}>
                <TextField label="Search" name="q" value={q} onChange={setQ} placeholder="Name, email, business, any id" autoComplete="off" />
              </div>
              <Select label="Role" name="role" value={role} onChange={setRole}
                options={[{ label: "All roles", value: "" }, ...data.roles.map((r) => ({ label: r, value: r }))]} />
              <Button submit variant="primary">Filter</Button>
            </InlineStack>
          </Form>
        </Card>
        <Card padding="0">
          <DataTable
            columnContentTypes={["text", "text", "text", "text", "text", "text", "text", "text"]}
            headings={["Role", "Name", "Business", "Email", "IDs", "Login", "Welcome email", ""]}
            rows={data.rows.map((a) => [
              <InlineStack key={a.customerId} gap="100">{a.role}{a.demo ? <Badge tone="info">Demo</Badge> : null}</InlineStack>,
              a.name, a.company, a.email,
              <BlockStack key={a.customerId + "i"} gap="050">
                <span>{a.ids}</span>
                {a.copies === "creating" ? (
                  <InlineStack gap="100" blockAlign="center" wrap={false}>
                    <Spinner size="small" accessibilityLabel="Creating product copies" />
                    <Text as="span" variant="bodySm" tone="subdued">Creating products…</Text>
                  </InlineStack>
                ) : a.copies !== null ? (
                  <Text as="span" variant="bodySm" tone={a.copies ? "success" : a.masterCount ? "critical" : "subdued"}>
                    {a.copies
                      ? `${a.copies} products`
                      : a.masterCount ? "No products yet" : "No master products to copy"}
                  </Text>
                ) : null}
              </BlockStack>,
              a.state,
              a.welcome,
              <InlineStack key={a.customerId + "a"} gap="100" wrap={false}>
                <Button size="micro" onClick={() => setEditing(a)}>Edit</Button>
                <Button size="micro" tone="critical" onClick={() => setDeleting(a)}>Delete</Button>
                {a.provisioned ? (
                  <Button size="micro" disabled={busy}
                    onClick={() => submit({ intent: "welcome", customerId: a.customerId }, { method: "post" })}>
                    Re-send
                  </Button>
                ) : null}
              </InlineStack>,
            ])}
          />
        </Card>
        <Pager page={data.page} pageSize={data.pageSize} total={data.total} />
      </BlockStack>
      {/* keyed per customer so each opening starts clean (no stale form or error) */}
      <EditModal key={"e" + (editing?.customerId || "")} row={editing} repOptions={data.repOptions} onClose={() => setEditing(null)} />
      <DeleteModal key={"d" + (deleting?.customerId || "")} row={deleting} onClose={() => setDeleting(null)} />
    </Page>
  );
}
