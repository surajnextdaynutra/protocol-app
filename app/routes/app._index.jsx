import { useLoaderData } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Card,
  DataTable,
  InlineGrid,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";

import { connectDb } from "../db.server";
import {
  Account,
  MonthlyPayout,
  Order,
  Prescription,
  Product,
  RX_OPEN_STATUSES,
  SalesRep,
  WebhookEvent,
} from "../models/index.server";
import { PAID_EXPR } from "../services/commission.server";
import { monthKey } from "../services/ids.server";
import { getSettings } from "../services/settings.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  await connectDb();
  const cfg = await getSettings();
  const month = monthKey(new Date(), cfg.TIMEZONE);
  const monthStart = new Date(`${month}-01T00:00:00Z`);

  const [
    openRx,
    rxOrders,
    monthOrders,
    accounts,
    reps,
    products,
    failedWebhooks,
    pendingPayouts,
    monthSales,
    recent,
  ] = await Promise.all([
    Prescription.countDocuments({ status: { $in: RX_OPEN_STATUSES } }),
    Order.countDocuments({ tags: "rx", deletedAt: null }),
    Order.countDocuments({ tags: "rx", deletedAt: null, orderCreatedAt: { $gte: monthStart } }),
    Account.countDocuments({}),
    SalesRep.countDocuments({}),
    Product.countDocuments({}),
    WebhookEvent.countDocuments({ status: "failed" }),
    MonthlyPayout.aggregate([
      { $match: { status: { $ne: "Paid" }, month: { $lt: month } } },
      { $group: { _id: null, total: { $sum: { $subtract: ["$amount", PAID_EXPR] } }, rows: { $sum: 1 } } },
    ]),
    Order.aggregate([
      { $match: { tags: "rx", deletedAt: null, demo: { $ne: true }, orderCreatedAt: { $gte: monthStart } } },
      { $group: { _id: null, total: { $sum: "$total" } } },
    ]),
    Order.find({ tags: "rx", deletedAt: null })
      .sort({ orderCreatedAt: -1 })
      .limit(10)
      .select("name orderCreatedAt total customer doctorId practiceId deliveryStatus commission")
      .lean(),
  ]);

  return {
    month,
    stats: {
      openRx,
      rxOrders,
      monthOrders,
      monthSales: monthSales[0]?.total || 0,
      accounts,
      reps,
      products,
      failedWebhooks,
      pendingPayoutTotal: pendingPayouts[0]?.total || 0,
      pendingPayoutRows: pendingPayouts[0]?.rows || 0,
    },
    recent: recent.map((o) => ({
      name: o.name,
      date: o.orderCreatedAt?.toISOString().slice(0, 10) || "",
      customer: [o.customer?.first, o.customer?.last].filter(Boolean).join(" "),
      doctor: o.doctorId,
      practice: o.practiceId,
      total: o.total,
      delivery: o.deliveryStatus,
      logged: !!o.commission?.logged,
    })),
  };
};

const money = (n) =>
  Number(n || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });

function Stat({ label, value, tone }) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="p" variant="bodySm" tone="subdued">
          {label}
        </Text>
        <Text as="p" variant="headingLg" tone={tone}>
          {value}
        </Text>
      </BlockStack>
    </Card>
  );
}

export default function Overview() {
  const { stats, recent, month } = useLoaderData();
  return (
    <Page title="Rx Portal" subtitle={`Month to date: ${month}`}>
      <Layout>
        <Layout.Section>
          <InlineGrid columns={{ xs: 2, md: 4 }} gap="400">
            <Stat label="Open prescriptions" value={stats.openRx} />
            <Stat label="Rx orders this month" value={stats.monthOrders} />
            <Stat label="Rx sales this month" value={money(stats.monthSales)} />
            <Stat
              label={`Unpaid payouts (${stats.pendingPayoutRows})`}
              value={money(stats.pendingPayoutTotal)}
              tone={stats.pendingPayoutTotal > 0 ? "caution" : undefined}
            />
            <Stat label="Rx orders (all time)" value={stats.rxOrders} />
            <Stat label="Portal accounts" value={stats.accounts} />
            <Stat label="Sales reps" value={stats.reps} />
            <Stat
              label="Failed webhooks"
              value={stats.failedWebhooks}
              tone={stats.failedWebhooks > 0 ? "critical" : undefined}
            />
          </InlineGrid>
        </Layout.Section>
        <Layout.Section>
          <Card padding="0">
            <DataTable
              columnContentTypes={["text", "text", "text", "text", "text", "numeric", "text", "text"]}
              headings={["Order", "Date", "Customer", "Doctor", "Practice", "Total", "Delivery", "Commission"]}
              rows={recent.map((o) => [
                o.name,
                o.date,
                o.customer,
                o.doctor,
                o.practice,
                money(o.total),
                o.delivery,
                o.logged ? <Badge tone="success">Logged</Badge> : <Badge>None</Badge>,
              ])}
            />
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
