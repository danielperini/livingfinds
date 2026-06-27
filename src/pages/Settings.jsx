import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { xanoAuth, setXanoToken, clearXanoToken, isXanoAuthenticated } from '@/lib/xanoClient';
import { Settings as SettingsIcon, Wifi, WifiOff, CheckCircle, AlertTriangle, Loader2, Save, LogOut, LogIn } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import XanoLogin from '@/pages/XanoLogin';

export default function Settings() {
  const [user, setUser] = useState(null);
  const [account, setAccount] = useState(null);
  const [health, setHealth] = useState(null);
  const [xanoConnected, setXanoConnected] = useState(isXanoAuthenticated());
  const [showXanoLogin, setShowXanoLogin] = useState(false);
  const [healthLoading, setHealthLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
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

  const testHealth = async () => {
    setHealthLoading(true);
    try {
      const res = await base44.functions.invoke('testAuthHealth', {});
      setHealth(res.data);
      if (res.data?.mode) {
        localStorage.setItem('lf_operation_mode', res.data.mode);
        window.dispatchEvent(new Event('lf_mode_change'));
      }
    } catch (err) {
      setHealth({ ok: false, message: err.message });
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

      {/* Operation Mode Panel */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-6">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold text-white">Modo de Operação</h2>
            <p className="text-xs text-slate-400 mt-0.5">Controla se a app usa dados reais da Amazon ou simulados.</p>
          </div>
          {health?.mode && (
            <span className={`text-xs font-bold px-3 py-1 rounded-full border ${
              health.mode === 'real' ? 'bg-emerald-400/10 text-emerald-400 border-emerald-400/20' :
              health.mode === 'hybrid' ? 'bg-cyan/10 text-cyan border-cyan/20' :
              'bg-amber-400/10 text-amber-400 border-amber-400/20'
            }`}>{health.mode.toUpperCase()}</span>
          )}
        </div>
        <div className="grid grid-cols-3 gap-2 mt-3">
          {[
            { key: 'mock', label: 'MOCK', desc: 'Sem chamadas reais. Dados simulados.', color: 'text-amber-400 border-amber-400/20 bg-amber-400/5' },
            { key: 'hybrid', label: 'HYBRID', desc: 'Lê dados reais, escreve em mock.', color: 'text-cyan border-cyan/20 bg-cyan/5' },
            { key: 'real', label: 'REAL', desc: 'Todas as operações na Amazon API.', color: 'text-emerald-400 border-emerald-400/20 bg-emerald-400/5' },
          ].map(m => (
            <div key={m.key} className={`p-3 rounded-lg border ${health?.mode === m.key ? m.color : 'border-surface-3 bg-surface-2'}`}>
              <p className={`text-xs font-bold ${health?.mode === m.key ? '' : 'text-slate-400'}`}>{m.label}</p>
              <p className="text-xs text-slate-500 mt-0.5">{m.desc}</p>
              {health?.mode === m.key && <span className="text-xs font-semibold text-emerald-400">● Ativo</span>}
            </div>
          ))}
        </div>
        <p className="text-xs text-slate-500 mt-3">
          Para alterar: <strong className="text-slate-300">Dashboard → Settings → Environment Variables</strong> → <code className="text-cyan/70 bg-surface-2 px-1 rounded">OPERATION_MODE</code> = <code className="text-cyan/70 bg-surface-2 px-1 rounded">mock</code> | <code className="text-cyan/70 bg-surface-2 px-1 rounded">hybrid</code> | <code className="text-cyan/70 bg-surface-2 px-1 rounded">real</code>
        </p>
      </div>

      {/* Auth Health Check */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-white">Estado da Autenticação Amazon</h2>
          <button
            onClick={testHealth}
            disabled={healthLoading}
            className="flex items-center gap-2 px-3 py-2 bg-surface-2 border border-surface-3 text-sm text-slate-300 hover:text-white rounded-lg transition-colors"
          >
            {healthLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wifi className="w-4 h-4" />}
            Testar Conexão
          </button>
        </div>

        {health ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400 w-24">Modo:</span>
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                health.mode === 'real' ? 'bg-emerald-400/10 text-emerald-400' :
                health.mode === 'hybrid' ? 'bg-cyan/10 text-cyan' :
                'bg-amber-400/10 text-amber-400'
              }`}>{health.mode?.toUpperCase()}</span>
            </div>
            {health.services && Object.entries(health.services).map(([service, status]) => (
              <div key={service} className="flex items-center gap-3 p-3 bg-surface-2 rounded-lg">
                {status.ok ? <Wifi className="w-4 h-4 text-emerald-400" /> : <WifiOff className="w-4 h-4 text-red-400" />}
                <div className="flex-1">
                  <p className="text-xs font-semibold text-slate-300">{service.toUpperCase()} API</p>
                  <p className="text-xs text-slate-500">
                    {status.ok ? `Estado: ${status.status} • Expira em: ${status.expires_in}s` : `Erro: ${status.message || status.error_code}`}
                  </p>
                </div>
                <StatusBadge status={status.ok ? 'connected' : 'error'} size="xs" />
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-slate-500">Clica em "Testar Conexão" para verificar o estado das credenciais Amazon.</p>
        )}
      </div>

      {/* Account Settings */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-6">
        <h2 className="text-sm font-semibold text-white mb-5">Configurações da Conta</h2>
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
              <p className="text-xs text-slate-600 mt-1">Nenhuma campanha pode ter orçamento superior a este valor.</p>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Alteração Máxima de Bid (%)</label>
              <input
                type="number"
                value={form.max_bid_change_pct}
                onChange={e => setForm(p => ({ ...p, max_bid_change_pct: parseFloat(e.target.value) || 0 }))}
                className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50"
              />
              <p className="text-xs text-slate-600 mt-1">Proteção: nenhum ajuste de bid pode exceder esta percentagem.</p>
            </div>
          </div>

          {/* Auto-optimization toggle */}
          <div className="flex items-start justify-between p-4 bg-surface-2 rounded-lg border border-surface-3">
            <div>
              <p className="text-sm font-medium text-white">Otimização Automática AI</p>
              <p className="text-xs text-slate-500 mt-0.5">
                Quando ativo, o Learner executa decisões automaticamente (dentro dos limites de segurança). Por defeito requer aprovação manual.
              </p>
              {form.ai_auto_optimization && (
                <div className="flex items-center gap-1.5 mt-2 text-xs text-amber-400">
                  <AlertTriangle className="w-3 h-3" />
                  Modo automático ativo — as decisões serão executadas sem revisão.
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

        <div className="flex items-center gap-3 mt-6">
          <button
            onClick={saveAccount}
            disabled={saving}
            className="flex items-center gap-2 px-5 py-2.5 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> :
             saved ? <CheckCircle className="w-4 h-4" /> :
             <Save className="w-4 h-4" />}
            {saving ? 'Guardando...' : saved ? 'Guardado!' : 'Guardar Configurações'}
          </button>
        </div>
      </div>

      {/* Xano Backend Connection */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-sm font-semibold text-white">Backend Xano</h2>
            <p className="text-xs text-slate-400 mt-0.5">Liga o backend Living Finds para dados reais de campanhas, métricas e agente AI.</p>
          </div>
          {xanoConnected ? (
            <button
              onClick={() => { clearXanoToken(); setXanoConnected(false); }}
              className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 text-xs font-semibold rounded-lg transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" /> Desligar
            </button>
          ) : (
            <button
              onClick={() => setShowXanoLogin(true)}
              className="flex items-center gap-2 px-3 py-2 bg-cyan/10 border border-cyan/20 text-cyan hover:bg-cyan/20 text-xs font-semibold rounded-lg transition-colors"
            >
              <LogIn className="w-3.5 h-3.5" /> Ligar Xano
            </button>
          )}
        </div>
        <div className={`flex items-center gap-2 text-xs ${xanoConnected ? 'text-emerald-400' : 'text-slate-500'}`}>
          {xanoConnected ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
          {xanoConnected ? 'Conectado — dados reais activos' : 'Desconectado — app usa dados locais'}
        </div>
        {showXanoLogin && !xanoConnected && (
          <div className="mt-4 border-t border-surface-2 pt-4">
            <XanoLogin onSuccess={() => { setXanoConnected(true); setShowXanoLogin(false); }} />
          </div>
        )}
      </div>

      {/* Credentials info */}
      <div className="bg-surface-1 border border-amber-500/20 rounded-xl p-6">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle className="w-4 h-4 text-amber-400" />
          <h2 className="text-sm font-semibold text-amber-300">Credenciais Amazon</h2>
        </div>
        <p className="text-xs text-slate-400 leading-relaxed">
          As credenciais Amazon (Client IDs, Client Secrets, Refresh Tokens) são geridas exclusivamente como secrets seguros no servidor — nunca são expostas no frontend ou em logs.
          Para configurar ou atualizar: vai a <strong className="text-slate-300">Dashboard → Settings → Environment Variables</strong> e define:
        </p>
        <div className="mt-3 grid grid-cols-2 gap-1">
          {['ADS_CLIENT_ID', 'ADS_CLIENT_SECRET', 'ADS_REFRESH_TOKEN', 'ADS_PROFILE_ID', 'ADS_REGION', 'ADS_MARKETPLACE_ID',
            'SP_CLIENT_ID', 'SP_CLIENT_SECRET', 'SP_REFRESH_TOKEN', 'SP_ROLE_ARN', 'SP_REGION', 'SP_MARKETPLACE_ID',
            'OPERATION_MODE', 'XANO_BASE_URL', 'XANO_RETOOL_API_KEY'].map(s => (
            <code key={s} className="text-xs font-mono text-cyan/70 bg-surface-2 px-2 py-0.5 rounded">{s}</code>
          ))}
        </div>
      </div>
    </div>
  );
}