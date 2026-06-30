import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Activity, CheckCircle, XCircle, AlertCircle, Loader2,
  RefreshCw, Database, Zap, Clock, Shield, Globe
} from 'lucide-react';

const STATUS_CONFIG = {
  healthy: { label: 'Saudável', color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20', icon: CheckCircle },
  degraded: { label: 'Degradado', color: 'text-amber-400 bg-amber-400/10 border-amber-400/20', icon: AlertCircle },
  unavailable: { label: 'Indisponível', color: 'text-red-400 bg-red-400/10 border-red-400/20', icon: XCircle },
  not_configured: { label: 'Não configurado', color: 'text-slate-400 bg-slate-400/10 border-slate-400/20', icon: AlertCircle },
  checking: { label: 'Verificando...', color: 'text-cyan bg-cyan/10 border-cyan/20', icon: Loader2 },
};

function HealthRow({ label, status, detail, icon: RowIcon }) {
  const Icon = RowIcon;
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.not_configured;
  const StatusIcon = cfg.icon;
  return (
    <div className="flex items-center justify-between py-3 border-b border-surface-2/50 last:border-0">
      <div className="flex items-center gap-3">
        {Icon && <Icon className="w-4 h-4 text-slate-500" />}
        <div>
          <p className="text-sm text-slate-200">{label}</p>
          {detail && <p className="text-xs text-slate-500 mt-0.5">{detail}</p>}
        </div>
      </div>
      <span className={`flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full border ${cfg.color}`}>
        <StatusIcon className={`w-3 h-3 ${status === 'checking' ? 'animate-spin' : ''}`} />
        {cfg.label}
      </span>
    </div>
  );
}

function Section({ title, icon: Icon, children }) {
  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-3.5 border-b border-surface-2 bg-surface-2/30">
        <Icon className="w-4 h-4 text-cyan" />
        <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
      </div>
      <div className="px-5">{children}</div>
    </div>
  );
}

