import { useState, useEffect, useCallback } from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Megaphone, Package, Settings, Menu, ChevronLeft, ChevronRight,
  Zap, Bell, ShoppingBag, BookOpen, RefreshCw, Book, Terminal, Loader2, BarChart2
} from 'lucide-react';
import { base44 } from '@/api/base44Client';
import ModeBadge from '@/components/ui/ModeBadge';

// TTL de 23 horas — nunca sync automático mais frequente que isso
const PRODUCT_SYNC_TTL_MS = 23 * 60 * 60 * 1000;
const PRODUCT_SYNC_STORAGE_KEY = 'livingfinds:lastUnifiedProductSync';

const navItems = [
  { path: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { path: '/analytics', icon: BarChart2, label: 'Analytics' },
  { path: '/products', icon: ShoppingBag, label: 'Produtos' },
  { path: '/ads', icon: Megaphone, label: 'Campanhas' },
  { path: '/term-bank', icon: BookOpen, label: 'Term Bank' },
  { path: '/sala-de-comando', icon: Terminal, label: 'Sala de Controle' },
  { path: '/settings', icon: Settings, label: 'Configurações' },
  { path: '/manual', icon: Book, label: 'Manual' },
];

function formatLastSync(value) {
  if (!value) return 'Nunca atualizado';
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}

/** Verifica se o último sync ainda está dentro do TTL */
function isSyncFresh() {
  const last = Number(localStorage.getItem(PRODUCT_SYNC_STORAGE_KEY) || 0);
  return last > 0 && Date.now() - last < PRODUCT_SYNC_TTL_MS;
}

export default function AppLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [accountMode, setAccountMode] = useState('real');
  const [account, setAccount] = useState(null);
  const [productSyncing, setProductSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');
  const [lastSync, setLastSync] = useState(() => {
    const stored = Number(localStorage.getItem(PRODUCT_SYNC_STORAGE_KEY) || 0);
    return stored ? new Date(stored).toISOString() : null;
  });
  const location = useLocation();

  // Inicializar conta (apenas leitura do banco — sem chamar Amazon)
  useEffect(() => {
    let mounted = true;
    document.documentElement.lang = 'pt-BR';
    document.title = 'Living Finds — Gestão Amazon';

    const initialize = async () => {
      try {
        const me = await base44.auth.me();
        let accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
        if (!accounts.length) accounts = await base44.entities.AmazonAccount.filter({ status: 'connected' });
        if (!accounts.length) accounts = await base44.entities.AmazonAccount.list('-updated_date', 1);
        if (!mounted) return;
        const current = accounts[0] || null;
        setAccount(current);
        setAccountMode(current?.mode || 'real');
      } catch (e) {
        console.error('[AppLayout init]', e?.message);
      }
    };

    initialize();
    return () => { mounted = false; };
  }, []);

  /**
   * Sync de produtos com guard de TTL e verificação de relatório válido.
   * Fluxo:
   * 1. Se sync ainda está fresco (< 23h) e trigger é automático → pular
   * 2. Verificar se há relatório válido no banco (account.last_sync_at)
   * 3. Se relatório válido → apenas re-linkar produtos sem chamar relatório novo
   * 4. Se vencido → solicitar novo relatório e sincronizar
   */
  const executeProductSync = useCallback(async (trigger = 'manual') => {
    if (!account?.id || productSyncing) return;

    // Guard TTL: bloqueia sync automático se dados ainda são frescos
    if (trigger !== 'manual' && isSyncFresh()) {
      return;
    }

    // Guard extra: verifica last_sync_at da conta (atualizado pelo backend)
    if (trigger !== 'manual' && account.last_sync_at) {
      const ageHours = (Date.now() - new Date(account.last_sync_at).getTime()) / 3600000;
      if (ageHours < 23) {
        return; // dados do banco ainda válidos — não chamar Amazon
      }
    }

    setProductSyncing(true);
    setSyncMessage('Verificando relatórios e sincronizando produtos...');

    try {
      // 1. Tentar apenas linkar produtos (leve, sem Amazon)
      let links = null;
      try {
        const linksRes = await base44.functions.invoke('fixProductCampaignLinks', { amazon_account_id: account.id, trigger });
        links = linksRes?.data;
      } catch {}

      // 2. Sincronizar catálogo (usa cache interno se disponível)
      const catalogRes = await base44.functions.invoke('syncProductCatalog', { amazon_account_id: account.id, trigger });
      const catalog = catalogRes?.data;

      if (!catalog?.ok) {
        setSyncMessage(catalog?.error || 'Falha ao sincronizar catálogo.');
        return;
      }

      // 3. Solicitar relatório apenas se catálogo indicou necessidade ou se for manual
      let reportMsg = '';
      if (trigger === 'manual' || catalog?.report_needed) {
        try {
          const reportRes = await base44.functions.invoke('requestProductReports', { amazon_account_id: account.id, trigger });
          const reportCount = reportRes?.data?.requested?.length || 0;
          if (reportCount > 0) reportMsg = ` · ${reportCount} relatórios solicitados`;
        } catch {}
      }

      const completedAt = catalog?.completed_at || catalog?.synced_at || new Date().toISOString();
      localStorage.setItem(PRODUCT_SYNC_STORAGE_KEY, String(Date.now()));
      setLastSync(completedAt);

      const updated = catalog?.updated || catalog?.total_updated || 0;
      const fixed = links?.updated || 0;
      setSyncMessage(`${updated} produtos atualizados · ${fixed} vínculos corrigidos${reportMsg}`);

      window.dispatchEvent(new CustomEvent('livingfinds:products-synced', { detail: { catalog, links, completedAt } }));

      if (window.location.pathname === '/products') {
        setTimeout(() => window.location.reload(), 700);
      }
    } catch (error) {
      setSyncMessage(error?.message || 'Falha na sincronização.');
    } finally {
      setProductSyncing(false);
    }
  }, [account, productSyncing]);

  return (
    <div className="flex h-screen bg-canvas overflow-hidden">
      {mobileOpen && (
        <div className="fixed inset-0 bg-black/60 z-40 lg:hidden" onClick={() => setMobileOpen(false)} />
      )}

      <aside
        className={`
          fixed lg:relative z-50 h-full flex flex-col
          bg-[#0D0F14] border-r border-surface-2
          transition-all duration-300 ease-in-out
          ${collapsed ? 'w-16' : 'w-64'}
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        `}
      >
        <div className={`flex items-center h-14 border-b border-surface-2 px-4 ${collapsed ? 'justify-center' : 'justify-between'}`}>
          {!collapsed && (
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-cyan flex items-center justify-center">
                <Zap className="w-4 h-4 text-white" />
              </div>
              <span className="font-heading font-bold text-white text-base">Living Finds</span>
            </div>
          )}
          {collapsed && (
            <div className="w-7 h-7 rounded-lg bg-cyan flex items-center justify-center">
              <Zap className="w-4 h-4 text-white" />
            </div>
          )}
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            className="hidden lg:flex items-center justify-center w-6 h-6 text-slate-500 hover:text-slate-300 transition-colors"
            aria-label={collapsed ? 'Expandir menu' : 'Recolher menu'}
            title={collapsed ? 'Expandir menu' : 'Recolher menu'}
          >
            {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>
        </div>

        <nav className="flex-1 py-4 overflow-y-auto scrollbar-thin" aria-label="Navegação principal">
          {navItems.map(({ path, icon: Icon, label }) => {
            const active = location.pathname === path || (path !== '/' && location.pathname.startsWith(path));
            return (
              <Link
                key={path}
                to={path}
                onClick={() => setMobileOpen(false)}
                className={`
                  flex items-center gap-3 mx-2 mb-1 px-3 py-2.5 rounded-lg transition-all duration-150
                  ${active
                    ? 'bg-cyan/15 text-cyan border border-cyan/20'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-surface-2'
                  }
                  ${collapsed ? 'justify-center px-0' : ''}
                `}
                title={collapsed ? label : undefined}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                {!collapsed && <span className="text-sm font-medium">{label}</span>}
              </Link>
            );
          })}
        </nav>

        {!collapsed && (
          <div className="p-4 border-t border-surface-2 space-y-2">
            {productSyncing && (
              <div className="flex items-center gap-2 text-[11px] text-cyan">
                <Loader2 className="w-3 h-3 animate-spin" />
                Sincronizando produtos...
              </div>
            )}
            <ModeBadge mode={accountMode} />
          </div>
        )}
      </aside>

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="min-h-14 flex items-center justify-between gap-3 px-4 py-2 border-b border-surface-2 bg-surface-1 flex-shrink-0">
          <button
            type="button"
            className="lg:hidden p-2 text-slate-400 hover:text-slate-200"
            onClick={() => setMobileOpen(true)}
            aria-label="Abrir menu"
            title="Abrir menu"
          >
            <Menu className="w-5 h-5" />
          </button>

          <div className="flex-1 min-w-0">
            {location.pathname === '/products' && (
              <div className="flex items-center gap-3 flex-wrap">
                <button
                  type="button"
                  onClick={() => executeProductSync('manual')}
                  disabled={productSyncing || !account}
                  className="flex items-center gap-2 px-3 py-2 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg disabled:opacity-60"
                >
                  <RefreshCw className={`w-4 h-4 ${productSyncing ? 'animate-spin' : ''}`} />
                  {productSyncing ? 'Sincronizando...' : 'Sincronizar produtos'}
                </button>

                <div className="min-w-0">
                  <p className="text-[11px] text-slate-400">
                    Última atualização: {formatLastSync(lastSync)}
                    {lastSync && isSyncFresh() && <span className="ml-1 text-emerald-500">· dados frescos</span>}
                  </p>
                  {syncMessage && (
                    <p className="text-[11px] text-cyan truncate max-w-[620px]">{syncMessage}</p>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
            <ModeBadge mode={accountMode} className="hidden sm:flex" />
            <button
              type="button"
              className="relative p-2 text-slate-400 hover:text-slate-200 transition-colors"
              aria-label="Notificações"
              title="Notificações"
            >
              <Bell className="w-4 h-4" />
            </button>
            <div className="w-8 h-8 rounded-full bg-cyan/20 border border-cyan/30 flex items-center justify-center" title="Living Finds">
              <span className="text-xs font-semibold text-cyan">LF</span>
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto scrollbar-thin">
          <Outlet />
        </main>
      </div>
    </div>
  );
}