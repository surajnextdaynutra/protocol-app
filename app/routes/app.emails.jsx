import { useEffect, useMemo, useState } from "react";
import { useActionData, useLoaderData, useSubmit } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  DataTable,
  FormLayout,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Select,
  Tabs,
  Text,
  TextField,
} from "@shopify/polaris";

import { ActionResult, useBusy } from "../components/admin";
import { WELCOME_DASHBOARDS, welcomeLinkForRole } from "../components/welcome-link";
import {
  listMessages,
  resetMessage,
  saveMessage,
  saveMessageSettings,
  sendTestMessage,
  setMessageEnabled,
} from "../services/message-templates.server";
import { getSettings, setSettings } from "../services/settings.server";
import { WELCOME_DEFAULT_BODY, WELCOME_DEFAULT_SUBJECT } from "../services/welcome-default.server";
import { authenticate } from "../shopify.server";

/* Emails - every email and SMS the portal sends, one tab each: welcome,
   protocol email / SMS, the three reminders, abandoned-cart SMS and the
   order SMS. The wording lives in Settings (same keys the Apps Script
   "Settings" tab used); this page is the friendly editor for it. Only
   loader/action touch server code. */

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const [messages, cfg] = await Promise.all([listMessages(), getSettings({ fresh: true })]);
  return {
    tab: url.searchParams.get("tab") || messages[0].id,
    messages: messages.map((m) =>
      m.id === "welcome" ? { ...m, defaultSubject: WELCOME_DEFAULT_SUBJECT, defaultBody: WELCOME_DEFAULT_BODY } : m,
    ),
    welcomeLink: cfg.WELCOME_EMAIL_LINK || "",
    welcomeDelay: cfg.WELCOME_EMAIL_DELAY_MINUTES || "30",
  };
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
  const f = await request.formData();
  const intent = f.get("intent");
  const id = String(f.get("id") || "");
  try {
    if (intent === "save") {
      await saveMessage(id, { subject: f.get("subject"), body: f.get("body"), templateId: f.get("templateId") });
      return { ok: true, message: "Saved." };
    }
    if (intent === "reset") {
      await resetMessage(id);
      return { ok: true, message: "Reset to the Protocol Therapeutics default." };
    }
    if (intent === "enabled") {
      const on = f.get("on") === "true";
      await setMessageEnabled(id, on);
      return { ok: true, message: on ? "Switched on." : "Switched off - it won't be sent." };
    }
    if (intent === "test") return await sendTestMessage(id, f.get("to"), f.get("role"));
    if (intent === "settings") {
      await saveMessageSettings(id, Object.fromEntries(f));
      return { ok: true, message: "Sending settings saved." };
    }
    if (intent === "welcome-sending") {
      const delay = Number(f.get("delay"));
      if (!(delay >= 0)) return { ok: false, message: "Delay must be 0 or more minutes." };
      await setSettings({ WELCOME_EMAIL_LINK: String(f.get("link") || "").trim(), WELCOME_EMAIL_DELAY_MINUTES: String(delay) });
      return { ok: true, message: "Welcome sending settings saved." };
    }
  } catch (err) {
    return { ok: false, message: String(err.message || err) };
  }
  return { ok: false, message: "Unknown action" };
};

/* ------------------------------ preview --------------------------------- */

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

/** Placeholders -> sample values, matched the way the real sender matches. */
function fillSample(text, message, extra = {}) {
  const values = { ...Object.fromEntries(message.placeholders.map((p) => [p.token, p.sample])), ...extra };
  if (message.looseMatch) {
    const loose = Object.fromEntries(Object.entries(values).map(([k, v]) => [k.replace(/[\s_-]+/g, "").toLowerCase(), v]));
    return String(text || "").replace(/\[([^\]]+)\]/g, (whole, t) => {
      const k = t.replace(/[\s_-]+/g, "").toLowerCase();
      return Object.prototype.hasOwnProperty.call(loose, k) ? loose[k] : whole;
    });
  }
  let out = String(text || "");
  for (const [k, v] of Object.entries(values)) out = out.split(`[${k}]`).join(String(v ?? ""));
  return out;
}

