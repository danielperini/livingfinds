import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Save, Loader2, CheckCircle, AlertCircle, Package } from 'lucide-react';

export default function CampaignConfigPanel({ campaign, account, products, onSaved }) {
  const [form, setForm] = useState({
    state: campaign.state || 'enabled',
    daily_budget: campaign.daily_budget || 10,
    bidding_strategy: campaign.bidding_strategy || 'dynamic_down_only',
    targeting_type: campaign.targeting_type || 'AUTO',
  });
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('idle'); // idle | success | error
  const [errorMsg, setErrorMsg] = useState('');

  // Produto relacionado a esta campanha (por ASIN)
  const relatedProduct = products.find(p => p.asin === campaign.asin) || null;

  useEffect(() => {
    setForm({
      state: campaign.state || 'enabled',
      daily_budget: campaign.daily_budget || 10,
      bidding_strategy: campaign.bidding_strategy || 'dynamic_down_only',
      targeting_type: campaign.targeting_type || 'AUTO',
    });
    setStatus('idle');
  }, [campaign.id]);

  const handleSave = async () => {
    setSaving(true);
    setStatus('idle');
    setErrorMsg('');
    try {
      // Salvar no banco local
      await base44.entities.Campaign.update(campaign.id, {
        state: form.state,
        status: form.state,
        daily_budget: Number(form.daily_budget),
        bidding_strategy: form.bidding_strategy,
      });

      // Se mudou o estado, envia para Amazon via função
      if (form.state !== campaign.state) {
        if (form.state === 'paused') {
          await base44.functions.invoke('pauseCampaign', {
            amazon_account_id: account.id,
            campaign_id: campaign.campaign_id,
          });
        }
        // Para 'enabled' usa agentAction
        if (form.state === 'enabled') {
          await base44.entities.AgentAction.create({
            amazon_account_id: account.id,
            action: 'enable_campaign',
            campaign_id: campaign.campaign_id,
            reason: 'Ativação manual via configurações',
            requires_approval: false,
          });
        }
      }

      setStatus('success');
      onSaved?.({ ...campaign, ...form, daily_budget: Number(form.daily_budget) });
      setTimeout(() => setStatus('idle'), 3000);
    } catch (e) {
      setStatus('error');
      setErrorMsg(e.message);
      setTimeout(() => setStatus('idle'), 4000);
    } finally {
      setSaving(false);
    }
  };

  const changed =
    form.state !== (campaign.state || 'enabled') ||
    Number(form.daily_budget) !== (campaign.daily_budget || 10) ||
    form.bidding_strategy !== (campaign.bidding_strategy || 'dynamic_down_only');

  return (
    <div className="p-6 space-y-6 max-w-2xl">

      {/* Produto relacionado */}
      <div className="bg-surface-2 border border-surface-3 rounded-xl p-4">
        <p className="text-xs font-semibold text-slate-400 mb-3 uppercase tracking-wider">Produto Relacionado</p>
        {relatedProduct ? (
          <div className="flex items-center gap-3">
            {relatedProduct.product_image_url ? (
              <img src={relatedProduct.product_image_url} alt={relatedProduct.asin}
                className="w-14 h-14 rounded-lg object-cover bg-surface-3 flex-shrink-0" />
            ) : (
              <div className="w-14 h-14 rounded-lg bg-surface-3 flex items-center justify-center flex-shrink-0">
                <Package className="w-6 h-6 text-slate-600" />
              </div>
            )}
            <div className="min-w-0">
              <p className="text-sm font-semibold text-white line-clamp-2">
                {relatedProduct.display_name || relatedProduct.product_name || relatedProduct.asin}
              </p>
              <div className="flex items-center gap-3 mt-1 flex-wrap">
                <span className="text-xs font-mono text-cyan">{relatedProduct.asin}</span>
                {relatedProduct.sku && (
                  <span className="text-xs text-slate-400 font-mono">SKU: {relatedProduct.sku}</span>
                )}
                {relatedProduct.price > 0 && (
                  <span className="text-xs text-emerald-400">
                    R$ {Number(relatedProduct.price).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 mt-1">
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${
                  relatedProduct.inventory_status === 'in_stock' ? 'bg-emerald-500/15 text-emerald-400' :
                  relatedProduct.inventory_status === 'low_stock' ? 'bg-amber-500/15 text-amber-400' :
                  'bg-red-500/15 text-red-400'
                }`}>
                  {relatedProduct.inventory_status === 'in_stock' ? 'Em Estoque' :
                   relatedProduct.inventory_status === 'low_stock' ? 'Estoque Baixo' : 'Sem Estoque'}
                </span>
                <span className="text-[10px] text-slate-500">{relatedProduct.fba_inventory || 0} un. FBA</span>
              </div>
            </div>
          </div>
        ) : campaign.asin ? (
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-surface-3 flex items-center justify-center flex-shrink-0">
              <Package className="w-5 h-5 text-slate-600" />
            </div>
            <div>
              <p className="text-xs font-mono text-cyan">{campaign.asin}</p>
              <p className="text-xs text-slate-500">Produto não encontrado no catálogo local</p>
            </div>
          </div>
        ) : (
          <p className="text-xs text-slate-500">Nenhum ASIN associado a esta campanha</p>
        )}
      </div>

      {/* Configurações editáveis */}
      <div className="bg-surface-2 border border-surface-3 rounded-xl p-4 space-y-4">
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Configurações da Campanha</p>

        {/* Estado */}
        <div>
          <label className="text-xs text-slate-400 mb-1.5 block">Estado</label>
          <div className="flex gap-2">
            {[
              { val: 'enabled', label: 'Ativa', color: 'emerald' },
              { val: 'paused', label: 'Pausada', color: 'amber' },
            ].map(opt => (
              <button key={opt.val} type="button"
                onClick={() => setForm(f => ({ ...f, state: opt.val }))}
                className={`px-4 py-2 rounded-lg text-xs font-semibold border transition-all ${
                  form.state === opt.val
                    ? opt.color === 'emerald'
                      ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-400'
                      : 'bg-amber-500/20 border-amber-500/40 text-amber-400'
                    : 'bg-surface-3 border-surface-3 text-slate-500 hover:text-slate-300'
                }`}>
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Orçamento diário */}
        <div>
          <label className="text-xs text-slate-400 mb-1.5 block">Orçamento Diário (R$)</label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              step="1"
              min="1"
              value={form.daily_budget}
              onChange={e => setForm(f => ({ ...f, daily_budget: e.target.value }))}
              className="w-40 px-3 py-2 bg-surface-3 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50"
            />
            <span className="text-xs text-slate-500">/ dia</span>
          </div>
        </div>

        {/* Estratégia de bid */}
        <div>
          <label className="text-xs text-slate-400 mb-1.5 block">Estratégia de Lance</label>
          <div className="flex flex-col gap-1.5">
            {[
              { val: 'dynamic_down_only', label: 'Dinâmico — só reduz', desc: 'Amazon reduz lances quando menos provável converter' },
              { val: 'dynamic_up_down', label: 'Dinâmico — sobe e desce', desc: 'Amazon ajusta lances para maximizar conversão' },
              { val: 'fixed', label: 'Lance fixo', desc: 'Usa exatamente o bid definido por keyword' },
            ].map(opt => (
              <button key={opt.val} type="button"
                onClick={() => setForm(f => ({ ...f, bidding_strategy: opt.val }))}
                className={`w-full text-left px-3 py-2.5 rounded-lg border transition-all ${
                  form.bidding_strategy === opt.val
                    ? 'bg-cyan/10 border-cyan/30 text-cyan'
                    : 'bg-surface-3 border-surface-3 text-slate-400 hover:text-slate-300'
                }`}>
                <p className="text-xs font-semibold">{opt.label}</p>
                <p className="text-[10px] text-slate-500 mt-0.5">{opt.desc}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Tipo de targeting — só exibição */}
        <div>
          <label className="text-xs text-slate-400 mb-1.5 block">Tipo de Segmentação</label>
          <span className={`inline-block px-3 py-1.5 rounded-lg text-xs font-semibold ${
            form.targeting_type === 'AUTO'
              ? 'bg-purple-500/15 text-purple-400 border border-purple-500/20'
              : 'bg-cyan/10 text-cyan border border-cyan/20'
          }`}>
            {form.targeting_type === 'AUTO' ? 'Automática' : 'Manual'}
          </span>
          <p className="text-[10px] text-slate-600 mt-1">O tipo de segmentação não pode ser alterado após a criação da campanha.</p>
        </div>
      </div>

      {/* Info só-leitura */}
      <div className="bg-surface-2 border border-surface-3 rounded-xl p-4">
        <p className="text-xs font-semibold text-slate-400 mb-3 uppercase tracking-wider">Informações Gerais</p>
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <p className="text-slate-500">ID da Campanha</p>
            <p className="text-white font-mono text-[11px] truncate">{campaign.campaign_id || '—'}</p>
          </div>
          <div>
            <p className="text-slate-500">Tipo</p>
            <p className="text-white">{campaign.campaign_type || 'SP'}</p>
          </div>
          <div>
            <p className="text-slate-500">Spend Total</p>
            <p className="text-white">${(campaign.spend || 0).toFixed(2)}</p>
          </div>
          <div>
            <p className="text-slate-500">Vendas Ads</p>
            <p className="text-emerald-400">${(campaign.sales || 0).toFixed(2)}</p>
          </div>
          <div>
            <p className="text-slate-500">ACoS</p>
            <p className={`font-semibold ${(campaign.acos || 0) > 40 ? 'text-red-400' : 'text-emerald-400'}`}>
              {(campaign.acos || 0).toFixed(1)}%
            </p>
          </div>
          <div>
            <p className="text-slate-500">ROAS</p>
            <p className="text-cyan">{(campaign.roas || 0).toFixed(2)}x</p>
          </div>
          {campaign.start_date && (
            <div>
              <p className="text-slate-500">Data de Início</p>
              <p className="text-white">{campaign.start_date}</p>
            </div>
          )}
          <div>
            <p className="text-slate-500">Dias Rodando</p>
            <p className="text-white">{campaign.days_running || 0} dias</p>
          </div>
        </div>
      </div>

      {/* Botão salvar */}
      {changed && (
        <div className="flex items-center gap-3">
          <button onClick={handleSave} disabled={saving}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold transition-all disabled:opacity-60 ${
              status === 'success' ? 'bg-emerald-600 text-white' :
              status === 'error' ? 'bg-red-600 text-white' :
              'bg-cyan hover:bg-cyan/90 text-white'
            }`}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> :
             status === 'success' ? <CheckCircle className="w-4 h-4" /> :
             status === 'error' ? <AlertCircle className="w-4 h-4" /> :
             <Save className="w-4 h-4" />}
            {saving ? 'Salvando...' : status === 'success' ? 'Salvo!' : status === 'error' ? (errorMsg || 'Erro') : 'Salvar Alterações'}
          </button>
          {status === 'error' && errorMsg && (
            <p className="text-xs text-red-400">{errorMsg}</p>
          )}
        </div>
      )}
    </div>
  );
}