import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Rocket, AlertTriangle, TrendingUp, Loader2, Plus } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import EmptyState from '@/components/ui/EmptyState';
import MetricCard from '@/components/ui/MetricCard';

export default function Transitions() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ asin: '', name: '', launch_date: '', target_acos: '' });
  const [saving, setSaving] = useState(false);

  const load = () => {
    base44.entities.Product.filter({ is_transition: true }).then(data => {
      setProducts(data);
    }).catch(console.error).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const addAsin = async () => {
    if (!form.asin) return;
    setSaving(true);
    try {
      const accounts = await base44.entities.AmazonAccount.list();
      await base44.entities.Product.create({
        amazon_account_id: accounts[0]?.id || 'default',
        asin: form.asin,
        name: form.name,
        is_transition: true,
        launch_date: form.launch_date || new Date().toISOString().split('T')[0],
      });
      setForm({ asin: '', name: '', launch_date: '', target_acos: '' });
      setShowForm(false);
      load();
    } catch (err) {
      alert(`Erro: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const totalRevenue = products.reduce((s, p) => s + (p.total_revenue_30d || 0), 0);
  const noStock = products.filter(p => (p.fba_inventory || 0) === 0).length;

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
            <Rocket className="w-5 h-5 text-cyan" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Transições & Novos ASINs</h1>
            <p className="text-xs text-slate-400">{products.length} ASINs em fase de lançamento</p>
          </div>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 px-4 py-2 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg transition-colors"
        >
          <Plus className="w-4 h-4" />
          Adicionar ASIN
        </button>
      </div>

      {/* Add form */}
      {showForm && (
        <div className="bg-surface-1 border border-cyan/20 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-4">Novo ASIN em Transição</h3>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { key: 'asin', label: 'ASIN', placeholder: 'B08XXXXX' },
              { key: 'name', label: 'Nome do produto', placeholder: 'Nome...' },
              { key: 'launch_date', label: 'Data de lançamento', type: 'date' },
              { key: 'target_acos', label: 'ACOS alvo (%)', placeholder: '25' },
            ].map(f => (
              <div key={f.key}>
                <label className="block text-xs text-slate-400 mb-1.5">{f.label}</label>
                <input
                  type={f.type || 'text'}
                  value={form[f.key]}
                  onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white placeholder-slate-600 focus:outline-none focus:border-cyan/50"
                />
              </div>
            ))}
          </div>
          <div className="flex gap-3 mt-4">
            <button
              onClick={addAsin}
              disabled={saving || !form.asin}
              className="px-4 py-2 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg disabled:opacity-50"
            >
              {saving ? 'Guardando...' : 'Adicionar'}
            </button>
            <button onClick={() => setShowForm(false)} className="px-4 py-2 text-slate-400 hover:text-slate-200 text-sm">Cancelar</button>
          </div>
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard label="ASINs em Transição" value={products.length} loading={loading} glowColor="cyan" />
        <MetricCard label="Receita Total 30d" value={totalRevenue} prefix="$" loading={loading} glowColor="green" />
        <MetricCard label="Sem Stock" value={noStock} loading={loading} glowColor="red" />
        <MetricCard label="Stock Médio" value={products.length > 0 ? Math.round(products.reduce((s, p) => s + (p.fba_inventory || 0), 0) / products.length) : 0} loading={loading} glowColor="amber" />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-7 h-7 text-cyan animate-spin" /></div>
      ) : products.length === 0 ? (
        <EmptyState
          icon={Rocket}
          title="Sem ASINs em transição"
          description="Adiciona ASINs em fase de lançamento para monitorizar a performance e receber alertas de stock."
          action={{ label: 'Adicionar ASIN', onClick: () => setShowForm(true) }}
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {products.map(p => {
            const daysLive = p.launch_date ? Math.floor((Date.now() - new Date(p.launch_date).getTime()) / (1000 * 86400)) : null;
            const stockAlert = (p.fba_inventory || 0) === 0 ? 'out' : (p.fba_inventory || 0) < 15 ? 'low' : 'ok';

            return (
              <div key={p.id} className="bg-surface-1 border border-surface-2 hover:border-cyan/20 rounded-xl p-5 transition-all duration-200">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <p className="font-mono text-sm font-bold text-white">{p.asin}</p>
                    <p className="text-xs text-slate-400 mt-0.5 truncate max-w-xs">{p.name || '—'}</p>
                  </div>
                  {stockAlert !== 'ok' && (
                    <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${stockAlert === 'out' ? 'text-red-400 bg-red-400/10 border border-red-400/20' : 'text-amber-400 bg-amber-400/10 border border-amber-400/20'}`}>
                      <AlertTriangle className="w-3 h-3" />
                      {stockAlert === 'out' ? 'Sem Stock' : 'Stock Baixo'}
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-surface-2 rounded-lg p-3 text-center">
                    <p className="text-lg font-bold text-white">{p.fba_inventory || 0}</p>
                    <p className="text-xs text-slate-500 mt-0.5">FBA Stock</p>
                  </div>
                  <div className="bg-surface-2 rounded-lg p-3 text-center">
                    <p className="text-lg font-bold text-emerald-400">${(p.total_revenue_30d || 0).toFixed(0)}</p>
                    <p className="text-xs text-slate-500 mt-0.5">Receita 30d</p>
                  </div>
                  <div className="bg-surface-2 rounded-lg p-3 text-center">
                    <p className="text-lg font-bold text-cyan">{daysLive !== null ? `${daysLive}d` : '—'}</p>
                    <p className="text-xs text-slate-500 mt-0.5">Dias Ativo</p>
                  </div>
                </div>

                {p.launch_date && (
                  <p className="text-xs text-slate-600 mt-3">Lançado em {new Date(p.launch_date).toLocaleDateString('pt-BR')}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}