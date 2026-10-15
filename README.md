# Protocol Rx Portal

A private Shopify app (Remix + MongoDB) that replaces the 17 Google Apps Script
projects and the Google Sheets behind the Protocol Therapeutics portal.

The store, customer login, cart, checkout, products and Brevo stay as they are.
What moves into this app:

| Was | Now |
|---|---|
| 17 Apps Script web apps, one URL each, shared secret in the page | One API behind Shopify's App Proxy: `/apps/rx/<endpoint>`. Shopify signs every request and tells the app which customer is logged in. |
| Google Sheet tabs (Prescriptions, Order Commission Log, Monthly Payout Summary, Sales Reps, Settings, Products, …) | MongoDB collections |
| Banking details in metaobjects / plain sheet cells | MongoDB, AES-256-GCM encrypted |
| `sweep()` every 5 minutes + unsigned webhooks | Signed Shopify webhooks, processed the moment an order is paid; a safety-net sync re-checks Shopify on a timer |
| Editing sheets by hand | Admin pages inside Shopify admin |
| Dashboards re-reading Shopify and whole sheet tabs on every load (10 s – 1 min) | Dashboards read pre-computed figures from MongoDB |

## Layout

```
app/
  shopify.server.js        Shopify app setup (sessions stored in MongoDB)
  db.server.js             MongoDB connection
  models/                  Mongoose schemas
  api/                     Storefront API: endpoint + action -> handler, with access checks
  services/
    orders.server.js       order pipeline: tag order + customer, close the prescription, SMS
    commission.server.js   per-order Doctor / Clinic / Practice / Rep split + monthly payouts
    prescriptions.server.js  builder (confirm / send / search), cart tracking, reminders
    dashboards/            practice, clinic, physician, rep, finance
    catalog.server.js      master products -> one Shopify copy per practice, shared inventory
    provisioning.server.js create practice / clinic / physician / rep / demo accounts, welcome email
    products / accounts / banking / about / forms / settings / import / scheduler
  routes/
    app.*.jsx              admin pages (the menu in Shopify admin)
    proxy.$.jsx            /apps/rx/*  (storefront API)
    webhooks.*.jsx         Shopify webhooks
extensions/rx-portal/      theme app extension (app embed + dashboard blocks)
tools/
  retarget-theme.mjs       rewrites an exported theme to call /apps/rx instead of Google
  smoke.mjs                end-to-end test against an in-memory MongoDB
```

## Storefront endpoints

Every old script has an endpoint with the same actions and the same JSON
replies, so the existing pages work unchanged:

| Endpoint | Replaces | Actions |
|---|---|---|
| `/apps/rx/builder` | 1-rx-builder | search, patientHistory, guardcheck, confirm, send |
| `/apps/rx/cart` | 2-rx-cart | track |
| `/apps/rx/practice` | 3-rx-practice | dashboard, products, practiceInfo, clinicInfo, practiceAccountInfo, payoutOrders, load, save, getAccount, updateAccount, updatePrice, updateCommission |
| `/apps/rx/physician` | 4-rx-physician | dashboard, sendLink, clinicName, practiceInfo, payoutOrders |
| `/apps/rx/rep` | 5-rx-rep | repdash, banking |
| `/apps/rx/clinic` | 6-rx-clinic | dashboard, bankingLoad, bankingSave |
| `/apps/rx/finance` | 7-rx-finance-admin | admindash, orderDetail, setPayoutStatus, uploadPayoutsCsv |
| `/apps/rx/account` | Account Settings API | getAccount, updateAccount, orderHistory |
| `/apps/rx/banking` | Rx Banking Details Form | load, save |
| `/apps/rx/pricing` | Product Price Management | (price update) |
| `/apps/rx/about` | rx-about-us-page | aboutUsLoad, aboutUsSave, aboutUsUploadImage |
| `/apps/rx/physicians` | Rx Physician list | customers |
| `/apps/rx/form`, `/apps/rx/support` | form, contact-support-form | save |