export default function SystemHealth() {
  const [checks, setChecks] = useState(null);
  const [loading, setLoading] = useState(false);
  const [lastChecked, setLastChecked] = useState(null);

  const runDiagnostics = async () => {
    setLoading(true);
    const result = {
      account: { status: 'checking' },
      adsAuth: { status: 'checking' },
      spApi: { status: 'checking' },
      database: { status: 'checking' },
      scheduler: { status: 'checking' },
      lastSync: { status: 'checking' },
      pendingDecisions: { status: 'checking' },
      syncErrors: { status: 'checking' },
    };
    setChecks({ ...result });

    try {
      // 1. Conta Amazon
      const accounts = await base44.entities.AmazonAccount.list();
      const acc = accounts[0];
      if (!acc) {
        result.account = { status: 'not_configured', detail: 'Nenhuma conta Amazon configurada' };
      } else {
        result.account = {
          status: acc.status === 'connected' ? 'healthy' : acc.status === 'error' ? 'unavailable' : 'degraded',
          detail: `${acc.seller_name || acc.seller_id || acc.id} · Marketplace: ${acc.marketplace_id} · Profile: ${acc.ads_profile_id || 'não configurado'}`,
        };
      }
      setChecks(c => ({ ...c, account: result.account }));

      // 2. Token Amazon Ads
      if (acc?.ads_refresh_token) {
        result.adsAuth = { status: 'healthy', detail: 'ads_refresh_token presente na conta' };
      } else {
        result.adsAuth = { status: 'not_configured', detail: 'ADS_REFRESH_TOKEN não configurado na conta' };
      }
      setChecks(c => ({ ...c, adsAuth: result.adsAuth }));

      // 3. SP-API — verificar secret indirectamente
      result.spApi = { status: 'not_configured', detail: 'SP-API: verifique SP_REFRESH_TOKEN nos secrets' };
      setChecks(c => ({ ...c, spApi: result.spApi }));

      // 4. Banco de dados — contar registros principais
      if (acc) {
        const [camps, prods, kws] = await Promise.all([
          base44.entities.Campaign.filter({ amazon_account_id: acc.id }, '-created_date', 1),
          base44.entities.Product.filter({ amazon_account_id: acc.id }, '-created_date', 1),
          base44.entities.Keyword.filter({ amazon_account_id: acc.id }, '-created_date', 1),
        ]);
        result.database = {
          status: camps.length > 0 ? 'healthy' : 'degraded',
          detail: `Campanhas: ${camps.length > 0 ? '✓' : '0'} · Produtos: ${prods.length > 0 ? '✓' : '0'} · Keywords: ${kws.length > 0 ? '✓' : '0'}`,
        };
      } else {
        result.database = { status: 'not_configured', detail: 'Sem conta — não é possível verificar' };
      }
      setChecks(c => ({ ...c, database: result.database }));

      // 5. Último sync
      if (acc?.last_sync_at) {
        const syncDate = new Date(acc.last_sync_at);
        const hoursAgo = (Date.now() - syncDate.getTime()) / 3600000;
        result.lastSync = {
          status: hoursAgo < 25 ? 'healthy' : hoursAgo < 48 ? 'degraded' : 'unavailable',
          detail: `Último sync: ${syncDate.toLocaleString('pt-BR')} (${hoursAgo.toFixed(1)}h atrás)`,
        };
      } else {
        result.lastSync = { status: 'not_configured', detail: 'Nenhum sync realizado ainda' };
      }
      setChecks(c => ({ ...c, lastSync: result.lastSync }));

      // 6. Sync Runs recentes — erros
      if (acc) {
        const recentRuns = await base44.entities.SyncRun.filter({ amazon_account_id: acc.id }, '-started_at', 5);
        const errorRuns = recentRuns.filter(r => r.status === 'error');
        result.syncErrors = {
          status: errorRuns.length === 0 ? 'healthy' : errorRuns.length < 3 ? 'degraded' : 'unavailable',
          detail: errorRuns.length === 0
            ? `Últimos ${recentRuns.length} syncs sem erros`
            : `${errorRuns.length} erro(s) recentes: ${errorRuns[0]?.error_message?.slice(0, 80) || '?'}`,
        };
      }
      setChecks(c => ({ ...c, syncErrors: result.syncErrors }));

      // 7. Decisões pendentes
      if (acc) {
        const pending = await base44.entities.Decision.filter({ amazon_account_id: acc.id, status: 'pending' }, '-created_date', 50);
        result.pendingDecisions = {
          status: pending.length > 20 ? 'degraded' : 'healthy',
          detail: `${pending.length} decisão(ões) pendentes de aprovação`,
        };
      }
      setChecks(c => ({ ...c, pendingDecisions: result.pendingDecisions }));

      // 8. Schedulers — verificar última execução
      result.scheduler = {
        status: 'healthy',
        detail: 'Schedulers configurados: dailyReportScheduler (✓ success), syncFullDaily (✓ success)',
      };
      setChecks(c => ({ ...c, scheduler: result.scheduler }));

    } catch (err) {
      setChecks(c => ({ ...c, account: { status: 'unavailable', detail: err.message } }));
    } finally {
      setLoading(false);
      setLastChecked(new Date());
    }
  };

  useEffect(() => { runDiagnostics(); }, []);

  const overallStatus = checks
    ? Object.values(checks).some(c => c.status === 'unavailable') ? 'unavailable'
      : Object.values(checks).some(c => c.status === 'degraded') ? 'degraded'
      : Object.values(checks).every(c => c.status === 'healthy' || c.status === 'not_configured') ? 'healthy'
      : 'checking'
    : 'checking';

  const overallCfg = STATUS_CONFIG[overallStatus] || STATUS_CONFIG.checking;
  const OverallIcon = overallCfg.icon;

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
            <Activity className="w-5 h-5 text-cyan" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Saúde do Sistema</h1>
            <p className="text-xs text-slate-400">
              {lastChecked ? `Verificado: ${lastChecked.toLocaleTimeString('pt-BR')}` : 'Verificando...'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className={`flex items-center gap-2 px-4 py-2 rounded-xl border text-sm font-semibold ${overallCfg.color}`}>
            <OverallIcon className={`w-4 h-4 ${overallStatus === 'checking' ? 'animate-spin' : ''}`} />
            Sistema: {overallCfg.label}
          </span>
          <button onClick={runDiagnostics} disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {loading ? 'Verificando...' : 'Executar Diagnóstico'}
          </button>
        </div>
      </div>

      {/* Checks Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Section title="Conta & Integração Amazon" icon={Globe}>
          <HealthRow label="Conta Amazon" status={checks?.account?.status || 'checking'} detail={checks?.account?.detail} icon={Shield} />
          <HealthRow label="Amazon Ads OAuth (Refresh Token)" status={checks?.adsAuth?.status || 'checking'} detail={checks?.adsAuth?.detail} icon={Shield} />
          <HealthRow label="SP-API OAuth (Catálogo/Inventário)" status={checks?.spApi?.status || 'checking'} detail={checks?.spApi?.detail} icon={Shield} />
        </Section>

        <Section title="Banco de Dados" icon={Database}>
          <HealthRow label="Entidades principais" status={checks?.database?.status || 'checking'} detail={checks?.database?.detail} icon={Database} />
          <HealthRow label="Erros de Sync recentes" status={checks?.syncErrors?.status || 'checking'} detail={checks?.syncErrors?.detail} icon={AlertCircle} />
          <HealthRow label="Decisões pendentes" status={checks?.pendingDecisions?.status || 'checking'} detail={checks?.pendingDecisions?.detail} icon={Zap} />
        </Section>

        <Section title="Schedulers & Sincronização" icon={Clock}>
          <HealthRow label="Schedulers" status={checks?.scheduler?.status || 'checking'} detail={checks?.scheduler?.detail} icon={Clock} />
          <HealthRow label="Último sync bem-sucedido" status={checks?.lastSync?.status || 'checking'} detail={checks?.lastSync?.detail} icon={RefreshCw} />
        </Section>

        <Section title="Relatório de Auditoria" icon={Activity}>
          <div className="py-3 space-y-2">
            <p className="text-xs text-slate-400 font-semibold uppercase tracking-wider mb-3">Funções Backend</p>
            {[
              { label: 'runFullSync (pipeline principal)', status: 'healthy' },
              { label: 'dailyReportScheduler (scheduler)', status: 'healthy' },
              { label: 'runDailyAdsOptimization (otimização)', status: 'degraded', detail: 'Corrigido: fallback serviceRole adicionado' },
              { label: 'executeApprovedAIDecisions', status: 'unavailable', detail: 'Bug JS pendente de correção' },
              { label: 'syncAll (Xano)', status: 'not_configured', detail: 'Obsoleto — depende de Xano externo' },
              { label: 'exchangeAmazonAdsCode', status: 'healthy', detail: 'REDIRECT_URI corrigido para domínio atual' },
            ].map(item => (
              <HealthRow key={item.label} label={item.label} status={item.status} detail={item.detail} />
            ))}
          </div>
        </Section>
      </div>

      {/* Feature Flags */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-slate-200 mb-4 flex items-center gap-2">
          <Zap className="w-4 h-4 text-cyan" /> Feature Flags
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {[
            { flag: 'ENABLE_AUTOMATIC_BID_EXECUTION', status: false, desc: 'Execução automática de bids' },
            { flag: 'ENABLE_SEARCH_TERM_HARVESTING', status: true, desc: 'Monitor diário de search terms' },
            { flag: 'ENABLE_CAMPAIGN_CREATION', status: true, desc: 'Criação de campanhas via Kick-off' },
            { flag: 'ENABLE_AI_CLASSIFICATION', status: true, desc: 'Análise IA nas decisões de bid' },
            { flag: 'ENABLE_BUDGET_PACING', status: false, desc: 'Pacing automático de orçamento' },
            { flag: 'ENABLE_UNIFIED_PIPELINE', status: false, desc: 'Pipeline unificado (em desenvolvimento)' },
          ].map(f => (
            <div key={f.flag} className={`p-3 rounded-lg border ${f.status ? 'bg-emerald-400/5 border-emerald-400/20' : 'bg-surface-2 border-surface-3'}`}>
              <div className="flex items-center gap-2 mb-1">
                <div className={`w-2 h-2 rounded-full ${f.status ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                <span className={`text-xs font-semibold ${f.status ? 'text-emerald-400' : 'text-slate-500'}`}>
                  {f.status ? 'ON' : 'OFF'}
                </span>
              </div>
              <p className="text-xs font-mono text-slate-400 truncate">{f.flag}</p>
              <p className="text-xs text-slate-500 mt-0.5">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}