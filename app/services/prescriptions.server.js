import { connectDb } from "../db.server";
import { Order, Prescription, RX_OPEN_STATUSES } from "../models/index.server";
import { fillTemplate, sendEmail, sendSms, shortenUrl } from "./brevo.server";
import { drName, hasTag, isDemoIds, parseAmount, tagList } from "./ids.server";
import { logEvent, withLock } from "./log.server";
import { getSettings, isTrue } from "./settings.server";
import {
  createCustomer,
  escQ,
  findCustomerByEmail,
  searchCustomers as shopifyCustomers,
  updateCustomer,
} from "./shopify-admin.server";

/* Prescription builder + cart backend (was 1-rx-builder Send.gs / Search.gs
   and 2-rx-cart).

   STATUS FLOW: Created -> Sent -> Opened -> Checkout Started -> Purchased
                                      \-> Abandoned -> (Purchased | Expired)

   "Confirm Order" saves the prescription (status Created) and creates / tags
   the Shopify customer for a new patient. Only the email / SMS delivery waits
   for a Send click, which upserts the SAME document by Rx ID. */

const isWholesale = (tags) => hasTag(tags, "wholesale");

function providerTagMatch(tags, doctor, clinic) {
  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, "");
  const d = doctor ? norm("doctor_id:" + doctor) : "";
  const c = clinic ? norm("clinic_id:" + clinic) : "";
  return tagList(tags).some((t) => {
    const n = norm(t);
    return (d && n === d) || (c && n === c);
  });
}

/* ------------------------------ search ---------------------------------- */

/**
 * Existing-client picker. Merges Shopify customers tagged with this
 * provider's doctor_id / clinic_id with patients already saved on a
 * prescription, de-duplicated by email. With provider ids BOTH sources are
 * strictly limited to that provider's own patients; wholesale (staff)
 * accounts are never returned as patients.
 *
 * The builder calls this once with q='' and a large limit, then filters in
 * the browser as the doctor types; `complete: true` says nothing was cut off.
 */
