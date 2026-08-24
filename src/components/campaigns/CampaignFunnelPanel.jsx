import React from 'react';

const STAGES = [
  'TERM_DISCOVERED', 'WINNER_ELIGIBLE', 'RESERVED', 'CAMPAIGN_CREATED',
  'AMAZON_ACCEPTED', 'CONFIRMED', 'IMPRESSING', 'CLICKING', 'SELLING',
];

const SOURCES = ['AUTO', 'BROAD', 'PHRASE', 'MANUAL'];

export default function CampaignFunnelPanel({ records = [], transitions = [], loading = false, onRefresh }) {
  const byStage = Object.fromEntries(STAGES.map((stage) => [stage, records.filter((record) => record.stage === stage).length]));
  const bySource = Object.fromEntries(SOURCES.map((source) => [source, records.filter((record) => record.source === source).length]));
  const zeroDelivery = records.filter((record) => Number(record.impressions || 0) === 0).length;
  const confirmed = records.filter((record) => ['CONFIRMED', 'IMPRESSING', 'CLICKING', 'SELLING'].includes(record.stage)).length;
  const selling = records.filter((record) => record.stage === 'SELLING' || Number(record.sales || 0) > 0).length;

  return (
    <section aria-labelledby="campaign-funnel-title" className="rounded-xl border bg-card p-5 shadow-sm">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="campaign-funnel-title" className="text-lg font-semibold">Campaign funnel</h2>
          <p className="text-sm text-muted-foreground">Discovery through Amazon confirmation and delivery</p>
        </div>
        {onRefresh && <button type="button" onClick={onRefresh} disabled={loading} className="rounded-md border px-3 py-2 text-sm">{loading ? 'Refreshing…' : 'Refresh'}</button>}
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Metric label="Total terms" value={records.length} />
        <Metric label="Amazon confirmed" value={confirmed} />
        <Metric label="Zero delivery" value={zeroDelivery} tone={zeroDelivery ? 'warning' : 'normal'} />
        <Metric label="Selling" value={selling} tone="success" />
      </div>

      <div className="mb-6 grid gap-2 md:grid-cols-3 lg:grid-cols-5">
        {STAGES.map((stage, index) => (
          <div key={stage} className="relative rounded-lg border p-3">
            <div className="text-xs text-muted-foreground">{String(index + 1).padStart(2, '0')}</div>
            <div className="mt-1 break-words text-xs font-medium">{stage}</div>
            <div className="mt-2 text-2xl font-semibold">{byStage[stage]}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          <h3 className="mb-3 text-sm font-semibold">Harvest sources</h3>
          <div className="grid grid-cols-2 gap-2">
            {SOURCES.map((source) => <div key={source} className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2 text-sm"><span>{source}</span><strong>{bySource[source]}</strong></div>)}
          </div>
        </div>
        <div>
          <h3 className="mb-3 text-sm font-semibold">Recent transitions</h3>
          <div className="max-h-32 overflow-auto rounded-md border">
            {transitions.length === 0 ? <div className="p-3 text-sm text-muted-foreground">No transitions recorded.</div> : transitions.slice(-8).reverse().map((item, index) => <div key={`${item.from}-${item.to}-${index}`} className="flex justify-between gap-3 border-b px-3 py-2 text-xs last:border-0"><span>{item.from} → {item.to}</span><strong>{item.count ?? 1}</strong></div>)}
          </div>
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value, tone = 'normal' }) {
  const color = tone === 'warning' ? 'text-amber-600' : tone === 'success' ? 'text-emerald-600' : '';
  return <div className="rounded-lg border p-3"><div className="text-xs text-muted-foreground">{label}</div><div className={`mt-1 text-2xl font-semibold ${color}`}>{value}</div></div>;
}
