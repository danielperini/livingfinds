import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { xanoRequest } from '@/lib/useXano';
import { Settings as SettingsIcon, Wifi, WifiOff, CheckCircle, AlertTriangle, Loader2, Save, ExternalLink, Cloud } from 'lucide-react';
import SyncPanel from '@/components/SyncPanel';

export default function Settings() {
  const [user, setUser] = useState(null);
  const [account, setAccount] = useState(null);
  const [xanoHealth, setXanoHealth] = useState(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [lastAttempt, setLastAttempt] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [form, setForm] = useState({
    seller_name: '',
    ai_auto_optimization: false,
    max_daily_budget_limit: 1000,
    max_bid_change_pct: 20,
  });

  useEffect(() => {
    base44.auth.me().then(me => {
      setUser(me);
      return base44.entities.AmazonAccount.filter({ user_id: me.id });
    }).then(accounts => {
      if (accounts.length > 0) {
        const acc = accounts[0];
        setAccount(acc);
        setForm({
          seller_name: acc.seller_name || '',
          ai_auto_optimization: acc.ai_auto_optimization || false,
          max_daily_budget_limit: acc.max_daily_budget_limit || 1000,
          max_bid_change_pct: acc.max_bid_change_pct || 20,
        });
      }
    }).catch(console.error);
  }, []);

  const testXanoHealth = async () => {
    setHealthLoading(true);
    setLastAttempt(new Date().toLocaleString('pt-BR'));
    try {
      const data = await xanoRequest('GET', '/health');
      setXanoHealth({ ok: true, data });
    } catch (err) {
      setXanoHealth({ ok: false, error: err.message });
    } finally {
      setHealthLoading(false);
    }
  };

  const saveAccount = async () => {
    if (!user) return;
    setSaving(true);
    try {
      if (account) {
        await base44.entities.AmazonAccount.update(account.id, { ...form });
      } else {
        await base44.entities.AmazonAccount.create({ user_id: user.id, ...form, status: 'pending' });
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      alert(`Erro: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-3xl animate-fade-in">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
          <SettingsIcon className="w-5 h-5 text-cyan" />
        </div>
        <h1 className="text-lg font-bold text-white">Configurações</h1>
      </div>

      {/* Status Xano */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-sm font-semibold text-white">Status Xano</h2>
            <p className="text-xs text-slate-400 mt-0.5">Conexão Base44 → Xano via X-API-Key</p>
          </div>
          <button
            onClick={testXanoHealth}
            disabled={healthLoading}
            className="flex items-center gap-2 px-3 py-2 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60"
          >
            {healthLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wifi className="w-4 h-4" />}
            Testar Conexão
          </button>
        </div>

        {/* Status indicator */}
        <div className={`flex items-center gap-2 p-3 rounded-lg border mb-4 ${
          xanoHealth === null ? 'border-surface-3 bg-surface-2' :
          xanoHealth.ok ? 'border-emerald-400/20 bg-emerald-400/5' :
          'border-red-400/20 bg-red-400/5'
        }`}>
          {xanoHealth === null
            ? <WifiOff className="w-4 h-4 text-slate-500" />
            : xanoHealth.ok
            ? <Wifi className="w-4 h-4 text-emerald-400" />
            : <WifiOff className="w-4 h-4 text-red-400" />}
          <div className="flex-1">
            <p className={`text-sm font-semibold ${xanoHealth === null ? 'text-slate-400' : xanoHealth.ok ? 'text-emerald-400' : 'text-red-400'}`}>
              {xanoHealth === null ? 'Não testado' : xanoHealth.ok ? 'Conectado' : 'Desconectado'}
            </p>
            {lastAttempt && <p className="text-xs text-slate-500">Última tentativa: {lastAttempt}</p>}
          </div>
        </div>

        {xanoHealth?.ok && xanoHealth.data && (
          <div className="bg-surface-2 rounded-lg p-3 mb-4">
            <p className="text-xs font-semibold text-slate-300 mb-1">Resposta GET /health</p>
            <pre className="text-xs text-emerald-300 whitespace-pre-wrap">{JSON.stringify(xanoHealth.data, null, 2)}</pre>
          </div>
        )}

        {xanoHealth?.ok === false && (
          <div className="bg-red-400/5 border border-red-400/20 rounded-lg p-3 mb-4">
            <p className="text-xs text-red-400">{xanoHealth.error}</p>
          </div>
        )}

        {/* Config info */}
        <div className="space-y-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-slate-500 w-28">XANO_BASE_URL:</span>
            <code className="text-cyan/70 bg-surface-2 px-2 py-0.5 rounded text-xs">configurada como secret no Base44</code>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-slate-500 w-28">XANO_API_KEY:</span>
            <code className="text-cyan/70 bg-surface-2 px-2 py-0.5 rounded text-xs">configurada como secret no Base44</code>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-slate-500 w-28">Auth header:</span>
            <code className="text-slate-400 bg-surface-2 px-2 py-0.5 rounded text-xs">X-API-Key: ••••••••</code>
          </div>
        </div>

        <a
          href="https://app.base44.com"
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-flex items-center gap-1.5 text-xs text-cyan hover:underline"
        >
          <ExternalLink className="w-3 h-3" /> Gerir secrets em Dashboard → Settings → Environment Variables
        </a>
      </div>

      {/* Account Settings */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-6">
        <h2 className="text-sm font-semibold text-white mb-5">Configurações da Conta Amazon</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">Nome do Seller</label>
            <input
              value={form.seller_name}
              onChange={e => setForm(p => ({ ...p, seller_name: e.target.value }))}
              placeholder="Ex: My Store LLC"
              className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white placeholder-slate-600 focus:outline-none focus:border-cyan/50"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Orçamento Máximo Diário ($)</label>
              <input
                type="number"
                value={form.max_daily_budget_limit}
                onChange={e => setForm(p => ({ ...p, max_daily_budget_limit: parseFloat(e.target.value) || 0 }))}
                className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Alteração Máxima de Bid (%)</label>
              <input
                type="number"
                value={form.max_bid_change_pct}
                onChange={e => setForm(p => ({ ...p, max_bid_change_pct: parseFloat(e.target.value) || 0 }))}
                className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50"
              />
            </div>
          </div>

          <div className="flex items-start justify-between p-4 bg-surface-2 rounded-lg border border-surface-3">
            <div>
              <p className="text-sm font-medium text-white">Otimização Automática AI</p>
              <p className="text-xs text-slate-500 mt-0.5">Quando ativo, o Learner executa decisões automaticamente. Requer aprovação manual por defeito.</p>
              {form.ai_auto_optimization && (
                <div className="flex items-center gap-1.5 mt-2 text-xs text-amber-400">
                  <AlertTriangle className="w-3 h-3" />
                  Modo automático ativo — decisões sem revisão.
                </div>
              )}
            </div>
            <button
              onClick={() => setForm(p => ({ ...p, ai_auto_optimization: !p.ai_auto_optimization }))}
              className={`relative w-11 h-6 rounded-full transition-colors duration-200 flex-shrink-0 ml-4 ${form.ai_auto_optimization ? 'bg-cyan' : 'bg-surface-3'}`}
            >
              <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-all duration-200 ${form.ai_auto_optimization ? 'left-6' : 'left-1'}`} />
            </button>
          </div>
        </div>

        <button
          onClick={saveAccount}
          disabled={saving}
          className="mt-6 flex items-center gap-2 px-5 py-2.5 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <CheckCircle className="w-4 h-4" /> : <Save className="w-4 h-4" />}
          {saving ? 'Guardando...' : saved ? 'Guardado!' : 'Guardar Configurações'}
        </button>
      </div>

      {/* Importação do Xano */}
      {account && (
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <Cloud className="w-4 h-4 text-emerald-400" /> Importar dados do Xano
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">Carrega o resumo real de campanhas, produtos e métricas financeiras do Xano para a Base44</p>
            </div>
            <button
              onClick={async () => {
                if (!account) return;
                setImporting(true);
                setImportResult(null);
                try {
                  // Passo 1: sync_all (pede relatórios)
                  await base44.functions.invoke('importFromXano', { amazon_account_id: account.id, action: 'sync' });
                  // Passo 2: aguarda 60s e baixa relatórios + dashboard
                  await new Promise(r => setTimeout(r, 60000));
                  const res = await base44.functions.invoke('importFromXano', { amazon_account_id: account.id, action: 'download' });
                  const d = res.data;
                  setImportResult({ ok: d?.ok, message: d?.error, campaigns: d?.campaigns_upserted, metrics: d?.metrics_upserted, dash: d?.dashboard });
                } catch (e) {
                  setImportResult({ ok: false, message: e.message });
                } finally {
                  setImporting(false);
                }
              }}
              disabled={importing || !account}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60"
            >
              {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Cloud className="w-4 h-4" />}
              {importing ? 'A importar...' : 'Importar do Xano'}
            </button>
          </div>
          {importResult && (
            <div className={`p-3 rounded-lg border text-xs ${importResult.ok
              ? 'border-emerald-400/20 bg-emerald-400/5 text-emerald-300'
              : 'border-red-400/20 bg-red-400/5 text-red-400'}`}>
              {importResult.ok ? `✓ Importado: ${importResult.campaigns || 0} campanhas, ${importResult.products || 0} produtos` : `✕ ${importResult.message}`}
            </div>
          )}
        </div>
      )}

      {/* Sync Panel */}
      {account && (
        <SyncPanel amazonAccountId={account.id} onDone={() => {}} />
      )}

      {/* Arquitetura info */}
      <div className="bg-surface-1 border border-amber-500/20 rounded-xl p-6">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle className="w-4 h-4 text-amber-400" />
          <h2 className="text-sm font-semibold text-amber-300">Arquitetura de Integração</h2>
        </div>
        <p className="text-xs text-slate-400 leading-relaxed mb-3">
          <strong className="text-slate-300">Amazon APIs → Xano → Base44 → Usuário</strong><br />
          O Base44 nunca se conecta diretamente à Amazon. Todas as chamadas passam pelo Xano via <code className="text-cyan/70 bg-surface-2 px-1 rounded">X-API-Key</code>.
        </p>
        <p className="text-xs text-slate-500">Secrets necessários no Base44:</p>
        <div className="mt-2 flex gap-2 flex-wrap">
          {['XANO_BASE_URL', 'XANO_API_KEY'].map(s => (
            <code key={s} className="text-xs font-mono text-cyan/70 bg-surface-2 px-2 py-0.5 rounded">{s}</code>
          ))}
        </div>
      </div>
    </div>
  );
}