export async function searchPatients(q, doctor, clinic, limit) {
  q = String(q || "").trim();
  doctor = String(doctor || "").trim();
  clinic = String(clinic || "").trim();
  limit = Math.min(250, Math.max(1, parseInt(limit, 10) || 10));

  const clauses = [];
  if (doctor) clauses.push(`tag:'doctor_id:${escQ(doctor)}'`);
  if (clinic) clauses.push(`tag:'clinic_id:${escQ(clinic)}'`);

  let shopify = [];
  let truncated = false;
  const wholesaleEmails = new Set();
  try {
    if (clauses.length) {
      const first = Math.min(250, Math.max(100, limit));
      const raw = await shopifyCustomers(clauses.join(" OR "), first);
      truncated = raw.length >= first;
      for (const c of raw) {
        if (isWholesale(c.tags) && c.email) wholesaleEmails.add(c.email.toLowerCase());
      }
      shopify = raw.filter(
        (c) => providerTagMatch(c.tags, doctor, clinic) && !isWholesale(c.tags),
      );
      if (q) {
        const term = q.toLowerCase();
        shopify = shopify.filter(
          (c) =>
            `${c.first} ${c.last}`.toLowerCase().includes(term) ||
            c.email.toLowerCase().includes(term) ||
            String(c.patientId).toLowerCase().includes(term) ||
            String(c.phone).includes(q),
        );
      }
    } else {
      // Untagged provider - no provider scoping is possible.
      shopify = (await shopifyCustomers(q, 10)).filter((c) => !isWholesale(c.tags));
    }
  } catch (err) {
    logEvent("error", "searchPatients", String(err), null, false);
  }
  shopify = shopify.slice(0, limit).map(({ state, address, ...c }) => c);

  const local = await searchSavedPatients(q, doctor, clinic, limit);
  const seen = new Set();
  const out = [];
  for (const c of [...shopify, ...local]) {
    const email = String(c.email || "").toLowerCase();
    if (email && wholesaleEmails.has(email)) continue;
    const k = email || `pid:${c.patientId || ""}/id:${c.id || ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  const complete =
    !truncated && shopify.length < limit && local.length < limit && out.length <= limit;
  return {
    ok: true,
    customers: out.slice(0, limit),
    complete,
    limit,
    source: "shopify+db",
  };
}

/** Patients already saved on this provider's prescriptions, newest first. */
async function searchSavedPatients(q, doctor, clinic, limit) {
  await connectDb();
  const filter = {};
  if (doctor || clinic) {
    filter.$or = [];
    if (doctor) filter.$or.push({ doctorId: doctor });
    if (clinic) filter.$or.push({ clinicId: clinic });
  }
  const rows = await Prescription.find(filter, {
    first: 1,
    last: 1,
    email: 1,
    phone: 1,
    patientId: 1,
  })
    .sort({ createdAt: -1 })
    .limit(2000)
    .lean();
  const term = q.toLowerCase();
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    const email = String(r.email || "").toLowerCase();
    if (
      term &&
      !`${r.first} ${r.last}`.toLowerCase().includes(term) &&
      !email.includes(term) &&
      !String(r.patientId).toLowerCase().includes(term)
    ) {
      continue;
    }
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({
      id: "",
      first: r.first,
      last: r.last,
      email: r.email,
      phone: r.phone,
      patientId: r.patientId,
    });
  }
  return out;
}

/**
 * GUARD CHECK - looks an email up across ALL customers (no provider filter)
 * and returns that customer's tags. "Another physician's patient" is by
 * definition someone the provider-filtered search would never return.
 */
export async function guardCheckEmail(email) {
  email = String(email || "").trim();
  if (!email) return { ok: true, found: false, tags: [] };
  let match = null;
  try {
    match = await findCustomerByEmail(email);
  } catch {
    match = null;
  }
  if (!match) return { ok: true, found: false, tags: [] };
  return {
    ok: true,
    found: true,
    tags: match.tags,
    customer: {
      id: match.id,
      first: match.first,
      last: match.last,
      email: match.email,
      phone: match.phone,
      patientId: match.patientId,
      tags: match.tags,
    },
  };
}

/**
 * One patient's history for the builder's search popup: purchased orders
 * plus any not-yet-purchased prescriptions, newest first.
 */
export async function patientHistory(patientId, email, doctor, clinic) {
  patientId = String(patientId || "").trim();
  email = String(email || "").trim().toLowerCase();
  doctor = String(doctor || "").trim();
  clinic = String(clinic || "").trim();
  if (!patientId && !email) return { ok: false, error: "missing patientId or email" };

  await connectDb();
  const out = [];
  const seenRx = new Set();

  if (patientId) {
    const q = { patientId, deletedAt: null };
    if (doctor) q.doctorId = doctor;
    if (clinic) q.clinicId = clinic;
    const orders = await Order.find(q).sort({ orderCreatedAt: -1 }).limit(50).lean();
    for (const o of orders) {
      if (o.rxId) seenRx.add(o.rxId);
      out.push({
        ts: o.orderCreatedAt ? o.orderCreatedAt.getTime() : 0,
        rxId: o.rxId,
        orderName: o.name,
        items: o.lineItems.map((li) => `${li.title} ×${li.quantity}`).join("; "),
        status: "Purchased",
        total: o.total,
        financialStatus: o.financialStatus.toUpperCase(),
        fulfillmentStatus: o.fulfillmentStatus.toUpperCase(),
        deliveryStatus: o.deliveryStatus,
      });
    }
  }

  const rxQ = { status: { $ne: "Purchased" }, $or: [] };
  if (patientId) rxQ.$or.push({ patientId });
  if (email) rxQ.$or.push({ email });
  if (doctor) rxQ.doctorId = doctor;
  if (clinic) rxQ.clinicId = clinic;
  const rxs = await Prescription.find(rxQ).sort({ createdAt: -1 }).limit(50).lean();
  for (const r of rxs) {
    if (r.rxId && seenRx.has(r.rxId)) continue;
    out.push({
      ts: r.createdAt ? r.createdAt.getTime() : 0,
      rxId: r.rxId,
      orderName: r.orderName || "",
      items: r.items || "",
      status: r.status || "Created",
      total: parseAmount(r.total),
    });
  }

  out.sort((a, b) => b.ts - a.ts);
  return { ok: true, history: out.slice(0, 25) };
}

/* ------------------------ confirm / send / track ------------------------ */

/**
 * Creates (or finds) the patient as a Shopify customer. Tags: patient,
 * patient_id:<id>, plus the creator's doctor_id / clinic_id / practice_id.
 * Returns the customer id, or '' when not possible - never blocks the save.
 */
async function createShopifyPatient(d) {
  const email = String(d.email || "").trim();
  if (!email) return "";
  try {
    const found = await findCustomerByEmail(email);
    if (found) return String(found.id);

    const tags = [];
    if (d.patientId) tags.push("patient", "patient_id:" + d.patientId);
    if (d.doctorId) tags.push("doctor_id:" + d.doctorId);
    if (d.clinicId) tags.push("clinic_id:" + d.clinicId);
    if (d.practiceId) tags.push("practice_id:" + d.practiceId);
    if (await isDemoIds(d)) tags.push("rx_demo");

    const input = {
      firstName: d.first || "",
      lastName: d.last || "",
      email,
      tags,
    };
    if (d.phone) input.phone = String(d.phone);
    return await createCustomer(input);
  } catch (err) {
    logEvent("error", email, "createShopifyPatient: " + err, null, false);
    return "";
  }
}

/** Inserts the prescription the first time either action sees this Rx ID. */
async function ensurePrescription(d) {
  await connectDb();
  const rxId = String(d.rxId || "").trim();
  const existing = await Prescription.findOne({ rxId }).lean();
  if (existing) return { rx: existing, isNew: false };

  let customerId = String(d.customerId || "");
  if (!customerId && String(d.clientType) === "new") {
    customerId = await createShopifyPatient(d);
  } else if (customerId && d.customerEdited) {
    // The doctor edited an existing client in the builder - save the new
    // name / email / phone onto that customer too. Best-effort.
    const upd = await updateCustomer(customerId, {
      firstName: String(d.first || ""),
      lastName: String(d.last || ""),
      ...(d.email ? { email: String(d.email).trim() } : {}),
      phone: d.phone ? String(d.phone) : null,
    });
    logEvent("job", customerId, "patient update from builder -> " + upd);
  }

  try {
    const rx = await Prescription.create({
      rxId,
      patientId: d.patientId || "",
      clientType: d.clientType || "",
      first: d.first || "",
      last: d.last || "",
      email: String(d.email || "").trim().toLowerCase(),
      phone: d.phone ? String(d.phone) : "",
      physician: d.physician || "",
      doctorId: d.doctorId || "",
      clinicId: d.clinicId || "",
      practiceId: d.practiceId || "",
      customerId,
      patientEdit: d.patientEdit || "No",
      items: d.items || "",
      total: d.total != null ? String(d.total) : "",
      validity: d.validity || "",
      expiresAt: d.expiryTs ? new Date(Number(d.expiryTs)) : null,
      link: d.link || "",
      status: "Created",
      confirmed: false,
      demo: await isDemoIds(d),
    });
    return { rx: rx.toObject(), isNew: true };
  } catch (err) {
    if (err?.code === 11000) {
      // confirm + send raced on the same Rx ID - the other request won
      return { rx: await Prescription.findOne({ rxId }).lean(), isNew: false };
    }
    throw err;
  }
}

/** "Confirm Order" - saves the prescription without sending anything. */
export async function confirmRx(d) {
  const rxId = String(d.rxId || "").trim();
  if (!rxId) return { ok: false, error: "missing rxId" };
  return withLock("rx:" + rxId, async () => {
    const { isNew } = await ensurePrescription(d);
    if (!isNew) await Prescription.updateOne({ rxId }, { $set: { updatedAt: new Date() } });
    return { ok: true, rxId, saved: isNew };
  });
}

/**
 * Delivers a prescription. channel 'email' emails the checkout link (and,
 * when asked, an SMS); 'whatsapp' just advances the status - the wa.me window
 * is opened by the browser. Idempotent: a retry never emails twice. Once the
 * email has gone out the call no longer reports failure.
 */
export async function sendRx(d) {
  const rxId = String(d.rxId || "").trim();
  if (!rxId) return { ok: false, error: "missing rxId" };
  const channel = String(d.channel || "email");
  const to = String(d.email || "").trim();
  if (channel === "email" && !to) return { ok: false, error: "missing email" };

  return withLock("rx:" + rxId, async () => {
    let rx, isNew;
    try {
      ({ rx, isNew } = await ensurePrescription(d));
    } catch (err) {
      return { ok: false, error: "save failed: " + String(err) };
    }

    if (channel === "email" && rx.emailSentAt) {
      return { ok: true, rxId, saved: false, channel, alreadySent: true };
    }

    if (channel === "email") {
      const cfg = await getSettings();
      const patientName = String(d.first || "").trim() || "there";
      const doctorName = drName(d.physicianName || d.physician);
      const values = {
        name: patientName,
        link: String(d.link || ""),
        validity: String(d.validity || ""),
        doctor_name: doctorName,
      };
      try {
        await sendEmail({
          to,
          subject: String(cfg.CONFIRMED_SUBJECT || "Your prescription order link"),
          htmlBody: fillTemplate(cfg.CONFIRMED_BODY, values),
          params: {
            NAME: patientName,
            LINK: values.link,
            VALIDITY: values.validity,
            DOCTOR_NAME: doctorName,
          },
          templateId: cfg.CONFIRMED_TEMPLATE_ID,
        });
      } catch (err) {
        logEvent("error", rxId, "checkout-link email failed: " + err, null, false);
        return { ok: false, error: "email failed: " + String(err) };
      }

      // SMS is opt-in and additive; a failed SMS never blocks the email.
      if (d.sendSms && d.phone) {
        try {
          const shortLink = await shortenUrl(values.link);
          await sendSms(
            d.phone,
            fillTemplate(cfg.SMS_BODY || "Hi [name], your order link: [link]", {
              ...values,
              link: shortLink,
            }),
          );
        } catch {
          // already logged by sendSms
        }
      }
    }

    // Delivery has happened - bookkeeping errors are warnings, not failures.
    let warning = "";
    try {
      const now = new Date();
      const set = { confirmed: true };
      if (channel === "email") set.emailSentAt = now;
      await Prescription.updateOne({ rxId }, { $set: set });
      // Status only ever moves forward (a later 'Opened' is never downgraded).
      await Prescription.updateOne(
        { rxId, status: { $in: ["", "Created", "Sent"] } },
        { $set: { status: "Sent" } },
      );
    } catch (err) {
      warning = "sent, but the record update failed: " + String(err);
    }
    const out = { ok: true, rxId, saved: isNew, channel };
    if (warning) out.warning = warning;
    return out;
  });
}

/** Cart page tracking: 'opened' when the link is viewed, 'checkout' when
 *  Proceed to checkout is clicked. Statuses only move forward. */
export async function trackEvent(d) {
  const rxId = String(d.rxId || "").trim();
  if (!rxId) return { ok: false, error: "missing rxId" };
  await connectDb();
  const rx = await Prescription.findOne({ rxId }, { status: 1, openedAt: 1, checkoutAt: 1 }).lean();
  if (!rx) return { ok: false, error: "rx not found" };

  const now = new Date();
  const set = {};
  if (d.event === "opened") {
    if (!rx.openedAt) set.openedAt = now;
    if (rx.status === "Created" || rx.status === "Sent") set.status = "Opened";
  } else if (d.event === "checkout") {
    if (!rx.checkoutAt) set.checkoutAt = now;
    if (["Created", "Sent", "Opened", "Abandoned"].includes(rx.status)) {
      set.status = "Checkout Started";
    }
  } else {
    return { ok: false, error: "unknown event" };
  }
  await Prescription.updateOne({ rxId }, { $set: { ...set, updatedAt: now } });
  return { ok: true };
}

/* ------------------------------ reminders ------------------------------- */

async function sendReminder(cfg, type, rx) {
  try {
    const name = `${rx.first || ""} ${rx.last || ""}`.trim() || "there";
    const doctorName = drName(rx.physician);
    const values = {
      name,
      link: rx.link || "",
      validity: rx.validity || "",
      doctor_name: doctorName,
    };
    await sendEmail({
      to: rx.email,
      subject: String(cfg[type + "_SUBJECT"] || "Your prescription"),
      htmlBody: fillTemplate(cfg[type + "_BODY"], values),
      params: {
        NAME: name,
        LINK: values.link,
        VALIDITY: values.validity,
        DOCTOR_NAME: doctorName,
      },
      templateId: cfg[type + "_TEMPLATE_ID"],
    });
  } catch (err) {
    // one bad address must not stop the run for everyone else
    logEvent("error", rx.rxId, `${type} reminder failed: ${err}`, null, false);
  }
  if (type === "ABANDONED") await sendAbandonedSms(cfg, rx);
}

/** Text that goes with the abandoned-cart email (ABANDONED_SMS_ENABLED). */
async function sendAbandonedSms(cfg, rx) {
  if (!isTrue(cfg.ABANDONED_SMS_ENABLED) || !rx.phone) return;
  const template = String(cfg.ABANDONED_SMS_BODY || "").trim();
  if (!template) return;
  try {
    const doctorName = drName(rx.physician);
    const link = await shortenUrl(rx.link || "");
    await sendSms(
      rx.phone,
      fillTemplate(template, {
        "First Name": String(rx.first || "").trim() || "there",
        "Last Name": doctorName.split(/\s+/).pop() || doctorName,
        "View Your Protocol": link,
        name: `${rx.first || ""} ${rx.last || ""}`.trim() || "there",
        link,
        doctor_name: doctorName,
      }),
    );
  } catch (err) {
    logEvent("error", rx.rxId, "abandoned SMS failed: " + err, null, false);
  }
}

/**
 * The timed half of the old sweep(): expiry, abandoned detection and the
 * not-opened / before-expiry reminders for every open prescription. (Paid
 * orders are handled the moment they are paid, by the orders webhooks.)
 */
export async function runPrescriptionReminders() {
  await connectDb();
  const cfg = await getSettings();
  const now = Date.now();
  const HOUR = 3600 * 1000;
  const open = await Prescription.find({ status: { $in: RX_OPEN_STATUSES } }).lean();
  let expired = 0;
  let abandoned = 0;
  let reminded = 0;

  for (const rx of open) {
    const set = {};
    let status = rx.status;
    const expTs = rx.expiresAt ? rx.expiresAt.getTime() : 0;

    // Expired: validity passed without purchase - reminders stop.
    if (expTs > 0 && expTs < now) {
      await Prescription.updateOne(
        { _id: rx._id, status: { $in: RX_OPEN_STATUSES } },
        { $set: { status: "Expired" } },
      );
      expired++;
      continue;
    }
    if (!cfg.enabled) continue;
    if (!String(rx.email || "").trim()) continue;

    // Abandoned: opened or started checkout, then went quiet.
    if ((status === "Opened" || status === "Checkout Started") && cfg.abandonH > 0) {
      const ref = (rx.checkoutAt || rx.openedAt)?.getTime() || 0;
      if (ref && now - ref >= cfg.abandonH * HOUR) {
        set.status = "Abandoned";
        status = "Abandoned";
        await sendReminder(cfg, "ABANDONED", rx);
        abandoned++;
      }
    }

    // Not-opened reminders - only once the link was actually delivered.
    if ((status === "Created" || status === "Sent") && rx.confirmed) {
      const base = (rx.emailSentAt || rx.createdAt)?.getTime() || 0;
      const age = base ? now - base : 0;
      if (!rx.reminder1At && cfg.r1 > 0 && age >= cfg.r1 * HOUR) {
        await sendReminder(cfg, "NOT_OPENED", rx);
        set.reminder1At = new Date();
        reminded++;
      } else if (rx.reminder1At && !rx.reminder2At && cfg.r2 > 0 && age >= cfg.r2 * HOUR) {
        await sendReminder(cfg, "NOT_OPENED", rx);
        set.reminder2At = new Date();
        reminded++;
      }
    }

    // Final reminder shortly before the link expires.
    if (
      rx.confirmed &&
      expTs > 0 &&
      !rx.expiryReminderAt &&
      cfg.beforeExpH > 0 &&
      expTs - now <= cfg.beforeExpH * HOUR &&
      expTs > now
    ) {
      await sendReminder(cfg, "EXPIRY", rx);
      set.expiryReminderAt = new Date();
      reminded++;
    }

    if (Object.keys(set).length) await Prescription.updateOne({ _id: rx._id }, { $set: set });
  }
  if (expired || abandoned || reminded) {
    logEvent("job", "reminders", `open=${open.length} expired=${expired} abandoned=${abandoned} reminded=${reminded}`);
  }
  return { open: open.length, expired, abandoned, reminded };
}
