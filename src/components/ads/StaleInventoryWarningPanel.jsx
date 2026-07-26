/**
 * StaleInventoryWarningPanel
 *
 * Exibe um painel de aviso para campanhas AUTO pausadas cujo produto pode ter
 * estoque desatualizado no banco. Permite forçar re-sync + reativação.
 */
import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { AlertTriangle, RefreshCw, Loader2, CheckCircle, XCircle, Package, Zap } from 'lucide-react';

function extractAsin(campaign) {
  if (campaign.asin) return campaign.asin;
  const m = (campaign.name || campaign.campaign_name || '').match(/\b(B0[A-Z0-9]{8})\b/);
  return m ? m[1] : null;
}

/**
 * Identifica campanhas AUTO pausadas cujo produto mostra out_of_stock no banco.
 * Retorna apenas candidatos relevantes para exibição.
 */
function findStaleStockCandidates(campaigns, products) {
  const productsByAsin = Object.fromEntries(products.map((p) => [p.asin, p]));
  return campaigns.
  filter((c) => {
    if ((c.targeting_type || '').toUpperCase() !== 'AUTO') return false;
    const state = (c.state || c.status || '').toLowerCase();
    if (state !== 'paused') return false;
    // Ignorar arquivadas
    if (c.archived === true || c.archive_reason) return false;
    const asin = extractAsin(c);
    if (!asin) return false;
    const prod = productsByAsin[asin];
    if (!prod) return false;
    // Produto com estoque zerado no banco OU não autorizado para Ads
    const hasStockIssue = prod.inventory_status === 'out_of_stock' || (prod.fba_inventory || 0) === 0;
    const hasAuthIssue = !prod.ads_authorized_by_user || prod.ads_scope_status !== 'authorized';
    return hasStockIssue || hasAuthIssue;
  }).
  map((c) => {
    const asin = extractAsin(c);
    const prod = productsByAsin[asin];
    return { campaign: c, product: prod, asin };
  });
}

function CandidateRow({ item, account, onReactivated }) {
  const { campaign, product, asin } = item;
  const [status, setStatus] = useState('idle'); // idle | loading | success | error
  const [result, setResult] = useState(null);

  const hasStockIssue = product.inventory_status === 'out_of_stock' || (product.fba_inventory || 0) === 0;
  const hasAuthIssue = !product.ads_authorized_by_user || product.ads_scope_status !== 'authorized';

  const handleForceSyncReactivate = async () => {
    if (status === 'loading') return;
    setStatus('loading');
    setResult(null);
    try {
      const campaignId = campaign.campaign_id || campaign.amazon_campaign_id;
      const res = await base44.functions.invoke('forceSyncAndReactivate', {
        amazon_account_id: account.id,
        asin,
        campaign_id: campaignId,
        campaign_db_id: campaign.id,
        _service_role: true
      });
      const d = res?.data ?? res;
      if (d?.ok) {
        setStatus('success');
        setResult(d);
        if (d.campaign_reactivated) {
          setTimeout(() => onReactivated?.(campaign.id, asin), 1500);
        }
      } else {
        setStatus('error');
        setResult({ error: d?.error || 'Erro desconhecido' });
      }
    } catch (e) {
      setStatus('error');
      setResult({ error: e.message });
    }
  };

  const campaignName = campaign.name || campaign.campaign_name || asin;
  const lastSync = product.last_catalog_sync_at || product.synced_at;
  const syncDate = lastSync ? new Date(lastSync).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '—';

  return (
    <div className="border border-orange-500/20 rounded-lg bg-orange-500/5 p-3 space-y-2">
      {/* Header */}
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-3.5 h-3.5 text-orange-400 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-bold text-orange-300 truncate">{asin}</p>
          <p className="text-[10px] text-slate-500 truncate">{campaignName.slice(0, 50)}</p>
        </div>
      </div>

      {/* Motivos */}
      <div className="flex flex-wrap gap-1">
        {hasStockIssue &&
        <span className="text-[9px] px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-300 border border-orange-500/20 font-medium">
            Estoque 0 (sync {syncDate})
          </span>
        }
        {hasAuthIssue &&
        <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-300 border border-red-500/20 font-medium">
            Não autorizado p/ Ads
          </span>
        }
      </div>

      {/* Resultado */}
      {status === 'success' && result &&
      <div className="flex items-start gap-1.5 text-[10px] text-emerald-300">
          <CheckCircle className="w-3 h-3 flex-shrink-0 mt-0.5" />
          <div>
            {result.synced_from_amazon ?
          <p>Sync OK · estoque: {result.fba_inventory} un.</p> :
          <p>Sync sem match (SKU mismatch) · autorizado manualmente</p>
          }
            {result.campaign_reactivated ?
          <p>✓ Campanha reativada na Amazon</p> :
          result.campaign_error ?
          <p className="text-amber-400">Campanha: {result.campaign_error.slice(0, 60)}</p> :
          null
          }
          </div>
        </div>
      }
      {status === 'error' && result?.error &&
      <div className="flex items-center gap-1.5 text-[10px] text-red-400">
          <XCircle className="w-3 h-3 flex-shrink-0" />
          <p>{result.error.slice(0, 80)}</p>
        </div>
      }

      {/* Botão */}
      {status !== 'success' &&
      <button
        onClick={handleForceSyncReactivate}
        disabled={status === 'loading'}
        className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[10px] font-bold bg-orange-500/20 border border-orange-500/30 text-orange-300 hover:bg-orange-500/30 rounded-lg transition-colors disabled:opacity-60">
        
          {status === 'loading' ?
        <><Loader2 className="w-3 h-3 animate-spin" /> Sincronizando...</> :
        <><RefreshCw className="w-3 h-3" /> Forçar Sync + Reativar</>
        }
        </button>
      }
    </div>);

}

export default function StaleInventoryWarningPanel({ campaigns, products, account, onReactivated }) {
  const candidates = findStaleStockCandidates(campaigns, products);
  const [dismissed, setDismissed] = useState(new Set());

  const visible = candidates.filter((c) => !dismissed.has(c.campaign.id));

  if (visible.length === 0) return null;

  const handleReactivated = (campaignId, asin) => {
    setDismissed((prev) => new Set([...prev, campaignId]));
    onReactivated?.(campaignId, asin);
  };

  return (
    <div className="space-y-2 hidden">
      <div className="flex items-center gap-1.5 px-1">
        <Package className="w-3 h-3 text-orange-400" />
        <span className="text-[10px] font-bold text-orange-400 uppercase tracking-wider">
          Estoque Desatualizado · {visible.length} campanha{visible.length > 1 ? 's' : ''}
        </span>
      </div>
      {visible.map((item) =>
      <CandidateRow
        key={item.campaign.id}
        item={item}
        account={account}
        onReactivated={handleReactivated} />

      )}
    </div>);

}