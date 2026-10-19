import { connectDb } from "../db.server";
import { Account, DemoAccount } from "../models/index.server";
import { logEvent } from "./log.server";
import { getSettings } from "./settings.server";
import { gql, metafieldsSet, READ_ONLY } from "./shopify-admin.server";

/* The theme's demo persona (snippets/rx-demo-persona.liquid and
   rx-demo-viewbar.liquid) reads the demo trio from the shop metafield
   rx.demo, written here. The ids therefore live only in the app (Demo
   accounts + Settings DEMO_IDS), never in theme settings - the two used to
   drift apart, and a rep's demo view then got "You do not have access to
   this practice". */

const NAMESPACE = "rx";
const KEY = "demo";

const displayName = (a) => (a ? a.company || `${a.first || ""} ${a.last || ""}`.trim() : "");

/** { practiceId, clinicId, doctorId, practiceName, clinicName, physicianName }
 *  of the demo trio, or null when none is set up. */
export async function demoTrio() {
  await connectDb();
  const row = await DemoAccount.findOne({
    practiceId: { $ne: "" },
    clinicId: { $ne: "" },
    doctorId: { $ne: "" },
  })
    .sort({ createdAt: -1 })
    .lean();
  let ids = row ? { practiceId: row.practiceId, clinicId: row.clinicId, doctorId: row.doctorId } : null;
  if (!ids) {
    // No Demo accounts row: take each id from DEMO_IDS by its prefix.
    const list = String((await getSettings()).DEMO_IDS || "").split(/[,\s/]+/).filter(Boolean);
    const pick = (re) => list.find((x) => re.test(x)) || "";
    ids = { practiceId: pick(/^PRA/i), clinicId: pick(/^CLN/i), doctorId: pick(/^DOC/i) };
  }
  if (!ids.practiceId || !ids.clinicId || !ids.doctorId) return null;

  const accts = await Account.find({ practiceId: ids.practiceId }).lean();
  return {
    ...ids,
    practiceName: displayName(accts.find((a) => !a.doctorId && !a.clinicId)),
    clinicName: displayName(accts.find((a) => !a.doctorId && a.clinicId === ids.clinicId)),
    physicianName: displayName(accts.find((a) => a.doctorId === ids.doctorId)),
  };
}

/** Writes the trio to the shop metafield (or removes it when there is none). */
export async function syncDemoToShop() {
  if (READ_ONLY) return { ok: true, skipped: "read-only mode" };
  const trio = await demoTrio();
  const ownerId = (await gql(`#graphql
    query RxShopId { shop { id } }`)).shop.id;

  if (!trio) {
    await gql(
      `#graphql
      mutation RxDemoClear($m: [MetafieldIdentifierInput!]!) {
        metafieldsDelete(metafields: $m) { userErrors { field message } }
      }`,
      { m: [{ ownerId, namespace: NAMESPACE, key: KEY }] },
    );
    logEvent("sync", "demo-sync", "no demo trio - shop metafield rx.demo removed");
    return { ok: true, cleared: true };
  }

  const errs = await metafieldsSet([
    { ownerId, namespace: NAMESPACE, key: KEY, type: "json", value: JSON.stringify(trio) },
  ]);
  if (errs.length) throw new Error("rx.demo not saved: " + errs.map((e) => e.message).join("; "));
  logEvent("sync", "demo-sync", `shop metafield rx.demo = ${trio.practiceId} / ${trio.clinicId} / ${trio.doctorId}`);
  return { ok: true, trio };
}

let timer = null;
/** Sync shortly after a change (several changes in a row write once). */
export function scheduleDemoSync() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    syncDemoToShop().catch((err) =>
      logEvent("error", "demo-sync", String(err?.message || err).slice(0, 300), null, false),
    );
  }, 1500);
}
