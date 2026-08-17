export function snapshotDateFromFileName(fileName: unknown): string | null {
  return String(fileName || "").match(/(20\d{2})-(\d{2})-(\d{2})/)?.[0] || null;
}

function normalizedHeader(value: unknown) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function rowValue(row: any, ...aliases: string[]) {
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(row || {}, alias)) return row[alias];
  }
  const values = new Map(
    Object.entries(row || {}).map(([key, value]) => [normalizedHeader(key), value]),
  );
  for (const alias of aliases) {
    const key = normalizedHeader(alias);
    if (values.has(key)) return values.get(key);
  }
  return undefined;
}

export function mapAnalyticsSpreadsheetRow(row: any, fileName?: string) {
  const revenue = rowValue(row, "Faturamento") ?? null;
  const adsCost = rowValue(row, "Custo Ads") ?? null;
  const marginAfterAds = rowValue(row, "MPA (Margem Pós ADS)", "MPA (Margem Pos ADS)") ?? null;
  const noSalesWithSpend = Number(revenue || 0) <= 0 && Number(adsCost || 0) > 0;
  return {
    sku: rowValue(row, "SKU Interno", "SKU", "Seller SKU") ||
      rowValue(row, "SKU externo (opcional)", "SKU externo") || "",
    product_name: rowValue(row, "Título", "Titulo", "Produto") || "",
    unit_cost: rowValue(row, "Custo Unitário Médio", "Custo Unitario Medio", "Preço de Custo", "Preco de Custo", "Custo"),
    other_variable_cost_per_unit: rowValue(row, "Custo Extra (opcional)", "Custo Extra") ?? 0,
    cost_source: "user_analytics_spreadsheet",
    analytics_import_source_file: fileName || null,
    analytics_import_snapshot_date: snapshotDateFromFileName(fileName),
    analytics_import_metrics: {
      average_selling_price: rowValue(row, "Preço", "Preco") ?? null,
      units_sold_total: rowValue(row, "Unidades Vendidas Totais") ?? null,
      amazon_units: rowValue(row, "Vendas Amazon") ?? null,
      revenue,
      profit_before_ads: rowValue(row, "Lucro") ?? null,
      margin_before_ads_pct: rowValue(row, "Margem") ?? null,
      ads_cost: adsCost,
      profit_after_ads: rowValue(row, "Lucro Pós Ads", "Lucro Pos Ads") ?? null,
      // Percentual sobre faturamento zero não existe matematicamente. Preserva
      // o prejuízo absoluto, mas não grava -2990%, -72% ou outro denominador artificial.
      margin_after_ads_pct: noSalesWithSpend ? null : marginAfterAds,
      economic_status: noSalesWithSpend ? "no_sales_with_spend" : null,
      margin_after_ads_not_calculable: noSalesWithSpend,
      scope: "user_supplied_analytics_snapshot",
      canonical_metrics: false,
    },
  };
}
