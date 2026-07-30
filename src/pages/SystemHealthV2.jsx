import { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Activity, AlertCircle, CheckCircle, Clock, Database, Globe, Loader2, RefreshCw, Shield, XCircle, Zap } from 'lucide-react';

const CFG = {
  healthy: ['Saudável', 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20', CheckCircle],
  degraded: ['Degradado', 'text-amber-400 bg-amber-400/10 border-amber-400/20', AlertCircle],
  unavailable: ['Indisponível', 'text-red-400 bg-red-400/10 border-red-400/20', XCircle],
  not_configured: ['Não configurado', 'text-slate-400 bg-slate-400/10 border-slate-400/20', AlertCircle],
  checking: ['Verificando...', 'text-cyan bg-cyan/10 border-cyan/20', Loader2],
};

function Row({ label, status = 'checking', detail, icon: Icon }) {
  const [text, cls, StatusIcon] = CFG[status] || CFG.not_configured;
  return <div className="flex items-center justify-between gap-4 border-b border-surface-2/50 py-3 last:border-0">
    <div className="flex items-center gap-3">{Icon && <Icon className="h-4 w-4 text-slate-500" />}<div><p className="text-sm text-slate-200">{label}</p>{detail && <p className="mt-0.5 text-xs text-slate-500">{detail}</p>}</div></div>
    <span className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${cls}`}><StatusIcon className={`h-3 w-3 ${status === 'checking' ? 'animate-spin' : ''}`} />{text}</span>
  </div>;
}

function Section({ title, icon: Icon, children }) {
  return <div className="overflow-hidden rounded-xl border border-surface-2 bg-surface-1"><div className="flex items-center gap-2 border-b border-surface-2 bg-surface-2/30 px-5 py-3.5"><Icon className="h-4 w-4 text-cyan" /><h3 className="text-sm font-semibold text-slate-200">{title}</h3></div><div className="px-5">{children}</div></div>;
}

const benignLock = (log) => {
  const text = `${log?.error_message || ''} ${log?.result_summary || ''}`.toLowerCase();
  return text.includes('sync lock liberado') || text.includes('lock released') || text.includes('guardrail');
};

const dateText = (value) => value ? new Date(value).toLocaleString('pt-BR') : 'sem registro';

export default function SystemHealthV2() {
  const [checks, setChecks] = useState({});
  const [loading, setLoading] = useState(false);
  const [lastChecked, setLastChecked] = useState(null);

  async function diagnose() {
    setLoading(true);
    try {
      const accounts = await base44.entities.AmazonAccount.list();
      const account = accounts[0];
      if (!account) {
        setChecks({ account: { status: 'not_configured', detail: 'Nenhuma conta Amazon configurada' } });
        return;
      }

      const accountId = account.id;
      const [campaigns, products, keywords, logs, decisions, locks] = await Promise.all([
        base44.entities.Campaign.filter({ amazon_account_id: accountId }, '-created_date', 1000),
        base44.entities.Product.filter({ amazon_account_id: accountId }, '-created_date', 500),
        base44.entities.Keyword.filter({ amazon_account_id: accountId }, '-created_date', 1000),
        base44.entities.SyncExecutionLog.filter({ amazon_account_id: accountId }, '-started_at', 200),
        base44.entities.OptimizationDecision.filter({ amazon_account_id: accountId }, '-created_at', 500),
        base44.entities.AmazonSchedulerLock.filter({ amazon_account_id: accountId }, '-acquired_at', 50),
      ]);

      // Diagnóstico é estritamente read-only: abrir o painel nunca executa
      // decisões nem produz escrita na Amazon.
      const byStatus = (status) => decisions.filter((decision) => decision.status === status);
      const proposed = byStatus('proposed');
      const approved = byStatus('approved');
      const executed = byStatus('executed');
      const confirmed = executed.filter((decision) => decision.confirmed_at || decision.confirmation_status === 'confirmed');
      const activeLocks = locks.filter((lock) => lock.status === 'acquired' && new Date(lock.expires_at || 0).getTime() > Date.now());
      const actualErrors = logs.filter((log) => String(log.status).toLowerCase() === 'error' && !benignLock(log));
      const recoveredLocks = logs.filter((log) => benignLock(log));
      const successfulLogs = logs.filter((log) => ['success', 'completed'].includes(String(log.status).toLowerCase()));
      const lastSuccess = successfulLogs[0];
      const hoursAgo = lastSuccess?.completed_at || lastSuccess?.started_at ? (Date.now() - new Date(lastSuccess.completed_at || lastSuccess.started_at).getTime()) / 3600000 : null;

      const operation = (log) => String(log?.operation || log?.sync_type || log?.job_name || '').toLowerCase();
      const dailyReport = logs.find((log) => operation(log).includes('dailyreport') || operation(log).includes('daily_report'));
      const fullDaily = logs.find((log) => operation(log).includes('syncfulldaily') || operation(log).includes('full_daily') || operation(log).includes('sync_full'));
      const schedulerKnown = Boolean(dailyReport || fullDaily);
      const schedulerErrors = [dailyReport, fullDaily].filter((log) => log && String(log.status).toLowerCase() === 'error');
      const productSyncOk = successfulLogs.some((log) => operation(log).includes('product') || operation(log).includes('catalog') || operation(log).includes('inventory'));

      setChecks({
        account: {
          status: account.status === 'connected' ? 'healthy' : account.status === 'error' ? 'unavailable' : 'degraded',
          detail: `${account.seller_name || account.seller_id || account.id} · Marketplace: ${account.marketplace_id || 'não informado'} · Profile: ${account.ads_profile_id || 'não configurado'}`,
        },
        adsAuth: {
          status: account.ads_refresh_token && account.ads_profile_id ? 'healthy' : 'not_configured',
          detail: account.ads_refresh_token && account.ads_profile_id ? 'Refresh token e perfil Ads presentes' : 'Refresh token ou Profile ID ausente',
        },
        spApi: {
          status: productSyncOk ? 'healthy' : lastSuccess ? 'degraded' : 'not_configured',
          detail: productSyncOk ? 'Catálogo/inventário sincronizados com sucesso nos logs recentes' : 'Sem confirmação recente de sync de catálogo/inventário',
        },
        database: {
          status: campaigns.length && products.length && keywords.length ? 'healthy' : 'degraded',
          detail: `Campanhas: ${campaigns.length ? '✓' : '0'} · Produtos: ${products.length ? '✓' : '0'} · Keywords: ${keywords.length ? '✓' : '0'}`,
        },
        syncErrors: {
          status: actualErrors.length === 0 ? 'healthy' : actualErrors.length < 3 ? 'degraded' : 'unavailable',
          detail: actualErrors.length ? `${actualErrors.length} erro(s) real(is): ${actualErrors[0]?.error_message?.slice(0, 100) || 'sem detalhe'}` : `Sem erros reais${recoveredLocks.length ? ` · ${recoveredLocks.length} lock(s) recuperado(s) ignorado(s)` : ''}`,
        },
        pendingDecisions: {
          status: approved.length ? 'degraded' : proposed.length > 20 ? 'degraded' : 'healthy',
          detail: `${proposed.length} propostas/shadow · ${approved.length} aprovadas aguardando execução · diagnóstico somente leitura`,
        },
        confirmations: {
          status: executed.length === confirmed.length ? 'healthy' : executed.length - confirmed.length > 10 ? 'unavailable' : 'degraded',
          detail: `${executed.length} executadas · ${confirmed.length} confirmadas · ${byStatus('failed').length} falhas · ${byStatus('expired').length} expiradas · ${byStatus('cancelled').length} canceladas · ${byStatus('rolled_back').length} rollbacks`,
        },
        shadow: {
          status: proposed.some((decision) => decision.approval_status === 'shadow_only') ? 'degraded' : 'healthy',
          detail: `${proposed.filter((decision) => decision.approval_status === 'shadow_only').length} propostas IA em shadow · nenhuma é executada automaticamente`,
        },
        lock: {
          status: activeLocks.length > 1 ? 'unavailable' : 'healthy',
          detail: activeLocks.length ? `${activeLocks.length} lock ativo até ${dateText(activeLocks[0].expires_at)}` : 'Nenhum lock ativo neste momento',
        },
        scheduler: {
          status: !schedulerKnown ? 'degraded' : schedulerErrors.length ? 'unavailable' : 'healthy',
          detail: !schedulerKnown ? 'Sem logs recentes suficientes para confirmar os schedulers' : `dailyReportScheduler: ${dailyReport?.status || 'sem log'} · syncFullDaily: ${fullDaily?.status || 'sem log'}`,
        },
        lastSync: {
          status: hoursAgo == null ? 'not_configured' : hoursAgo < 25 ? 'healthy' : hoursAgo < 48 ? 'degraded' : 'unavailable',
          detail: lastSuccess ? `Último sync bem-sucedido: ${dateText(lastSuccess.completed_at || lastSuccess.started_at)} (${hoursAgo.toFixed(1)}h atrás)` : 'Nenhum sync bem-sucedido encontrado',
        },
      });
    } catch (error) {
      setChecks({ fatal: { status: 'unavailable', detail: error?.response?.data?.error || error.message } });
    } finally {
      setLoading(false);
      setLastChecked(new Date());
    }
  }

  useEffect(() => { diagnose(); }, []);

  const values = Object.values(checks);
  const overall = values.some((item) => item.status === 'unavailable') ? 'unavailable' : values.some((item) => item.status === 'degraded') ? 'degraded' : values.length ? 'healthy' : 'checking';
  const [overallText, overallCls, OverallIcon] = CFG[overall];

  return <div className="space-y-5 p-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-xl border border-cyan/20 bg-cyan/15"><Activity className="h-5 w-5 text-cyan" /></div><div><h1 className="text-lg font-bold text-white">Saúde do Sistema</h1><p className="text-xs text-slate-400">{lastChecked ? `Verificado: ${lastChecked.toLocaleTimeString('pt-BR')}` : 'Verificando...'}</p></div></div>
      <div className="flex items-center gap-3"><span className={`flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold ${overallCls}`}><OverallIcon className="h-4 w-4" />Sistema: {overallText}</span><button onClick={diagnose} disabled={loading} className="flex items-center gap-2 rounded-lg bg-cyan px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}{loading ? 'Verificando...' : 'Executar diagnóstico'}</button></div>
    </div>

    {checks.fatal && <Section title="Falha no diagnóstico" icon={AlertCircle}><Row label="Erro geral" {...checks.fatal} /></Section>}

    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Section title="Conta e integração Amazon" icon={Globe}><Row label="Conta Amazon" {...checks.account} icon={Shield} /><Row label="Amazon Ads OAuth" {...checks.adsAuth} icon={Shield} /><Row label="SP-API Catálogo/Inventário" {...checks.spApi} icon={Shield} /></Section>
      <Section title="Banco de Dados" icon={Database}><Row label="Entidades principais" {...checks.database} icon={Database} /><Row label="Erros de Sync recentes" {...checks.syncErrors} icon={AlertCircle} /><Row label="Decisões pendentes" {...checks.pendingDecisions} icon={Zap} /></Section>
      <Section title="Schedulers e sincronização" icon={Clock}><Row label="Schedulers" {...checks.scheduler} icon={Clock} /><Row label="Último sync bem-sucedido" {...checks.lastSync} icon={RefreshCw} /></Section>
      <Section title="Motor IA" icon={Activity}><Row label="Fila de execução automática" status={checks.pendingDecisions?.status || 'checking'} detail={checks.pendingDecisions?.detail || 'Verificando fila'} icon={Zap} /><Row label="Confirmação e resultados" {...checks.confirmations} icon={CheckCircle} /><Row label="Funções em shadow" {...checks.shadow} icon={Activity} /><Row label="Guardrail de lock" {...checks.lock} icon={Shield} /></Section>
    </div>
  </div>;
}