Access is decided on the server from the logged-in customer's tags
(`app/services/caller.server.js`): a practice sees its own practice, a clinic
its own clinic, a physician themselves, a rep their own account (plus the demo
trio), finance admins everything. Ids sent by the page are only requests.

## Setup

1. **MongoDB.** Any MongoDB 6+ (Atlas, or on the server). Put the connection
   string in `MONGODB_URI`.
2. **Environment.** Copy `.env.example` to `.env` and fill it in.
   `ENCRYPTION_KEY` protects banking details - generate a long random value and
   keep a copy; without it stored banking details cannot be read.
3. **Create the app** in the Shopify Dev Dashboard (custom distribution, this
   store only), then:
   ```
   npm install
   npm run config:link      # connects this folder to the app, fills in client_id
   npm run deploy           # pushes scopes, webhooks, app proxy and the theme extension
   ```
   `read_all_orders` (in `shopify.app.toml`) lets the order import reach back
   further than 60 days. It has to be granted to the app first; remove it from
   the scopes if it is not.
4. **Run it.** `npm run dev` locally, or on the server `npm run build` then
   `npm run start` behind HTTPS. Timed jobs start with the server.
5. **Install** the app on the store and open it once from Shopify admin.

## Moving the data over

In the app: **Sync & logs**.

1. *Run now* → `accounts`, then `products` (copies portal customers and the
   catalogue into MongoDB).
2. *Import from Google Sheets* - download each tab as CSV and upload it:
   Settings, Counters, Sales Reps, Banking Details, Demo Accounts, Products,
   Prescriptions, Monthly Payout Summary, Payouts.
3. *Import order history from Shopify*.
4. Import the **Order Commission Log** CSV last - it stamps each imported order
   with the split the old system logged, so history matches to the cent.
5. **Settings** → enter the Brevo API key and sender (they were script
   properties) and check the timezone.

Imports are upserts: running one twice changes nothing.

## Switching the storefront

Two ways, both reversible:

- **App embed (no theme edits).** Theme editor → App embeds → turn on
  **Rx Portal**. It sends every Apps Script request the theme makes to the
  matching `/apps/rx` endpoint. Turn it off to go back to Google. Try it on a
  duplicate theme first.
- **Theme files.** `node tools/retarget-theme.mjs ../theme_export --in-place`
  rewrites the theme folder itself: hard-coded Google URLs become
  `/apps/rx/<endpoint>`, and every place a section or snippet reads an
  "Apps Script URL" setting gets the endpoint written in directly, so the page
  works whatever the theme editor setting says. Without `--in-place` the
  changed files go to `../theme_export_patched` instead. Running it again
  changes nothing. Upload the changed files to a duplicate theme first.

Then, in Shopify admin → Settings → Notifications → Webhooks, **delete the old
webhooks** that point at `script.google.com`, and turn off the Apps Script
time triggers - otherwise orders are tagged and texted twice.

## Theme app extension

`extensions/rx-portal` contains:

- **Rx Portal** (app embed) - the switch described above.
- **Rx Practice / Clinic / Physician / Sales Rep / Finance Dashboard** (app
  blocks, page templates) - summary tiles and tables with CSV download, loaded
  from the app. These are new, lighter views. The full dashboards (wholesale
  ordering, product management, About Us editor, video library, …) are still
  the theme's own sections; Shopify limits a theme app extension to 100 KB of
  Liquid in total, and those sections are 120–220 KB each, so moving them
  means rebuilding their interface as script-driven blocks.

## Things that behave differently from the Google version

- A purchased prescription is kept (status `Purchased`) instead of deleted.
- The "order fulfilled" SMS existed in the old code but was never called. It
  is here, switched **off** (`ORDER_FULFILLED_SMS_ENABLED`).
- Product copies of a practice that lost its last physician are reported, not
  deleted, unless `PRODUCT_SYNC_DELETE_ORPHANS` is set to `TRUE`.
- The public physician list no longer includes email or phone.
- A practice can be assigned to one sales rep at a time.

## Checks

```
npm run build     # compiles the app
npm run smoke     # runs the order pipeline, dashboards, access rules and imports
                  # against an in-memory MongoDB with Shopify stubbed
```
