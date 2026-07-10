/**
 * TokenStatusMonitor — Painel de monitoramento do token Amazon Ads
 * Mostra status, última renovação, expiração e alertas de reautorização.
 */
import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { ShieldCheck, ShieldAlert, ShieldOff, RefreshCw, AlertTriangle, Clock, Key, CheckCircle, XCircle, Loader2 } from 'lucide-react';

const STATUS_CONFIG = {
  active:     { icon: ShieldCheck, color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/25', label: 'Ativo' },
  refreshing: { icon: RefreshCw,   color: 'text-cyan',        bg: 'bg-cyan/10 border-cyan/25',               label: 'Renovando...' },
  error:      { icon: ShieldAlert, color: 'text-amber-400',   bg: 'bg-amber-500/10 border-amber-500/25',     label: 'Erro' },
  revoked:    { icon: ShieldOff,   color: 'text-red-400',     bg: 'bg-red-500/10 border-red-500/25',         label: 'Revogado' },
  missing:    { icon: ShieldOff,   color: 'text-red-400',     bg: 'bg-red-500/10 border-red-500/25',         label: 'Ausente' },
  expired:    { icon: ShieldAlert, color: 'text-red-400',     bg: 'bg-red-500/10 border-red-500/25',         label: 'Expirado' },
};

function formatRelative(dateStr) {
  if (!dateStr) return '—';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 2) return 'agora há pouco';
  if (mins < 60) return `há ${mins} min`;
  if (hours < 24) return `há ${hours}h`;
  return `há ${days}d`;
}

function formatCountdown(dateStr) {
  if (!dateStr) return '—';
  const diff = new Date(dateStr).getTime() - Date.now();
  if (diff <= 0) return 'expirado';
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 2) return 'em instantes';
  if (mins < 60) return `em ${mins} min`;
  if (hours < 24) return `em ${hours}h ${mins % 60}min`;
  return `em ${days}d ${hours % 24}h`;
}

function getRefreshTokenAlert(account) {
  if (!account?.ads_refresh_token_expires_at) return null;
  const daysLeft = Math.floor((new Date(account.ads_refresh_token_expires_at).getTime() - Date.now()) / 86400000);
  if (daysLeft <= 1) return { severity: 'critical', text: `Refresh token expira em ${daysLeft <= 0 ? 'menos de 1 dia' : '1 dia'}! Reconecte imediatamente.` };
  if (daysLeft <= 7) return { severity: 'high', text: `Refresh token expira em ${daysLeft} dias. Reconecte em breve.` };
  if (daysLeft <= 15) return { severity: 'medium', text: `Refresh token expira em ${daysLeft} dias.` };
  if (daysLeft <= 30) return { severity: 'low', text: `Refresh token expira em ${daysLeft} dias.` };
  return null;
}

