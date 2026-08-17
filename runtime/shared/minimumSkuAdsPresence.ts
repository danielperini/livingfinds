const n = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function chooseMinimumPresenceHours(rows: any[], minimumHours = 2): number[] {
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, spend: 0, sales: 0, clicks: 0, orders: 0 }));
  for (const row of rows || []) {
    const hour = n(row?.hour);
    if (hour < 0 || hour > 23) continue;
    hours[hour].spend += n(row.cost ?? row.spend);
    hours[hour].sales += n(row.promoted_sales ?? row.sales);
    hours[hour].clicks += n(row.clicks);
    hours[hour].orders += n(row.promoted_purchases ?? row.orders);
  }
  const observed = hours.filter((row) => row.clicks > 0 || row.spend > 0 || row.sales > 0);
  if (!observed.length) return [11, 12].slice(0, Math.max(1, minimumHours));
  return observed
    .sort((a, b) => {
      const aScore = a.sales > 0 ? (a.sales - a.spend) + a.orders * 10 : -a.spend;
      const bScore = b.sales > 0 ? (b.sales - b.spend) + b.orders * 10 : -b.spend;
      return bScore - aScore || b.clicks - a.clicks || a.hour - b.hour;
    })
    .slice(0, Math.max(1, minimumHours))
    .map((row) => row.hour)
    .sort((a, b) => a - b);
}

export function minimumPresenceGate(input: {
  stock: unknown;
  buyable: boolean;
  economicsComplete: boolean;
  profitBeforeAds: unknown;
  safeMaxCpc: unknown;
  minimumBid: unknown;
  configuredDailyCap?: unknown;
}) {
  const stock = Math.floor(n(input.stock));
  const profitBeforeAds = n(input.profitBeforeAds);
  const safeMaxCpc = n(input.safeMaxCpc);
  const minimumBid = n(input.minimumBid);
  if (stock <= 0) return { eligible: false, reason: 'OUT_OF_STOCK', dailyCap: 0 };
  if (!input.buyable) return { eligible: false, reason: 'NOT_BUYABLE', dailyCap: 0 };
  if (!input.economicsComplete || profitBeforeAds <= 0) return { eligible: false, reason: 'ECONOMICS_INCOMPLETE_OR_LOSS', dailyCap: 0 };
  if (!(safeMaxCpc >= minimumBid) || minimumBid <= 0) return { eligible: false, reason: 'SAFE_CPC_BELOW_MINIMUM_BID', dailyCap: 0 };

  // Estoque unitário recebe no máximo 15% da contribuição de uma venda por dia.
  const inventoryFactor = stock === 1 ? 0.15 : stock <= 3 ? 0.20 : 0.25;
  const economicCap = Math.min(profitBeforeAds * inventoryFactor, safeMaxCpc * 4);
  const configuredCap = n(input.configuredDailyCap);
  const dailyCap = Math.floor(Math.min(economicCap, configuredCap > 0 ? configuredCap : economicCap) * 100) / 100;
  if (dailyCap < minimumBid) return { eligible: false, reason: 'DAILY_CAP_BELOW_MINIMUM_BID', dailyCap };
  return { eligible: true, reason: 'MINIMUM_PRESENCE_SAFE', dailyCap };
}
