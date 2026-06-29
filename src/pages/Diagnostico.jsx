import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { CheckCircle, XCircle, AlertCircle, Loader2, RefreshCw, Zap, List, Users, Radio, FileText, Eye, Download } from 'lucide-react';

function StatusDot({ status }) {
  if (status === 'ok' || status === 'connected') return <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 inline-block" />;
  if (status === 'error') return <span className="w-2.5 h-2.5 rounded-full bg-red-400 inline-block" />;
  return <span className="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block" />;
}

function ResultBox({ title, result, loading }) {
  if (!result && !loading) return null;
  return (
    <div className="mt-3 bg-[#0A0B0F] border border-surface-2 rounded-lg p-3">
      <p className="text-xs font-semibold text-slate-400 mb-2">{title}</p>
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-cyan"><Loader2 className="w-3 h-3 animate-spin" />Aguardando...</div>
      ) : (
        <pre className="text-xs text-slate-300 whitespace-pre-wrap break-all max-h-64 overflow-y-auto scrollbar-thin">
          {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ActionButton({ icon: Icon, label, onClick, loading, variant = 'default' }) {
  const colors = {
    default: 'bg-surface-2 border-surface-3 text-slate-300 hover:border-cyan/40 hover:text-cyan',
    success: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400',
    danger: 'bg-red-500/10 border-red-500/30 text-red-400',
    primary: 'bg-cyan/10 border-cyan/30 text-cyan hover:bg-cyan/20',
  };
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed ${colors[variant]}`}
    >
      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Icon className="w-4 h-4" />}
      {label}
    </button>
  );
}

export default function Diagnostico() {
  const [account, setAccount] = useState(null);
  const [stats, setStats] = useState({ campaigns: 0, products: 0, keywords: 0 });
  const [syncRuns, setSyncRuns] = useState([]);
  const [loading, setLoading] = useState(true);

  const [results, setResults] = useState({});
  const [loadingBtn, setLoadingBtn] = useState({});

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      let accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      if (!accounts.length) accounts = await base44.entities.AmazonAccount.list();
      const acc = accounts[0] || null;
      setAccount(acc);

      if (acc) {
        const [campsAll, prodsAll, kwdsAll, runs] = await Promise.all([
          base44.entities.Campaign.filter({ amazon_account_id: acc.id }, '-created_date', 5000),
          base44.entities.Product.filter({ amazon_account_id: acc.id }, '-created_date', 5000),
          base44.entities.Keyword.filter({ amazon_account_id: acc.id }, '-created_date', 5000),
          base44.entities.SyncRun.filter({ amazon_account_id: acc.id }, '-started_at', 5),
        ]);
        setStats({ campaigns: campsAll.length, products: prodsAll.length, keywords: kwdsAll.length });
        setSyncRuns(runs);
      }
    } catch (e) {
      console.error('loadData error:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const run = async (key, fn) => {
    setLoadingBtn(p => ({ ...p, [key]: true }));
    setResults(p => ({ ...p, [key]: null }));
    try {
      const res = await fn();
      setResults(p => ({ ...p, [key]: res }));
    } catch (e) {
      setResults(p => ({ ...p, [key]: { error: e.message } }));
    } finally {
      setLoadingBtn(p => ({ ...p, [key]: false }));
      await loadData();
    }
  };

  const testToken = () => run('token', async () => {
    const r = await base44.functions.invoke('testAuthHealth', {});
    return r.data;
  });

  const listProfiles = () => run('profiles', async () => {
    const r = await base44.functions.invoke('amazonAdsProxy', { action: 'getProfiles', payload: {} });
    return r.data;
  });

  const listAccounts = () => run('accounts', async () => {
    const r = await base44.functions.invoke('listAdsProfiles', {});
    return r.data;
  });

  const syncCampaigns = () => run('sync', async () => {
    if (!account) throw new Error('Nenhuma conta Amazon encontrada');
    const r = await base44.functions.invoke('syncAdsQuick', { amazon_account_id: account.id, action: 'request' });
    return r.data;
  });

  const requestReports = () => run('reportRequest', async () => {
    if (!account) throw new Error('Nenhuma conta Amazon encontrada');
    const r = await base44.functions.invoke('requestAdsReport', { amazon_account_id: account.id });
    return r.data;
  });

  const checkReports = () => run('reportCheck', async () => {
    if (!account) throw new Error('Nenhuma conta Amazon encontrada');
    const r = await base44.functions.invoke('downloadAdsReport', { amazon_account_id: account.id });
    return r.data;
  });

  const downloadReports = () => run('reportDownload', async () => {
    if (!account) throw new Error('Nenhuma conta Amazon encontrada');
    const reportRun = syncRuns.find(r => r.operation?.startsWith('adsReports:'));
    let reportIds = null;
    if (reportRun) {
      const match = reportRun.operation.match(/adsReports:[^:]+:(.+)/);
      if (match) reportIds = JSON.parse(match[1]);
    }
    const r = await base44.functions.invoke('downloadAdsReport', {
      amazon_account_id: account.id,
      report_ids: reportIds,
      sync_run_id: reportRun?.id,
    });
    return r.data;
  });

  const lastSync = account?.last_sync_at ? new Date(account.last_sync_at).toLocaleString('pt-BR') : 'Nunca';
  const lastError = account?.error_message || syncRuns.find(r => r.status === 'error')?.error_message || null;
  const lastReportRun = syncRuns.find(r => r.operation?.startsWith('adsReports:'));
  const lastReportDate = lastReportRun?.started_at ? new Date(lastReportRun.started_at).toLocaleString('pt-BR') : 'Nunca';

  const connStatus = account?.status || 'unknown';

  return (
    <div className="p-6 space-y-6 animate-fade-in max-w-5xl mx-auto">
      <div>
        <h1 className="text-xl font-bold text-white">Diagnóstico Amazon</h1>
        <p className="text-sm text-slate-400 mt-1">Ferramentas de diagnóstico e sincronização manual</p>
      </div>

      {/* Status da Conexão */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-slate-300 mb-4">Status da Conexão</h2>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="w-4 h-4 animate-spin" />Carregando...</div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            <div className="bg-surface-2 rounded-lg p-3">
              <div className="flex items-center gap-2 mb-1">
                <StatusDot status={connStatus} />
                <span className="text-xs text-slate-400">Conexão</span>
              </div>
              <p className="text-sm font-semibold text-white capitalize">{connStatus}</p>
            </div>
            <div className="bg-surface-2 rounded-lg p-3">
              <p className="text-xs text-slate-400 mb-1">Último Sync</p>
              <p className="text-sm font-semibold text-white">{lastSync}</p>
            </div>
            <div className="bg-surface-2 rounded-lg p-3">
              <p className="text-xs text-slate-400 mb-1">Último Report</p>
              <p className="text-sm font-semibold text-white">{lastReportDate}</p>
            </div>
            <div className="bg-surface-2 rounded-lg p-3">
              <p className="text-xs text-slate-400 mb-1">Campanhas</p>
              <p className="text-2xl font-bold text-cyan">{stats.campaigns}</p>
            </div>
            <div className="bg-surface-2 rounded-lg p-3">
              <p className="text-xs text-slate-400 mb-1">Produtos</p>
              <p className="text-2xl font-bold text-cyan">{stats.products}</p>
            </div>
            <div className="bg-surface-2 rounded-lg p-3">
              <p className="text-xs text-slate-400 mb-1">Keywords</p>
              <p className="text-2xl font-bold text-cyan">{stats.keywords}</p>
            </div>
            {lastError && (
              <div className="col-span-2 bg-red-500/10 border border-red-500/20 rounded-lg p-3">
                <p className="text-xs text-red-400 font-semibold mb-1">Último Erro Amazon</p>
                <p className="text-xs text-red-300 break-all">{lastError}</p>
              </div>
            )}
            {account && (
              <div className="bg-surface-2 rounded-lg p-3">
                <p className="text-xs text-slate-400 mb-1">Profile ID</p>
                <p className="text-xs font-mono text-slate-300 break-all">{account.ads_profile_id || 'N/D'}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Botões de Ação */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-slate-300">Ações de Diagnóstico</h2>
          <button onClick={loadData} className="text-xs text-slate-500 hover:text-slate-300 flex items-center gap-1">
            <RefreshCw className="w-3 h-3" /> Atualizar
          </button>
        </div>

        <div className="flex flex-wrap gap-3">
          <ActionButton icon={CheckCircle} label="Testar Token" onClick={testToken} loading={loadingBtn.token} variant="primary" />
          <ActionButton icon={List} label="Listar Profiles" onClick={listProfiles} loading={loadingBtn.profiles} />
          <ActionButton icon={Users} label="Listar Advertiser Accounts" onClick={listAccounts} loading={loadingBtn.accounts} />
          <ActionButton icon={Radio} label="Sincronizar Campanhas" onClick={syncCampaigns} loading={loadingBtn.sync} />
          <ActionButton icon={FileText} label="Solicitar Reports" onClick={requestReports} loading={loadingBtn.reportRequest} />
          <ActionButton icon={Eye} label="Verificar Reports" onClick={checkReports} loading={loadingBtn.reportCheck} />
          <ActionButton icon={Download} label="Baixar Reports" onClick={downloadReports} loading={loadingBtn.reportDownload} variant="primary" />
        </div>

        {/* Resultados */}
        <ResultBox title="Resultado: Testar Token" result={results.token} loading={loadingBtn.token} />
        <ResultBox title="Resultado: Listar Profiles" result={results.profiles} loading={loadingBtn.profiles} />
        <ResultBox title="Resultado: Listar Advertiser Accounts" result={results.accounts} loading={loadingBtn.accounts} />
        <ResultBox title="Resultado: Sincronizar Campanhas" result={results.sync} loading={loadingBtn.sync} />
        <ResultBox title="Resultado: Solicitar Reports" result={results.reportRequest} loading={loadingBtn.reportRequest} />
        <ResultBox title="Resultado: Verificar Reports" result={results.reportCheck} loading={loadingBtn.reportCheck} />
        <ResultBox title="Resultado: Baixar Reports" result={results.reportDownload} loading={loadingBtn.reportDownload} />
      </div>

      {/* Últimos SyncRuns */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-surface-2">
          <h2 className="text-sm font-semibold text-slate-300">Histórico de Syncs Recentes</h2>
        </div>
        {syncRuns.length === 0 ? (
          <p className="text-sm text-slate-500 text-center py-6">Nenhum sync encontrado</p>
        ) : (
          <div className="divide-y divide-surface-2">
            {syncRuns.map((run, i) => (
              <div key={run.id || i} className="px-5 py-3 flex items-start gap-3">
                <StatusDot status={run.status === 'success' ? 'ok' : run.status === 'running' ? 'pending' : 'error'} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-slate-300 truncate">{run.operation}</p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {run.records_upserted ? `${run.records_upserted} registos` : ''}
                    {run.duration_ms ? ` · ${(run.duration_ms / 1000).toFixed(1)}s` : ''}
                    {run.error_message ? ` · ⚠ ${run.error_message}` : ''}
                  </p>
                </div>
                <span className="text-xs text-slate-600 flex-shrink-0">
                  {run.started_at ? new Date(run.started_at).toLocaleString('pt-BR') : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}