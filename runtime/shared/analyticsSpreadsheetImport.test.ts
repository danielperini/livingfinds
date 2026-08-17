import { assertEquals } from "jsr:@std/assert";
import { mapAnalyticsSpreadsheetRow } from "./analyticsSpreadsheetImport.ts";

Deno.test("mapeia products analytics sem promover métricas a canônicas", () => {
  const item = mapAnalyticsSpreadsheetRow({
    "SKU Interno": "FBA-0076A", "Custo Unitário Médio": 40,
    "Preço": 74.42, "Unidades Vendidas Totais": 125,
  }, "products_analytics_2026-08-01.xlsx");
  assertEquals(item.unit_cost, 40);
  assertEquals(item.analytics_import_snapshot_date, "2026-08-01");
  assertEquals(item.analytics_import_metrics.canonical_metrics, false);
});

Deno.test("zero de vendas não apaga custo válido", () => {
  const item = mapAnalyticsSpreadsheetRow({
    "SKU Interno": "FBA-0010b", "Custo Unitário Médio": 57.55,
    "Unidades Vendidas Totais": 0,
  });
  assertEquals(item.unit_cost, 57.55);
  assertEquals(item.analytics_import_metrics.units_sold_total, 0);
});

Deno.test("receita zero com Ads preserva prejuízo absoluto e invalida percentual", () => {
  const item = mapAnalyticsSpreadsheetRow({
    "SKU Interno": "FBA-0010b", "Faturamento": 0, "Custo Ads": 29.90,
    "Lucro Pós Ads": -29.90, "MPA (Margem Pós ADS)": -2990,
  });
  assertEquals(item.analytics_import_metrics.profit_after_ads, -29.90);
  assertEquals(item.analytics_import_metrics.margin_after_ads_pct, null);
  assertEquals(item.analytics_import_metrics.economic_status, "no_sales_with_spend");
});

Deno.test("aceita cabeçalhos equivalentes sem acentos", () => {
  const item = mapAnalyticsSpreadsheetRow({
    "Seller SKU": "FBA-0076C",
    "Titulo": "Interruptor 4 botões",
    "Preco de Custo": 43,
    "Custo Extra": 2,
  });
  assertEquals(item.sku, "FBA-0076C");
  assertEquals(item.product_name, "Interruptor 4 botões");
  assertEquals(item.unit_cost, 43);
  assertEquals(item.other_variable_cost_per_unit, 2);
});
