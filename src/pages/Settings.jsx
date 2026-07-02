import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Settings as SettingsIcon, CheckCircle, AlertTriangle, Loader2, Save, Zap, RefreshCw, ShieldAlert, ShieldCheck, WifiOff, ExternalLink, DollarSign, Package, BarChart2, Key } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';

export default function Settings() {
  const [user, setUser] = useState(null);
  const [account, setAccount] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [authStatus, setAuthStatus] = useState(null);
  const [authChecking, setAuthChecking] = useState(false);
  const [secretsPreview, setSecretsPreview] = useState(null);
  const [secretsLoading, setSecretsLoading] = useState(false);
  const [bulkBidLoading, setBulkBidLoading] = useState(false);
  const [bulkBidResult, setBulkBidResult] = useState(null);
  const [bulkBidConfirm, setBulkBidConfirm] = useState(false);
  const [form, setForm] = useState({
    seller_name: '',
    marketplace_id: '',
    ads_profile_id: '',
    region: 'NA',
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
          marketplace_id: acc.marketplace_id || '',
          ads_profile_id: acc.ads_profile_id || '',
          region: acc.region || 'NA',
          ai_auto_optimization: acc.ai_auto_optimization || false,
          max_daily_budget_limit: acc.max_daily_budget_limit || 1000,
          max_bid_change_pct: acc.max_bid_change_pct || 20,
        });
      }
    }).catch(console.error);
  }, []);

  const saveAccount = async () => {
    if (!user) return;
    setSaving(true);
    try {
      if (account) {
        await base44.entities.AmazonAccount.update(account.id, form);
      } else {
        const created = await base44.entities.AmazonAccount.create({ user_id: user.id, ...form, status: 'pending', mode: 'real' });
        setAccount(created);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      alert(`Erro: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const loadSecretsPreview = async () => {
    setSecretsLoading(true);
    try {
      const res = await base44.functions.invoke('getAdsSecretsPreview', {});
      setSecretsPreview(res?.data || null);
    } catch (e) {
      setSecretsPreview({ ok: false, error: e.message });
    } finally {
      setSecretsLoading(false);
    }
  };

  const checkAuth = async () => {
    setAuthChecking(true);
    setAuthStatus(null);
    try {
      const res = await base44.functions.invoke('testAuthHealth', {});
      setAuthStatus(res?.data || null);
    } catch (e) {
      setAuthStatus({ ok: false, error: e.message });
    } finally {
      setAuthChecking(false);
    }
  };

  const runBulkBid = async () => {
    if (!account) return;
    setBulkBidLoading(true);
    setBulkBidResult(null);
    setBulkBidConfirm(false);
    try {
      const res = await base44.functions.invoke('bulkSetAllBids', { amazon_account_id: account.id, bid: 0.60 });
      const d = res.data;
      if (d?.ok) {
        setBulkBidResult({ ok: true, message: `✓ ${d.keywords?.ok || 0} keywords + ${d.ad_groups?.ok || 0} ad groups atualizados para R$0,60` });
      } else {
        setBulkBidResult({ ok: false, message: d?.error || `Falha: ${d?.keywords?.failed || 0} keywords com erro` });
      }
    } catch (e) {
      setBulkBidResult({ ok: false, message: e.message });
    } finally {
      setBulkBidLoading(false);
    }
  };

  const runSync = async () => {
    if (!account) return;
    setSyncLoading(true);
    setSyncResult(null);
    try {
      const res = await base44.functions.invoke('syncAds', { amazon_account_id: account.id });
      const d = res.data;
      setSyncResult({ ok: d?.ok, message: d?.ok ? `✓ ${d.records_upserted || 0} campanhas sincronizadas` : (d?.error || 'Erro') });
    } catch (e) {
      setSyncResult({ ok: false, message: e.message });
    } finally {
      setSyncLoading(false);
    }
  };

  const fields = [
    { key: 'seller_name', label: 'Nome do Seller', placeholder: 'Ex: My Store LLC' },
    { key: 'marketplace_id', label: 'Marketplace ID', placeholder: 'Ex: ATVPDKIKX0DER' },
    { key: 'ads_profile_id', label: 'Ads Profile ID', placeholder: 'Ex: 1234567890' },
    { key: 'region', label: 'Região', placeholder: 'NA / EU / FE' },
  ];

  return (
    <div className="p-6 space-y-6 max-w-3xl animate-fade-in">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
          <SettingsIcon className="w-5 h-5 text-cyan" />
        </div>
        <h1 className="text-lg font-bold text-white">Configurações</h1>
      </div>

      {/* Status da Conta */}
      {account && (
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-4">
            <StatusBadge status={account.status || 'pending'} />
            <div className="flex-1">
              <p className="text-sm font-semibold text-white">{account.seller_name || 'Conta Amazon'}</p>
              <p className="text-xs text-slate-500">Último sync: {account.last_sync_at ? new Date(account.last_sync_at).toLocaleString('pt-BR') : 'Nunca'}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Seller ID', value: account.seller_id, icon: Package },
              { label: 'Marketplace ID', value: account.marketplace_id, icon: BarChart2 },
              { label: 'Ads Profile ID', value: account.ads_profile_id, icon: Key },
              { label: 'Moeda', value: `${account.currency_code || 'BRL'} (${account.currency_symbol || 'R$'})`, icon: DollarSign },
            ].map(({ label, value, icon: Icon }) => (
              <div key={label} className="bg-surface-2 rounded-lg p-3">
                <div className="flex items-center gap-1.5 mb-1">
                  <Icon className="w-3 h-3 text-slate-500" />
                  <p className="text-[10px] text-slate-500">{label}</p>
                </div>
                <p className="text-xs font-mono text-slate-200 truncate">{value || '—'}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Configurações da Conta */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-6">
        <h2 className="text-sm font-semibold text-white mb-5">Configurações da Conta Amazon</h2>
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {fields.map(f => (
              <div key={f.key}>
                <label className="block text-xs text-slate-400 mb-1.5">{f.label}</label>
                <input
                  value={form[f.key]}
                  onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white placeholder-slate-600 focus:outline-none focus:border-cyan/50"
                />
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Orçamento Máximo Diário ($)</label>
              <input type="number" value={form.max_daily_budget_limit}
                onChange={e => setForm(p => ({ ...p, max_daily_budget_limit: parseFloat(e.target.value) || 0 }))}
                className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Alteração Máxima de Bid (%)</label>
              <input type="number" value={form.max_bid_change_pct}
                onChange={e => setForm(p => ({ ...p, max_bid_change_pct: parseFloat(e.target.value) || 0 }))}
                className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50" />
            </div>
          </div>

          <div className="flex items-start justify-between p-4 bg-surface-2 rounded-lg border border-surface-3">
            <div>
              <p className="text-sm font-medium text-white">Otimização Automática AI</p>
              <p className="text-xs text-slate-500 mt-0.5">Quando ativo, o Learner executa decisões automaticamente sem revisão manual.</p>
              {form.ai_auto_optimization && (
                <div className="flex items-center gap-1.5 mt-2 text-xs text-amber-400">
                  <AlertTriangle className="w-3 h-3" /> Modo automático ativo — decisões sem revisão.
                </div>
              )}
            </div>
            <button onClick={() => setForm(p => ({ ...p, ai_auto_optimization: !p.ai_auto_optimization }))}
              className={`relative w-11 h-6 rounded-full transition-colors duration-200 flex-shrink-0 ml-4 ${form.ai_auto_optimization ? 'bg-cyan' : 'bg-surface-3'}`}>
              <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-all duration-200 ${form.ai_auto_optimization ? 'left-6' : 'left-1'}`} />
            </button>
          </div>
        </div>

        <button onClick={saveAccount} disabled={saving}
          className="mt-6 flex items-center gap-2 px-5 py-2.5 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <CheckCircle className="w-4 h-4" /> : <Save className="w-4 h-4" />}
          {saving ? 'Guardando...' : saved ? 'Guardado!' : 'Guardar Configurações'}
        </button>
      </div>

      {/* Status de Autenticação Amazon */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-white">Diagnóstico de Credenciais Amazon</h2>
          <button onClick={checkAuth} disabled={authChecking}
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold bg-surface-2 border border-surface-3 text-slate-300 hover:text-white rounded-lg transition-colors disabled:opacity-60">
            {authChecking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
            {authChecking ? 'Verificando...' : 'Verificar Credenciais'}
          </button>
        </div>

        {!authStatus && !authChecking && (
          <p className="text-xs text-slate-500">Clique em "Verificar Credenciais" para testar a conexão com a Amazon.</p>
        )}

        {authStatus && (
          <div className="space-y-3">
            {[
              { key: 'ads', label: 'Amazon Ads API (ADS_REFRESH_TOKEN)', hint: 'Regenere o token em sellercentral.amazon.com.br → Apps & Services → Authorize Apps' },
              { key: 'sp', label: 'SP-API (SP_CLIENT_ID / SP_CLIENT_SECRET)', hint: 'Verifique as credenciais no Amazon Developer Console' },
            ].map(({ key, label, hint }) => {
              const svc = authStatus?.services?.[key];
              const ok = svc?.ok;
              return (
                <div key={key} className={`p-3 rounded-lg border ${ok ? 'border-emerald-400/20 bg-emerald-400/5' : 'border-red-400/20 bg-red-400/5'}`}>
                  <div className="flex items-center gap-2 mb-1">
                    {ok
                      ? <ShieldCheck className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                      : <ShieldAlert className="w-4 h-4 text-red-400 flex-shrink-0" />}
                    <span className={`text-xs font-semibold ${ok ? 'text-emerald-300' : 'text-red-300'}`}>{label}</span>
                  </div>
                  {!ok && svc && (
                    <div className="ml-6 space-y-1">
                      <p className="text-xs text-red-400">
                        Erro: <span className="font-mono">{svc.error_code || svc.message || 'desconhecido'}</span>
                      </p>
                      <p className="text-[10px] text-slate-400">{hint}</p>
                    </div>
                  )}
                </div>
              );
            })}

            {!authStatus?.services?.ads?.ok && (
              <div className="flex items-start gap-2 p-3 bg-amber-400/5 border border-amber-400/20 rounded-lg">
                <WifiOff className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                <div className="text-xs text-amber-300 space-y-2 flex-1">
                  <p className="font-semibold">Reconectar Amazon Ads via OAuth</p>
                  <p className="text-amber-200/80">Clique no botão abaixo para autorizar o acesso. Você será redirecionado para a Amazon e depois de volta para a plataforma automaticamente.</p>
                  <a
                    href={`https://www.amazon.com/ap/oa?client_id=amzn1.application-oa2-client.a30fb7e08c524463acb3611c8d7f71e4&scope=advertising::campaign_management&response_type=code&redirect_uri=https://livingfinds-app.base44.app/amazon-ads-callback`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 px-4 py-2 bg-amber-500/20 border border-amber-500/40 text-amber-300 hover:bg-amber-500/30 rounded-lg font-semibold transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    Autorizar Amazon Ads →
                  </a>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Sync Rápido */}
      {account && (
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <Zap className="w-4 h-4 text-cyan" /> Sync Campanhas (Amazon Ads API)
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">Importa campanhas via credenciais ADS_* configuradas</p>
            </div>
            <button onClick={runSync} disabled={syncLoading}
              className="flex items-center gap-2 px-4 py-2 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60">
              {syncLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              {syncLoading ? 'Sincronizando...' : 'Sincronizar'}
            </button>
          </div>
          {syncResult && (
            <div className={`p-3 rounded-lg border text-xs ${syncResult.ok ? 'border-emerald-400/20 bg-emerald-400/5 text-emerald-300' : 'border-red-400/20 bg-red-400/5 text-red-400'}`}>
              {syncResult.message}
            </div>
          )}
        </div>
      )}

      {/* Bulk Bid Reset */}
      {account && (
        <div className="bg-surface-1 border border-amber-500/20 rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <DollarSign className="w-4 h-4 text-amber-400" /> Bulk Reset de Bids — R$0,60
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">Aplica bid de R$0,60 em <strong className="text-white">todas</strong> as keywords e ad groups ativos/pausados via Amazon API.</p>
            </div>
          </div>

          {!bulkBidConfirm && !bulkBidResult && (
            <button onClick={() => setBulkBidConfirm(true)}
              className="flex items-center gap-2 px-4 py-2 bg-amber-500/20 border border-amber-500/40 text-amber-300 hover:bg-amber-500/30 text-sm font-semibold rounded-lg transition-colors">
              <DollarSign className="w-4 h-4" /> Definir todos bids para R$0,60
            </button>
          )}

          {bulkBidConfirm && !bulkBidLoading && !bulkBidResult && (
            <div className="p-4 bg-amber-400/5 border border-amber-400/30 rounded-lg space-y-3">
              <p className="text-sm text-amber-300 font-semibold">⚠️ Confirmar alteração em massa?</p>
              <p className="text-xs text-slate-400">Esta ação irá alterar o bid de <strong className="text-white">todas</strong> as keywords e ad groups diretamente na Amazon Ads API. Não pode ser desfeita em massa.</p>
              <div className="flex gap-3">
                <button onClick={runBulkBid}
                  className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-black text-sm font-bold rounded-lg transition-colors">
                  Confirmar — Aplicar R$0,60
                </button>
                <button onClick={() => setBulkBidConfirm(false)}
                  className="px-4 py-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white text-sm rounded-lg transition-colors">
                  Cancelar
                </button>
              </div>
            </div>
          )}

          {bulkBidLoading && (
            <div className="flex items-center gap-3 p-4 bg-surface-2 rounded-lg">
              <Loader2 className="w-4 h-4 animate-spin text-amber-400" />
              <span className="text-sm text-slate-300">Aplicando R$0,60 em todas as keywords via Amazon API... pode demorar alguns segundos.</span>
            </div>
          )}

          {bulkBidResult && (
            <div className={`p-3 rounded-lg border text-xs flex items-center justify-between ${bulkBidResult.ok ? 'border-emerald-400/20 bg-emerald-400/5 text-emerald-300' : 'border-red-400/20 bg-red-400/5 text-red-400'}`}>
              <span>{bulkBidResult.message}</span>
              <button onClick={() => setBulkBidResult(null)} className="ml-4 text-slate-500 hover:text-white text-xs">Fechar</button>
            </div>
          )}
        </div>
      )}

      {/* Secrets Info */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-sm font-semibold text-white">Credenciais Amazon (Environment Variables)</h2>
            <p className="text-xs text-slate-400 mt-0.5">Configuradas em Base44 → Settings → Environment Variables.</p>
          </div>
          <button onClick={loadSecretsPreview} disabled={secretsLoading}
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold bg-surface-2 border border-surface-3 text-slate-300 hover:text-white rounded-lg transition-colors disabled:opacity-60">
            {secretsLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            {secretsLoading ? 'Carregando...' : 'Ver Valores'}
          </button>
        </div>
        <div className="space-y-2">
          {['ADS_CLIENT_ID', 'ADS_CLIENT_SECRET', 'ADS_REFRESH_TOKEN', 'ADS_PROFILE_ID', 'ADS_REGION',
            'AMAZON_SP_REFRESH_TOKEN', 'AMAZON_LWA_CLIENT_ID', 'AMAZON_LWA_CLIENT_SECRET', 'ANTHROPIC_API_KEY'].map(s => {
            const isSet = secretsPreview?.set?.[s];
            const val   = secretsPreview?.values?.[s];
            return (
              <div key={s} className="flex items-center justify-between p-3 bg-surface-2 rounded-lg border border-surface-3">
                <div className="flex items-center gap-2">
                  <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${secretsPreview ? (isSet ? 'bg-emerald-400' : 'bg-red-400') : 'bg-slate-600'}`} />
                  <code className="text-xs font-mono text-slate-300">{s}</code>
                </div>
                <div className="text-right">
                  {!secretsPreview && <span className="text-xs text-slate-600">—</span>}
                  {secretsPreview && !isSet && <span className="text-xs text-red-400 font-semibold">NÃO CONFIGURADO</span>}
                  {secretsPreview && isSet && (
                    <code className="text-xs font-mono text-slate-400">{val || '(configurado)'}</code>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}