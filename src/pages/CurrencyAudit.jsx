import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { ShieldCheck, RefreshCw, Loader2, AlertCircle, XCircle, CheckCircle } from 'lucide-react';

export default function CurrencyAudit() {
  const [account, setAccount] = useState(null);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null);

  useEffect(() => {
    const loadAccount = async () => {
      try {
        const me = await base44.auth.me();
        const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
        if (accounts.length > 0) setAccount(accounts[0]);
      } catch (error) {
        console.error('Erro:', error);
      }
    };
    loadAccount();
  }, []);

  const runAudit = async () => {
    if (!account) return;
    setLoading(true);
    setResults(null);

    try {
      const res = await base44.functions.invoke('auditCurrencyConsistency', {
        amazon_account_id: account.id,
      });
      setResults(res.data);
    } catch (error) {
      setResults({ error: error.message });
    } finally {
      setLoading(false);
    }
  };

  const validateProfile = async () => {
    if (!account) return;
    setLoading(true);
    setResults(null);

    try {
      const res = await base44.functions.invoke('validateAmazonAdsProfile', {
        amazon_account_id: account.id,
        forceRefresh: true,
      });
      setResults(res.data);
    } catch (error) {
      setResults({ error: error.message });
    } finally {
      setLoading(false);
    }
  };

  const severityColor = (severity) => {
    switch (severity) {
      case 'critical': return 'text-red-400 bg-red-500/10 border-red-500/20';
      case 'high': return 'text-amber-400 bg-amber-500/10 border-amber-500/20';
      case 'medium': return 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20';
      case 'low': return 'text-slate-400 bg-slate-500/10 border-slate-500/20';
      default: return 'text-slate-400';
    }
  };

  const IssueIcon = ({ severity }) => {
    switch (severity) {
      case 'critical': return <XCircle className="w-4 h-4" />;
      case 'high': return <AlertCircle className="w-4 h-4" />;
      case 'medium': return <AlertCircle className="w-3 h-3" />;
      default: return <CheckCircle className="w-3 h-3" />;
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-white">Auditoria de Moeda</h1>
          <p className="text-sm text-slate-400">Valida consistência de BRL em todas as entidades</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={validateProfile}
            disabled={loading || !account}
            className="flex items-center gap-2 px-4 py-2 bg-cyan text-white rounded-lg disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
            Validar Perfil
          </button>
          <button
            onClick={runAudit}
            disabled={loading || !account}
            className="flex items-center gap-2 px-4 py-2 bg-surface-2 border border-surface-3 text-slate-300 rounded-lg disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Auditoria Completa
          </button>
        </div>
      </div>

      {account && (
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-white mb-3">Conta Amazon</h2>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
            <div>
              <p className="text-slate-500">Seller</p>
              <p className="text-slate-200">{account.seller_name || '—'}</p>
            </div>
            <div>
              <p className="text-slate-500">Marketplace</p>
              <p className="text-slate-200 font-mono">{account.marketplace_id || '—'}</p>
            </div>
            <div>
              <p className="text-slate-500">Moeda</p>
              <p className="text-slate-200">{account.currency_code || 'BRL'}</p>
            </div>
            <div>
              <p className="text-slate-500">Status</p>
              <p className={`font-semibold ${account.status === 'connected' ? 'text-emerald-400' : 'text-amber-400'}`}>
                {account.status || 'pending'}
              </p>
            </div>
          </div>
        </div>
      )}

      {results?.ok && results.summary && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <div className="rounded-xl border border-surface-3 bg-surface-1 p-4">
            <p className="text-xs text-slate-500">Registros Auditados</p>
            <p className="text-xl font-bold text-white">{results.summary.totalRecordsAudited}</p>
          </div>
          <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4">
            <p className="text-xs text-slate-500">Críticos</p>
            <p className="text-xl font-bold text-red-400">{results.summary.criticalIssues}</p>
          </div>
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
            <p className="text-xs text-slate-500">Altos</p>
            <p className="text-xl font-bold text-amber-400">{results.summary.highIssues}</p>
          </div>
          <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/5 p-4">
            <p className="text-xs text-slate-500">Médios</p>
            <p className="text-xl font-bold text-yellow-400">{results.summary.mediumIssues}</p>
          </div>
          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
            <p className="text-xs text-slate-500">Corrigidos</p>
            <p className="text-xl font-bold text-emerald-400">{results.autoCorrected?.length || 0}</p>
          </div>
        </div>
      )}

      {results?.profile && (
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-emerald-400" />
            <h2 className="text-sm font-semibold text-white">Perfil Amazon Ads Validado</h2>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
            <div>
              <p className="text-slate-500">Profile ID</p>
              <p className="text-slate-200 font-mono">{results.profile.profileId}</p>
            </div>
            <div>
              <p className="text-slate-500">País</p>
              <p className="text-slate-200">{results.profile.countryCode}</p>
            </div>
            <div>
              <p className="text-slate-500">Moeda</p>
              <p className="text-slate-200 font-semibold">{results.profile.currencyCode}</p>
            </div>
            <div>
              <p className="text-slate-500">Locale</p>
              <p className="text-slate-200">{results.profile.locale}</p>
            </div>
          </div>
          {results.errors && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
              <p className="text-xs text-red-400 font-semibold mb-1">Erros de Validação</p>
              <ul className="text-xs text-red-300 space-y-1">
                {results.errors.map((e, i) => (
                  <li key={i}>• {e}</li>
                ))}
              </ul>
            </div>
          )}
          {results.warnings && (
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
              <p className="text-xs text-amber-400 font-semibold mb-1">Avisos</p>
              <ul className="text-xs text-amber-300 space-y-1">
                {results.warnings.map((w, i) => (
                  <li key={i}>• {w}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {results?.issues && results.issues.length > 0 && (
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-4 space-y-3">
          <h2 className="text-sm font-semibold text-white">Issues Encontradas</h2>
          <div className="space-y-2">
            {results.issues.map((issue, idx) => (
              <div
                key={idx}
                className={`flex items-start gap-3 p-3 rounded-lg border ${severityColor(issue.severity)}`}
              >
                <IssueIcon severity={issue.severity} />
                <div className="flex-1">
                  <p className="text-xs font-semibold">{issue.type.replace(/_/g, ' ')}</p>
                  <p className="text-xs opacity-80 mt-0.5">
                    {issue.entity}: {issue.entityId || issue.count ? `${issue.count} registros` : 'N/A'}
                  </p>
                  {issue.note && <p className="text-xs opacity-60 mt-1">{issue.note}</p>}
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full border ${severityColor(issue.severity)}`}>
                  {issue.severity.toUpperCase()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {results?.error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-center gap-3">
          <XCircle className="w-5 h-5 text-red-400" />
          <p className="text-sm text-red-400">{results.error}</p>
        </div>
      )}

      {!results && !loading && (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <ShieldCheck className="w-12 h-12 text-slate-600" />
          <p className="text-sm text-slate-400">Clique em "Auditoria Completa" para validar todas as entidades</p>
        </div>
      )}
    </div>
  );
}