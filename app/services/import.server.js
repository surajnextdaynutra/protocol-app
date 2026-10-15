import { connectDb } from "../db.server";
import {
  Banking,
  Counter,
  DemoAccount,
  FormEntry,
  MonthlyPayout,
  Order,
  Payout,
  Prescription,
  SalesRep,
} from "../models/index.server";
import { encryptJson } from "./crypto.server";
import { saveMaster } from "./catalog.server";
import { clearDemoCache, parseAmount } from "./ids.server";
import { logEvent } from "./log.server";
import { setSetting } from "./settings.server";

/* One-time migration from the Google Sheets.

   For each tab: File -> Download -> Comma-separated values (.csv), then
   upload it on the app's "Sync & logs" page. Rows are matched to columns by
   HEADER NAME, so column order does not matter. Every import is an upsert -
   running the same file twice changes nothing. */

/** RFC-4180 CSV -> array of rows (arrays of strings). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  text = String(text || "").replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

/** Rows -> objects keyed by lower-cased, trimmed header. */
function toObjects(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => String(h || "").trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const o = {};
    headers.forEach((h, i) => {
      if (h) o[h] = String(r[i] ?? "").trim();
    });
    return o;
  });
}

const date = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
};
const text = (v) => String(v ?? "").replace(/^'/, "").trim();
const yes = (v) => /^(yes|true|1)$/i.test(String(v || "").trim());

/** "2026-08", "8/1/2026", "Aug 2026" -> "2026-08". */
function monthKey(v) {
  const s = String(v || "").trim();
  const m = /^(\d{4})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${("0" + m[2]).slice(-2)}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return `${d.getFullYear()}-${("0" + (d.getMonth() + 1)).slice(-2)}`;
  return s;
}

const importers = {
  /* "Prescriptions" tab */
  async prescriptions(rows) {
    let n = 0;
    for (const r of rows) {
      const rxId = text(r["rx id"]);
      if (!rxId) continue;
      await Prescription.updateOne(
        { rxId },
        {
          $set: {
            patientId: text(r["patient id"]),
            clientType: text(r["client type"]),
            first: text(r["first name"]),
            last: text(r["last name"]),
            email: text(r["email"]).toLowerCase(),
            phone: text(r["phone"]),
            physician: text(r["physician"]),
            doctorId: text(r["doctor id"]),
            clinicId: text(r["clinic id"]),
            practiceId: text(r["practice id"]),
            customerId: text(r["shopify customer"]),
            patientEdit: text(r["patient edit"]) || "No",
            items: text(r["items"]),
            total: text(r["total"]),
            validity: text(r["link validity"]),
            expiresAt: date(r["expires at"]),
            link: text(r["cart link"]),
            status: text(r["status"]) || "Created",
            confirmed: yes(r["confirmation"]),
            emailSentAt: date(r["email sent at"]),
            purchasedAt: date(r["purchased at"]),
            orderName: text(r["shopify order"]),
            openedAt: date(r["opened at"]),
            checkoutAt: date(r["checkout started at"]),
            reminder1At: date(r["reminder 1"]),
            reminder2At: date(r["reminder 2"]),
            expiryReminderAt: date(r["expiry reminder"]),
            ...(date(r["created at"]) ? { createdAt: date(r["created at"]) } : {}),
          },
          ...(date(r["created at"]) ? {} : { $setOnInsert: { createdAt: new Date() } }),
        },
        { upsert: true, timestamps: false },
      );
      n++;
    }
    return n;
  },

  /* "Settings" tab: Setting | Value | Notes */
  async settings(rows) {
    let n = 0;
    for (const r of rows) {
      const key = text(r["setting"]);
      if (!key) continue;
      await setSetting(key, r["value"] ?? "");
      n++;
    }
    return n;
  },

  /* "Sales Reps" tab */
  async reps(rows) {
    let n = 0;
    for (const r of rows) {
      const repId = text(r["rep id"]);
      if (!repId) continue;
      const assigned = text(r["assigned practice id(s)"] || r["assigned clinics"])
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const pct = parseFloat(r["commission %"]);
      await SalesRep.updateOne(
        { repId },
        {
          $set: {
            name: text(r["rep name"]),
            assignedPracticeIds: assigned,
            commissionPercent: isNaN(pct) ? null : pct,
            notes: text(r["notes"]),
          },
        },
        { upsert: true },
      );
      n++;
    }
    return n;
  },

  /* "Monthly Payout Summary" tab. Rows sharing a month / role / id (an old
     sheet bug split some months) are summed into one. */
  async monthlyPayouts(rows) {
    const merged = new Map();
    for (const r of rows) {
      const month = monthKey(r["month"]);
      const role = text(r["role"]);
      const entityId = text(r["id"]);
      if (!month || !role || !entityId) continue;
      const key = `${month}|${role}|${entityId}`;
      const paid = text(r["status"]).toLowerCase() === "paid";
      const e = merged.get(key) || { month, role, entityId, amount: 0, allPaid: true, datePaid: "", transactionNo: "" };
      e.amount += parseAmount(r["amount"]);
      if (!paid) e.allPaid = false;
      else {
        e.datePaid = text(r["date paid"]) || e.datePaid;
        e.transactionNo = text(r["transaction #"]) || e.transactionNo;
      }
      merged.set(key, e);
    }
    for (const e of merged.values()) {
      await MonthlyPayout.updateOne(
        { month: e.month, role: e.role, entityId: e.entityId },
        {
          $set: {
            amount: Math.round(e.amount * 100) / 100,
            status: e.allPaid ? "Paid" : "Pending",
            datePaid: e.allPaid ? e.datePaid : "",
            transactionNo: e.allPaid ? e.transactionNo : "",
          },
        },
        { upsert: true },
      );
    }
    return merged.size;
  },

  /* "Payouts" tab: Date | Clinic / Doctor / Rep ID | Amount | Note | Method | Reference | Status */
  async payouts(rows) {
    await Payout.deleteMany({ note: /\(imported\)$/ });
    let n = 0;
    for (const r of rows) {
      const entityId = text(r["clinic / doctor / rep id"] || r["id"]);
      if (!entityId) continue;
      await Payout.create({
        date: date(r["date"]) || new Date(),
        entityId,
        amount: parseAmount(r["amount"]),
        note: `${text(r["note"])} (imported)`.trim(),
        method: text(r["method"]),
        reference: text(r["reference"]),
        status: text(r["status"]) || "Paid",
      });
      n++;
    }
    return n;
  },

  /* "Order Commission Log" tab - stamps each already-imported order with the
     split the old system logged for it, so history matches to the cent. Run
     the order import (Sync & logs -> Import order history) first. */
  async commissionLog(rows) {
    let n = 0;
    let missing = 0;
    for (const r of rows) {
      const name = text(r["order name"]);
      if (!name) continue;
      const orderId = text(r["order id"]);
      const order = await Order.findOne(orderId ? { orderId } : { name }).lean();
      if (!order) {
        missing++;
        continue;
      }
      const orderDate = date(r["order date"]) || order.orderCreatedAt;
      const deleted = text(r["order status"]) === "Deleted";
      await Order.updateOne(
        { _id: order._id },
        {
          $set: {
            commission: {
              logged: true,
              loggedAt: date(r["logged at"]) || new Date(),
              doctorId: text(r["doctor id"]),
              clinicId: text(r["clinic id"]),
              practiceId: text(r["practice id"]),
              doctorAmt: parseAmount(r["doctor amount"]),
              clinicAmt: parseAmount(r["clinic amount"]),
              practiceAmt: parseAmount(r["practice amount"]),
              repId: text(r["rep id"]),
              repAmt: parseAmount(r["rep amount"]),
              solo: false,
              counted: text(r["counted in payout"]) || "Yes",
              month: orderDate ? monthKey(orderDate.toISOString()) : "",
              status: deleted ? "Deleted" : "Active",
            },
          },
        },
      );
      n++;
    }
    if (missing) logEvent("job", "import", `commission log: ${missing} order(s) not in the database yet`);
    return n;
  },

  /* "Banking Details" tab (sales reps) */
  async repBanking(rows) {
    const map = {
      bankName: "bank name",
      bankRouting: "bank routing (ach)",
      accountNumber: "bank holder account number",
      bankAddress1: "bank address 1",
      bankAddress2: "bank address 2",
      bankCity: "bank city",
      bankState: "bank state",
      bankZip: "bank zip / postal",
      holderBusinessName: "account holder business name",
      holderAddress1: "account holder address 1",
      holderAddress2: "account holder address 2",
      holderCity: "account holder city",
      holderState: "account holder state",
      holderZip: "account holder zip / postal",
      holderPhone: "account holder phone",
    };
    let n = 0;
    for (const r of rows) {
      const repId = text(r["rep id"]);
      if (!repId) continue;
      const fields = {};
      for (const [k, h] of Object.entries(map)) fields[k] = text(r[h]);
      await Banking.updateOne(
        { ownerType: "rep", ownerId: repId },
        { $set: { data: encryptJson(fields), updatedBy: "sheet-import" } },
        { upsert: true },
      );
      n++;
    }
    return n;
  },

  /* "Counters" tab: Prefix | Number */
  async counters(rows) {
    let n = 0;
    for (const r of rows) {
      const vals = Object.values(r);
      const prefix = text(vals[0]);
      const seq = Number(vals[1]);
      if (!prefix || isNaN(seq)) continue;
      await Counter.updateOne({ _id: prefix }, { $max: { seq } }, { upsert: true });
      n++;
    }
    return n;
  },

  /* "Demo Accounts" tab */
  async demoAccounts(rows) {
    let n = 0;
    for (const r of rows) {
      const email = text(r["email"]).toLowerCase();
      const practiceId = text(r["practice id"]);
      if (!email && !practiceId) continue;
      await DemoAccount.updateOne(
        { email, practiceId },
        { $set: { clinicId: text(r["clinic id"]), doctorId: text(r["doctor id"]) } },
        { upsert: true },
      );
      n++;
    }
    clearDemoCache();
    return n;
  },

  /* "Sales Referral Form Data" tab */
  async referrals(rows) {
    await FormEntry.deleteMany({ form: "referral", status: "Imported" });
    let n = 0;
    for (const r of rows) {
      const data = {};
      // keep the sheet's own camelCase keys (headers were lower-cased above)
      for (const [k, v] of Object.entries(r)) data[k] = v;
      await FormEntry.create({
        form: "referral",
        status: "Imported",
        email: text(r["contactemail"]).toLowerCase(),
        data: {
          ...data,
          practiceName: r["practicename"],
          repName: r["repname"],
          repEmail: r["repemail"],
          contactEmail: r["contactemail"],
        },
        createdAt: date(r["timestamp"]) || new Date(),
      });
      n++;
    }
    return n;
  },
};

/** "Products" tab (master products). Column names are kept exactly as in
 *  the sheet, since every metafield column is addressed by its header. */
async function importMasters(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return { rows: 0, imported: 0 };
  const headers = rows[0].map((h) => String(h || "").trim());
  let imported = 0;
  for (const r of rows.slice(1)) {
    const row = {};
    headers.forEach((h, i) => {
      if (h) row[h] = String(r[i] ?? "").trim();
    });
    if (!row["Master Key"] && !row["Title"]) continue;
    await saveMaster(row);
    imported++;
  }
  return { rows: rows.length - 1, imported };
}

export const IMPORT_KINDS = [
  { id: "masters", label: "Products (master products)" },
  { id: "settings", label: "Settings" },
  { id: "counters", label: "Counters (ID numbers)" },
  { id: "reps", label: "Sales Reps" },
  { id: "repBanking", label: "Banking Details (sales reps)" },
  { id: "demoAccounts", label: "Demo Accounts" },
  { id: "prescriptions", label: "Prescriptions" },
  { id: "monthlyPayouts", label: "Monthly Payout Summary" },
  { id: "payouts", label: "Payouts" },
  { id: "commissionLog", label: "Order Commission Log (after the order import)" },
  { id: "referrals", label: "Sales Referral Form Data" },
];

export async function importCsv(kind, csvText) {
  await connectDb();
  if (kind === "masters") {
    const res = await importMasters(csvText);
    logEvent("job", "import:masters", `rows=${res.rows} imported=${res.imported}`);
    return res.rows ? { ok: true, ...res } : { ok: false, error: "No data rows found in the file." };
  }
  const run = importers[kind];
  if (!run) throw new Error("Unknown import: " + kind);
  const rows = toObjects(csvText);
  if (!rows.length) return { ok: false, error: "No data rows found in the file." };
  const imported = await run(rows);
  logEvent("job", "import:" + kind, `rows=${rows.length} imported=${imported}`);
  return { ok: true, rows: rows.length, imported };
}
