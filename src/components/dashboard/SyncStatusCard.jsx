import { useMemo } from 'react';
import { Activity, CheckCircle, Clock, XCircle, AlertTriangle } from 'lucide-react';

function NextSyncLabel({ lastSyncAt }) {
  const nextSync = new Date(new Date(lastSyncAt).getTime() + 24 * 3600000);
  const diffMs = nextSync.getTime() - Date.now();
  const diffH = Math.floor(diffMs / 3600000);
  const diffM = Math.floor((diffMs % 3600000) / 60000);
  const label = diffMs <= 0 ? 'Em breve' : diffH > 0 ? `em ~${diffH}h${diffM > 0 ? diffM + 'm' : ''}` : `em ~${diffM}min`;
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] text-slate-600">·</span>
      <p className="text-[10px] text-slate-500">Próxima atualização: <span className="text-slate-400">{label}</span></p>
    </div>
  );
}

function fmtDateBRFull(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function StatusDot({ status }) {
  if (status === 'success') return <span className="w-2 h-2 rounded-full bg-emerald-400 flex-shrink-0" />;
  if (status === 'stale') return <span className="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0" />;
  if (status === 'error') return <span className="w-2 h-2 rounded-full bg-red-400 flex-shrink-0" />;
  return <span className="w-2 h-2 rounded-full bg-slate-500 flex-shrink-0" />;
}

export default function SyncStatusCard({ allMetrics, salesDaily, account, adsSales, spRevenue }) {
  const syncInfo = useMemo(() => {
    // Última data de CampaignMetricsDaily (Ads API)
    const adsDates = allMetrics.map((m) => m.date).filter(Boolean).sort();
    const adsThroughDate = adsDates.length > 0 ? adsDates[adsDates.length - 1] : null;

    // Última data de SalesDaily (SP-API)
    const spDates = salesDaily.map((s) => s.date).filter(Boolean).sort();
    const spThroughDate = spDates.length > 0 ? spDates[spDates.length - 1] : null;

    // Gap em dias
    let gapDays = null;
    if (adsThroughDate && spThroughDate) {
      gapDays = Math.round(
        (new Date(adsThroughDate).getTime() - new Date(spThroughDate).getTime()) / 86400000
      );
    }

    const adsStatus = adsThroughDate ? 'success' : 'error';
    const spStatus = spThroughDate ?
    gapDays !== null && gapDays > 2 ? 'stale' : 'success' :
    'error';

    const overallStatus =
    adsStatus === 'error' || spStatus === 'error' ? 'error' :
    gapDays !== null && gapDays > 0 ? 'partial' : 'success';

    const lastSyncAt = account?.last_sync_at;

    // Detectar divergência: Ads tem vendas mas SP-API tem zero no mesmo período
    const hasAdsSales = Number(adsSales) > 0;
    const hasSpRevenue = Number(spRevenue) > 0;
    const reconciliationStatus = hasAdsSales && !hasSpRevenue ? 'pending' : hasAdsSales && hasSpRevenue ? 'reconciled' : 'no_sales';

    return { adsThroughDate, spThroughDate, gapDays, adsStatus, spStatus, overallStatus, lastSyncAt, reconciliationStatus };
  }, [allMetrics, salesDaily, account, adsSales, spRevenue]);

  const { adsThroughDate, spThroughDate, gapDays, adsStatus, spStatus, overallStatus, lastSyncAt, reconciliationStatus } = syncInfo;

  const borderColor =
  overallStatus === 'success' ? 'border-emerald-500/20 bg-emerald-500/5' :
  overallStatus === 'partial' ? 'border-amber-500/20 bg-amber-500/5' :
  'border-red-500/20 bg-red-500/5';

  const icon =
  overallStatus === 'success' ? <CheckCircle className="w-3.5 h-3.5 text-emerald-400" /> :
  overallStatus === 'partial' ? <CheckCircle className="w-3.5 h-3.5 text-amber-400" /> :
  <XCircle className="w-3.5 h-3.5 text-red-400" />;

  return (
    <div className={`border rounded-xl px-4 py-3 ${borderColor}`}>
      <div className="flex items-center justify-between mb-2.5 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Activity className="w-3.5 h-3.5 text-slate-400" />
          <span className="text-xs font-semibold text-slate-300">Sincronização das APIs</span>
        </div>
        <div className="flex items-center gap-1.5">
          {icon}
          <span className={`text-xs font-semibold hidden ${
          overallStatus === 'success' ? 'text-emerald-400' :
          overallStatus === 'partial' ? 'text-amber-400' : 'text-red-400'}`
          }>
            {overallStatus === 'success' ? 'Sincronizado' :
            overallStatus === 'partial' ? 'Parcialmente sincronizado' : 'Erro de sincronização'}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-[10px]">
        {/* Amazon Ads API */}
        <div className="bg-surface-2 rounded-lg px-3 py-2 space-y-1">
          <div className="flex items-center gap-1.5">
            <StatusDot status={adsStatus} />
            <span className="text-slate-400 font-semibold">Amazon Ads API</span>
          </div>
          <p className="text-slate-300">Dados até: <span className="font-semibold text-white">{fmtDateBRFull(adsThroughDate)}</span></p>
          <p className={`${adsStatus === 'success' ? 'text-emerald-400' : 'text-red-400'}`}>
            {adsStatus === 'success' ? 'Disponível' : 'Sem dados'}
          </p>
        </div>

        {/* SP-API */}
        <div className="bg-surface-2 rounded-lg px-3 py-2 space-y-1">
          <div className="flex items-center gap-1.5">
            <StatusDot status={spStatus} />
            <span className="text-slate-400 font-semibold">SP-API (Faturamento)</span>
          </div>
          <p className="text-slate-300">Dados até: <span className="font-semibold text-white">{fmtDateBRFull(spThroughDate)}</span></p>
          <p className={`${spStatus === 'success' ? 'text-emerald-400' : spStatus === 'stale' ? 'text-amber-400' : 'text-red-400'}`}>
            {spStatus === 'success' ? 'Disponível' : spStatus === 'stale' ? 'Desatualizado' : 'Sem dados'}
          </p>
        </div>
      </div>

      {/* Alerta de divergência de reconciliação */}
      {reconciliationStatus === 'pending' ? (
        <div className="mt-2.5 flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-0.5" />
          <div className="text-[10px] space-y-0.5">
            <p className="font-semibold text-amber-300">Divergência detectada — reconciliação pendente</p>
            <p className="text-amber-400/80">Ads indica vendas atribuídas, mas SP-API retornou R$&nbsp;0,00 no período. Possíveis causas: atraso de sync SP-API, janela de atribuição diferente, pedido pendente/cancelado, SKU não vinculado ou timezone divergente.</p>
            <p className="text-slate-400 mt-1">⚠ O motor não deve classificar lucro como confirmado nem pausar campanha com base nestes dados até a reconciliação.</p>
          </div>
        </div>
      ) : null}

      <div className="mt-2 flex items-center gap-3 flex-wrap">
        {lastSyncAt ? (
          <div className="flex items-center gap-1.5">
            <Clock className="w-3 h-3 text-slate-600" />
            <p className="text-[10px] text-slate-500">
              Último sync: {new Date(lastSyncAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
            </p>
          </div>
        ) : null}
        {lastSyncAt ? (
          <NextSyncLabel lastSyncAt={lastSyncAt} />
        ) : null}
      </div>
    </div>);

}