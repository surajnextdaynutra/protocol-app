import { BlockStack, Box, Divider, InlineGrid, Text } from "@shopify/polaris";

/* One banking record, laid out like the Banking Details form: a heading per
   section and every field in two columns. `sections` comes from
   bankingSections() in services/banking.server.js. */
export function BankingRecord({ sections }) {
  return (
    <BlockStack gap="400">
      {(sections || []).map((s, i) => (
        <BlockStack key={s.title} gap="200">
          {i ? <Divider /> : null}
          <Text as="h3" variant="headingSm">{s.title}</Text>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
            {s.rows.map((r) => (
              <Box key={r.label}>
                <Text as="p" tone="subdued" variant="bodySm">{r.label}</Text>
                <Text as="p" breakWord>{r.value || "—"}</Text>
              </Box>
            ))}
          </InlineGrid>
        </BlockStack>
      ))}
    </BlockStack>
  );
}
