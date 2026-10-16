import { getSettings, isTrue } from "./settings.server";
import { READ_ONLY } from "./shopify-admin.server";
import { logEvent } from "./log.server";

/* Email + SMS through Brevo - same REST calls the Apps Script made, without
   the UrlFetch quota. Keys and kill switches live in Settings. */

const BREVO = "https://api.brevo.com/v3";

async function brevoPost(path, apiKey, payload) {
  const res = await fetch(BREVO + path, {
    method: "POST",
    headers: {
      "api-key": apiKey,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Brevo ${path} failed (${res.status}): ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** Strips tags for the plain-text fallback of a templated HTML email. */
export function htmlToText(html) {
  return String(html || "")
    .replace(/<a\s+[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gi, "$2: $1")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Fills [name] style placeholders. Unknown tokens are left as they are. */
export function fillTemplate(tpl, values) {
  let out = String(tpl || "");
  for (const [k, v] of Object.entries(values)) {
    out = out.split(`[${k}]`).join(String(v ?? ""));
  }
  return out;
}

/**
 * Sends one transactional email. With `templateId` the Brevo template's own
 * design + subject are used and only `params` are merged in; without it the
 * email is built from subject / htmlBody. Throws on failure (and when email
 * is switched off) so a caller never reports a send that did not happen.
 */
export async function sendEmail({ to, subject, htmlBody, params, templateId }) {
  try {
    return await sendEmailOnce({ to, subject, htmlBody, params, templateId });
  } catch (err) {
    // every failed / blocked email is logged with its reason
    logEvent("email", to, `NOT sent "${subject || `template ${templateId}`}": ${String(err?.message || err).slice(0, 300)}`, null, false);
    throw err;
  }
}

async function sendEmailOnce({ to, subject, htmlBody, params, templateId }) {
  const cfg = await getSettings();
  if (READ_ONLY) throw new Error("Read-only mode (RX_READ_ONLY): email was not sent.");
  if (isTrue(cfg.EMAIL_DISABLED)) {
    throw new Error("Email sending is temporarily disabled (EMAIL_DISABLED).");
  }
  const apiKey = cfg.BREVO_API_KEY;
  if (!apiKey) throw new Error("Set BREVO_API_KEY in Settings.");

  let result;
  if (templateId) {
    result = await brevoPost("/smtp/email", apiKey, {
      to: [{ email: to }],
      templateId: Number(templateId),
      params: params || {},
    });
  } else {
    if (!cfg.BREVO_SENDER_EMAIL) {
      throw new Error("Set BREVO_SENDER_EMAIL in Settings.");
    }
    result = await brevoPost("/smtp/email", apiKey, {
      sender: {
        name: cfg.BREVO_SENDER_NAME || "Protocol Therapeutics",
        email: cfg.BREVO_SENDER_EMAIL,
      },
      to: [{ email: to }],
      subject,
      htmlContent: htmlBody || undefined,
      textContent: htmlToText(htmlBody) || undefined,
    });
  }
  logEvent("email", to, subject || `template ${templateId}`);
  return result;
}

/* One character outside the GSM-7 set (curly quotes, long dashes, …) turns
   the whole SMS into Unicode: 70 characters a part instead of 160, and some
   North American carriers bounce it. The Apps Script templates were plain
   ASCII; edited templates (and pasted text) often are not. */
function gsmSafe(text) {
  return String(text)
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[   ]/g, " ");
}

/**
 * Sends one SMS. A missing key / phone or the kill switch is a silent skip
 * (returns false) - SMS is always additive, never a reason to fail the caller.
 */
export async function sendSms(phone, message) {
  message = gsmSafe(message);
  const cfg = await getSettings();
  // skipped SMS are logged with the reason (they used to vanish silently)
  const skip = (why) => {
    logEvent("sms", String(phone || "-"), `NOT sent (${why}): ${String(message).slice(0, 120)}`, null, false);
    return false;
  };
  if (READ_ONLY) return skip("read-only mode");
  if (isTrue(cfg.SMS_DISABLED)) return skip("SMS_DISABLED is on");
  const apiKey = cfg.BREVO_API_KEY;
  if (!apiKey) return skip("BREVO_API_KEY not set");

  // Brevo's alphanumeric sender allows only letters/digits, max 11 chars.
  const rawSender = String(cfg.BREVO_SMS_SENDER || "Rx");
  let sender = rawSender.replace(/[^A-Za-z0-9]/g, "");
  if (/[A-Za-z]/.test(sender)) sender = sender.slice(0, 11);
  if (!sender) sender = "Rx";

  const digits = String(phone || "").replace(/[^0-9]/g, "");
  if (!digits) return skip("no phone number");

  try {
    const res = await brevoPost("/transactionalSMS/sms", apiKey, {
      sender,
      recipient: digits,
      content: message,
      type: "transactional",
    });
    // 201 = Brevo ACCEPTED it, not that it was delivered - delivery (or
    // "skipped" / soft bounce) shows up later in Brevo's SMS logs. The
    // messageId is kept so the two can be matched. usedCredits /
    // remainingCredits in this reply read 0 even on an account with SMS
    // credits, so they say nothing about the balance.
    logEvent(
      "sms",
      digits,
      `accepted by Brevo (messageId ${res.messageId ?? "?"}, ${res.smsCount ?? "?"} part(s)): ${String(message).slice(0, 160)}`,
      { messageId: res.messageId ?? null, smsCount: res.smsCount ?? null, sender },
    );
    return true;
  } catch (err) {
    logEvent("sms", digits, String(err), null, false);
    return false;
  }
}

/** Shortens a link for SMS via TinyURL; falls back to the long URL. */
export async function shortenUrl(longUrl) {
  longUrl = String(longUrl || "").trim();
  if (!longUrl) return longUrl;
  try {
    const res = await fetch(
      "https://tinyurl.com/api-create.php?url=" + encodeURIComponent(longUrl),
      { signal: AbortSignal.timeout(6000) },
    );
    const short = (await res.text()).trim();
    if (res.ok && /^https?:\/\//i.test(short)) return short;
  } catch {
    // a longer SMS is fine; a broken link is not
  }
  return longUrl;
}
