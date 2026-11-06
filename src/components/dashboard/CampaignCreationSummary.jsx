import React, { useMemo } from 'react';

const dateOf = (campaign) => campaign?.created_at || campaign?.created_date || campaign?.createdAt || null;
const idOf = (campaign) => String(campaign?.campaign_id || campaign?.amazon_campaign_id || campaign?.id || '');
const dateKeyBrt = (date = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date);

const fmtDate = (value) => value
  ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(value))
  : 'data não informada';

function CampaignList({ title, rows }) {
  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        <span className="text-xs text-slate-400">{rows.length} campanha(s)</span>
      </div>
      {rows.length === 0 ? <p className="text-xs text-slate-500">Nenhuma campanha criada no período.</p> : (
        <div className="space-y-2 max-h-56 overflow-auto">
          {rows.map((campaign) => (
            <div key={idOf(campaign)} className="flex items-center justify-between gap-3 border-b border-surface-2/60 pb-2 last:border-0">
              <div className="min-w-0">
                <p className="text-xs text-slate-200 truncate">{campaign.name || campaign.campaign_name || idOf(campaign) || 'Campanha sem nome'}</p>
                <p className="text-[10px] text-slate-500">{campaign.asin || 'ASIN não informado'} · {campaign.targeting_type || campaign.campaign_type || 'SP'} · {fmtDate(dateOf(campaign))}</p>
              </div>
              <span className="shrink-0 text-[10px] text-slate-400">{String(campaign.state || campaign.status || '—').toLowerCase()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function CampaignCreationSummary({ campaigns = [] }) {
  const summary = useMemo(() => {
    const unique = new Map();
    for (const campaign of campaigns) {
      const id = idOf(campaign);
      const created = dateOf(campaign);
      if (!created || (id && unique.has(id))) continue;
      if (id) unique.set(id, campaign);
      else unique.set(`${created}:${campaign.name || campaign.campaign_name || Math.random()}`, campaign);
    }
    const rows = [...unique.values()];
    const now = Date.now();
    const today = dateKeyBrt();
    const inWindow = (days) => rows.filter((campaign) => {
      const created = new Date(dateOf(campaign));
      if (!Number.isFinite(created.getTime())) return false;
      const age = now - created.getTime();
      return age >= 0 && age < days * 86400000;
    });
    const todayRows = rows.filter((campaign) => dateKeyBrt(new Date(dateOf(campaign))) === today);
    return { today: todayRows, week: inWindow(7), month: inWindow(30) };
  }, [campaigns]);

  return (
    <section className="mb-5" aria-label="Campanhas criadas">
      <div className="flex items-end justify-between mb-3">
        <div>
          <h2 className="text-base font-semibold text-white">Campanhas criadas</h2>
          <p className="text-xs text-slate-500">Atualização por período · hoje, últimos 7 dias e últimos 30 dias</p>
        </div>
      </div>
      <div className="grid md:grid-cols-3 gap-3 mb-3">
        {[['Hoje', summary.today], ['Últimos 7 dias', summary.week], ['Últimos 30 dias', summary.month]].map(([label, rows]) => (
          <div key={label} className="bg-surface-1 border border-surface-2 rounded-xl p-4">
            <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
            <p className="text-2xl font-bold text-white mt-1">{rows.length}</p>
            <p className="text-[10px] text-slate-500">campanha(s)</p>
          </div>
        ))}
      </div>
      <div className="grid lg:grid-cols-3 gap-3">
        <CampaignList title="Criadas hoje" rows={summary.today} />
        <CampaignList title="Criadas nos últimos 7 dias" rows={summary.week} />
        <CampaignList title="Criadas nos últimos 30 dias" rows={summary.month} />
      </div>
    </section>
  );
}