function htmlDoc(body) {
  if (/<html[\s>]/i.test(body)) return body; // a full email document
  const content = /<[a-z][\s\S]*>/i.test(body) ? body : `<div style="white-space:pre-wrap">${esc(body)}</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"></head>` +
    `<body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#202223;margin:16px">${content}</body></html>`;
}

function SmsPreview({ text }) {
  const segments = text.length <= 160 ? 1 : Math.ceil(text.length / 153);
  return (
    <BlockStack gap="200">
      <Box padding="400" background="bg-surface-secondary" borderRadius="300">
        <div style={{ maxWidth: 340, background: "#e9e9eb", color: "#000", borderRadius: 18, padding: "10px 14px",
          whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 15, lineHeight: 1.35 }}>
          {text || <i>(empty - nothing is sent)</i>}
        </div>
      </Box>
      <Text as="p" tone="subdued" variant="bodySm">
        {text.length} characters · {segments} SMS segment{segments === 1 ? "" : "s"} (with the sample values)
      </Text>
    </BlockStack>
  );
}

/* ------------------------- when it is sent ------------------------------ */

/** A tab's timing / switch settings (were the Settings page's reminder group). */
function SendingRules({ m, post, busy }) {
  const saved = JSON.stringify(Object.fromEntries(m.settings.map((s) => [s.key, s.value])));
  const [v, setV] = useState(() => JSON.parse(saved));
  // reset only when the stored values change (e.g. after Save), not on every reload
  useEffect(() => setV(JSON.parse(saved)), [saved]);
  const dirty = m.settings.some((s) => v[s.key] !== s.value);
  const set = (k) => (val) => setV((x) => ({ ...x, [k]: val }));

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingSm">When it's sent</Text>
        {m.settings.map((s) =>
          s.type === "bool" ? (
            <Checkbox key={s.key} label={s.label} checked={String(v[s.key]).toUpperCase() === "TRUE"}
              onChange={(on) => set(s.key)(on ? "TRUE" : "FALSE")}
              helpText={String(v[s.key]).toUpperCase() === "TRUE" ? "On." : "Off - no reminder emails go out."} />
          ) : (
            <TextField key={s.key} label={s.label} value={v[s.key]} onChange={set(s.key)} autoComplete="off"
              type={s.type === "hours" ? "number" : "text"} min={s.type === "hours" ? 0 : undefined}
              suffix={s.type === "hours" ? "hours" : undefined}
              placeholder={s.type === "datetime" ? "e.g. 2026-09-02T14:00 (blank = automatic)" : undefined}
              helpText={s.help} />
          ),
        )}
        <InlineStack>
          <Button disabled={!dirty || busy} onClick={() => post({ intent: "settings", id: m.id, ...v })}>Save</Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

/* ------------------------------ editor ---------------------------------- */

function MessageEditor({ m, data, post, busy }) {
  const [subject, setSubject] = useState(m.subject);
  const [body, setBody] = useState(m.body);
  const [templateId, setTemplateId] = useState(m.templateId);
  const [testTo, setTestTo] = useState("");
  const [role, setRole] = useState("Physician");

  // a save / reset reloads the data - show what is now stored
  useEffect(() => { setSubject(m.subject); setBody(m.body); setTemplateId(m.templateId); }, [m.subject, m.body, m.templateId]);

  const isEmail = m.kind === "email";
  const isWelcome = m.id === "welcome";
  const dirty = subject !== m.subject || body !== m.body || templateId !== m.templateId;
  const atDefault = subject === (m.defaultSubject || "") && body === (m.defaultBody || "");
  const extra = isWelcome ? { Link: welcomeLinkForRole(data.welcomeLink, role), Role: role } : {};
  const previewSubject = fillSample(subject, m, extra);
  const previewBody = fillSample(body, m, extra);
  const doc = useMemo(() => htmlDoc(previewBody), [previewBody]);
  const roleOptions = Object.keys(WELCOME_DASHBOARDS).map((r) => ({ label: r, value: r }));
  const remindersOff = m.settings.some((s) => s.key === "REMINDERS_ENABLED" && String(s.value).toUpperCase() !== "TRUE");

  return (
    <BlockStack gap="400">
      {remindersOff ? (
        <Banner tone="warning"><p>Prescription reminders are switched off, so this email isn't being sent - tick “Send prescription reminders” under “When it's sent”.</p></Banner>
      ) : null}
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center" wrap>
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">{m.label}</Text>
                  <Badge>{isEmail ? "Email" : "SMS"}</Badge>
                  {m.custom ? <Badge tone="success">Custom</Badge> : <Badge tone="info">Default</Badge>}
                  {m.enabled === false ? <Badge tone="critical">Off</Badge> : null}
                </InlineStack>
                {m.custom ? (
                  <Button tone="critical" variant="plain" disabled={busy} onClick={() => post({ intent: "reset", id: m.id })}>
                    Reset to default
                  </Button>
                ) : null}
              </InlineStack>
              <Text as="p" tone="subdued">{m.when}</Text>
              {m.enabled !== null ? (
                <Checkbox label={`Send this ${isEmail ? "email" : "SMS"}`} checked={m.enabled} disabled={busy}
                  onChange={(on) => post({ intent: "enabled", id: m.id, on: String(on) })}
                  helpText={m.enabled ? "On - customers receive it." : "Off - nothing is sent until you tick this."} />
              ) : null}
              <FormLayout>
                {isEmail ? <TextField label="Subject" value={subject} onChange={setSubject} autoComplete="off" /> : null}
                <TextField label={isEmail ? "Body (HTML or plain text)" : "Message"} value={body} onChange={setBody}
                  multiline={isEmail ? 16 : 5} monospaced={isEmail} autoComplete="off" />
                {m.templateIdKey ? (
                  <TextField label="Brevo template id (optional)" value={templateId} onChange={setTemplateId} autoComplete="off"
                    helpText="Leave blank to send the subject and body above. If set, Brevo's own template is used instead (params NAME, LINK, VALIDITY, DOCTOR_NAME)." />
                ) : null}
              </FormLayout>
              <InlineStack gap="200">
                <Button variant="primary" disabled={!dirty || busy} loading={busy}
                  onClick={() => post({ intent: "save", id: m.id, subject, body, templateId })}>
                  Save
                </Button>
                <Button disabled={!dirty || busy}
                  onClick={() => { setSubject(m.subject); setBody(m.body); setTemplateId(m.templateId); }}>
                  Discard changes
                </Button>
                {!atDefault ? (
                  <Button variant="plain" disabled={busy}
                    onClick={() => { setSubject(m.defaultSubject || ""); setBody(m.defaultBody || ""); }}>
                    Load default into editor
                  </Button>
                ) : null}
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            {m.settings.length ? <SendingRules m={m} post={post} busy={busy} /> : null}
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingSm">Placeholders</Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  {m.looseMatch ? "Case and spaces don't matter." : "Type them exactly as shown, brackets included."}
                </Text>
                {m.placeholders.map((p) => (
                  <InlineStack key={p.token} gap="200" blockAlign="center" wrap={false} align="space-between">
                    <BlockStack gap="0">
                      <Text as="span" fontWeight="semibold">{`[${p.token}]`}</Text>
                      {p.note ? <Text as="span" tone="subdued" variant="bodySm">{p.note}</Text> : null}
                    </BlockStack>
                    <Button size="micro" onClick={() => setBody((b) => b + `[${p.token}]`)}>Add</Button>
                  </InlineStack>
                ))}
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingSm">Send a test</Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Sends the saved version with the sample values{isEmail ? " and “[Test]” in the subject" : ""}. Save first to test changes.
                </Text>
                <TextField label="Send to" labelHidden type={isEmail ? "email" : "tel"} value={testTo} onChange={setTestTo}
                  placeholder={isEmail ? "you@example.com" : "+1 555 123 4567"} autoComplete="off" />
                <Button disabled={busy || !testTo} onClick={() => post({ intent: "test", id: m.id, to: testTo, role })}>
                  Send test {isEmail ? "email" : "SMS"}
                </Button>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      <Card>
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="end">
            <Text as="h2" variant="headingMd">Preview</Text>
            {isWelcome ? (
              <Box minWidth="220px"><Select label="Preview as" value={role} onChange={setRole} options={roleOptions} /></Box>
            ) : null}
          </InlineStack>
          {templateId ? (
            <Banner tone="info"><p>Brevo template {templateId} is used for this email - the preview below is the body above, which isn't sent while a template id is set.</p></Banner>
          ) : null}
          {isEmail ? (
            <>
              <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                <BlockStack gap="100">
                  <Text as="p"><b>Subject:</b> {previewSubject || <i>(empty)</i>}</Text>
                  {isWelcome ? <Text as="p" breakWord><b>Button link:</b> {extra.Link}</Text> : null}
                </BlockStack>
              </Box>
              <iframe title={`${m.label} preview`} sandbox="" srcDoc={doc}
                style={{ width: "100%", minHeight: 620, border: "1px solid #e3e3e3", borderRadius: 8, background: "#fff" }} />
            </>
          ) : (
            <SmsPreview text={previewBody} />
          )}
        </BlockStack>
      </Card>
    </BlockStack>
  );
}

/** Welcome-only: login link, delay, and where each role lands. */
function WelcomeSending({ data, post, busy }) {
  const [link, setLink] = useState(data.welcomeLink);
  const [delay, setDelay] = useState(String(data.welcomeDelay));
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">Welcome email sending</Text>
        <InlineGrid columns={{ xs: 1, md: ["twoThirds", "oneThird"] }} gap="400">
          <TextField label="[Link] - login URL" value={link} onChange={setLink} autoComplete="off"
            helpText="Whatever return_to= says here is replaced per account with that role's dashboard (added if missing)." />
          <TextField label="Delay after the account is created" type="number" min={0} suffix="minutes"
            value={delay} onChange={setDelay} autoComplete="off" />
        </InlineGrid>
        <InlineStack>
          <Button disabled={busy || (link === data.welcomeLink && delay === String(data.welcomeDelay))}
            onClick={() => post({ intent: "welcome-sending", link, delay })}>
            Save sending settings
          </Button>
        </InlineStack>
        <Text as="h3" variant="headingSm">Where each role lands after logging in</Text>
        <DataTable
          columnContentTypes={["text", "text"]}
          headings={["Role", "Dashboard ([Link] sent to this role)"]}
          rows={Object.keys(WELCOME_DASHBOARDS).map((r) => [
            r,
            <BlockStack key={r} gap="050">
              <Text as="span" fontWeight="semibold">{WELCOME_DASHBOARDS[r]}</Text>
              <Text as="span" tone="subdued" variant="bodySm" breakWord>{welcomeLinkForRole(link, r)}</Text>
            </BlockStack>,
          ])}
        />
      </BlockStack>
    </Card>
  );
}

export default function Emails() {
  const data = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const busy = useBusy();
  const start = Math.max(0, data.messages.findIndex((m) => m.id === data.tab));
  const [selected, setSelected] = useState(start);
  const m = data.messages[selected];

  const tabs = data.messages.map((x) => ({
    id: x.id,
    content: x.enabled === false ? `${x.label} (off)` : x.label,
    accessibilityLabel: x.label,
  }));
  const post = (fields) => submit(fields, { method: "post" });

  return (
    <Page
      title="Emails"
      subtitle="Every email and text message the portal sends - edit the wording, preview it and send yourself a test."
      fullWidth
    >
      <BlockStack gap="400">
        <ActionResult data={actionData} />
        <Card padding="0">
          <Tabs tabs={tabs} selected={selected} onSelect={setSelected} fitted={false} />
        </Card>
        {/* keyed per tab so each tab's editor starts from its own saved text */}
        <MessageEditor key={m.id} m={m} data={data} post={post} busy={busy} />
        {m.id === "welcome" ? <WelcomeSending data={data} post={post} busy={busy} /> : null}
      </BlockStack>
    </Page>
  );
}