export default function TokenStatusMonitor({ account, onReconnect }) {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState(null);

  const tokenStatus = account?.ads_token_status || 'missing';
  const cfg = STATUS_CONFIG[tokenStatus] || STATUS_CONFIG.error;
  const Icon = cfg.icon;
  const rfAlert = getRefreshTokenAlert(account);
  const needsReauth = account?.ads_requires_reauth || ['missing', 'revoked'].includes(tokenStatus);

  const handleForceRefresh = async () => {
    if (!account || refreshing) return;
    setRefreshing(true);
    setRefreshMsg(null);
    try {
      const res = await base44.functions.invoke('amazonAdsTokenManager', {
        amazon_account_id: account.id,
        force_refresh: true,
        _service_role: true,
      });
      const d = res?.data || {};
      if (d.ok) {
        setRefreshMsg({ type: 'success', text: `✓ Token renovado com sucesso. Expira ${formatCountdown(d.expires_at)}.` });
      } else if (d.requires_reauthorization) {
        setRefreshMsg({ type: 'error', text: d.message || 'Reautorização necessária.' });
      } else {
        setRefreshMsg({ type: 'warn', text: d.message || 'Falha temporária na renovação.' });
      }
    } catch (e) {
      setRefreshMsg({ type: 'error', text: e.message });
    } finally {
      setRefreshing(false);
      setTimeout(() => setRefreshMsg(null), 10000);
    }
  };

  return (
    <div className="rounded-xl border border-surface-2 bg-surface-1 p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Key className="w-4 h-4 text-slate-400" />
          <span className="text-sm font-semibold text-white">Token Amazon Ads</span>
        </div>
        <span className={`flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-full border ${cfg.bg} ${cfg.color}`}>
          <Icon className={`w-3.5 h-3.5 ${tokenStatus === 'refreshing' ? 'animate-spin' : ''}`} />
          {cfg.label}
        </span>
      </div>

      {/* Alerta de reautorização */}
      {needsReauth && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/25">
          <ShieldOff className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-xs font-semibold text-red-300">Reautorização necessária</p>
            <p className="text-xs text-red-400/80 mt-0.5">Sua autorização Amazon expirou ou foi revogada.</p>
          </div>
          {onReconnect && (
            <button onClick={onReconnect}
              className="flex-shrink-0 px-3 py-1.5 bg-red-500/20 border border-red-500/30 text-red-300 hover:bg-red-500/30 text-xs font-semibold rounded-lg transition-colors">
              Reconectar
            </button>
          )}
        </div>
      )}

      {/* Alerta refresh token expirando */}
      {rfAlert && (
        <div className={`flex items-start gap-2 p-3 rounded-lg border ${
          rfAlert.severity === 'critical' ? 'bg-red-500/10 border-red-500/25' :
          rfAlert.severity === 'high' ? 'bg-amber-500/10 border-amber-500/25' :
          'bg-yellow-500/10 border-yellow-500/25'
        }`}>
          <AlertTriangle className={`w-4 h-4 flex-shrink-0 mt-0.5 ${
            rfAlert.severity === 'critical' ? 'text-red-400' :
            rfAlert.severity === 'high' ? 'text-amber-400' : 'text-yellow-400'
          }`} />
          <p className={`text-xs ${
            rfAlert.severity === 'critical' ? 'text-red-300' :
            rfAlert.severity === 'high' ? 'text-amber-300' : 'text-yellow-300'
          }`}>{rfAlert.text}</p>
        </div>
      )}

      {/* Erro de token */}
      {account?.ads_token_last_error && !needsReauth && (
        <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-500/8 border border-amber-500/20">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-amber-300/80">{account.ads_token_last_error}</p>
        </div>
      )}

      {/* Métricas de token */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-surface-2/60 rounded-lg p-2.5">
          <p className="text-[10px] text-slate-500 mb-1">Refresh token</p>
          <div className="flex items-center gap-1.5">
            {account?.ads_refresh_token ? (
              <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <XCircle className="w-3.5 h-3.5 text-red-400" />
            )}
            <span className={`text-xs font-semibold ${account?.ads_refresh_token ? 'text-emerald-400' : 'text-red-400'}`}>
              {account?.ads_refresh_token ? 'Presente' : 'Ausente'}
            </span>
          </div>
          {account?.ads_refresh_token_expires_at ? (
            <p className="text-[10px] text-slate-500 mt-1">Expira: {new Date(account.ads_refresh_token_expires_at).toLocaleDateString('pt-BR')}</p>
          ) : (
            <p className="text-[10px] text-slate-500 mt-1">Sem data de expiração informada</p>
          )}
        </div>

        <div className="bg-surface-2/60 rounded-lg p-2.5">
          <p className="text-[10px] text-slate-500 mb-1">Access token</p>
          <div className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-slate-400" />
            <span className="text-xs text-slate-300 font-mono">
              {account?.ads_access_token_expires_at
                ? formatCountdown(account.ads_access_token_expires_at)
                : '—'}
            </span>
          </div>
          {account?.ads_last_token_refresh_at && (
            <p className="text-[10px] text-slate-500 mt-1">Renovado: {formatRelative(account.ads_last_token_refresh_at)}</p>
          )}
        </div>
      </div>

      {/* Mensagem de refresh */}
      {refreshMsg && (
        <div className={`px-3 py-2 rounded-lg text-xs font-medium ${
          refreshMsg.type === 'success' ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20' :
          refreshMsg.type === 'warn' ? 'bg-amber-500/10 text-amber-300 border border-amber-500/20' :
          'bg-red-500/10 text-red-300 border border-red-500/20'
        }`}>
          {refreshMsg.text}
        </div>
      )}

      {/* Ação: forçar renovação manual */}
      {!needsReauth && (
        <button
          onClick={handleForceRefresh}
          disabled={refreshing || tokenStatus === 'refreshing'}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-slate-200 text-xs rounded-lg transition-colors disabled:opacity-50"
        >
          {refreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          {refreshing ? 'Renovando token...' : 'Forçar renovação de token'}
        </button>
      )}
    </div>
  );
}