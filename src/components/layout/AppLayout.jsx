import { useState, useEffect, useCallback } from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Megaphone, Package, Settings, Activity, Menu, ChevronLeft, ChevronRight,
  Zap, Bell, ShoppingBag, BookOpen, RefreshCw, Book, Terminal
} from 'lucide-react';
import { base44 } from '@/api/base44Client';
import ModeBadge from '@/components/ui/ModeBadge';

const PRODUCT_SYNC_INTERVAL_MS = 30 * 60 * 1000;
const PRODUCT_SYNC_STORAGE_KEY = 'livingfinds:lastUnifiedProductSync';

const navItems = [
  { path: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { path: '/products', icon: ShoppingBag, label: 'Produtos' },
  { path: '/ads', icon: Megaphone, label: 'Campanhas' },
  { path: '/term-bank', icon: BookOpen, label: 'Term Bank' },
  { path: '/sala-de-comando', icon: Terminal, label: 'Sala de Comando' },
  { path: '/inventory', icon: Package, label: 'Estoque e Vendas' },
  { path: '/settings', icon: Settings, label: 'Configurações' },
  { path: '/manual', icon: Book, label: 'Manual' },
];

function formatLastSync(value) {
  if (!value) return 'Nunca atualizado';
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(value));
}

function shouldRunAutomaticSync() {
  const last = Number(localStorage.getItem(PRODUCT_SYNC_STORAGE_KEY) || 0);
  return !last || Date.now() - last >= PRODUCT_SYNC_INTERVAL_MS;
}

async function invokeOptional(name, payload) {
  try {
    const response = await base44.functions.invoke(name, payload);
    return response?.data || null;
  } catch (error) {
    return { ok: false, error: error?.message || `Falha em ${name}` };
  }
}

async function runUnifiedProductSync(accountId, trigger = 'manual') {
  const payload = { amazon_account_id: accountId, trigger };

  const reports = await invokeOptional('requestProductReports', payload);
  const catalog = await invokeOptional('syncProductCatalog', payload);
  const links = await invokeOptional('fixProductCampaignLinks', payload);

  if (!catalog?.ok) {
    throw new Error(catalog?.error || 'Falha ao sincronizar catálogo, estoque e títulos.');
  }

  const completedAt = catalog?.completed_at || catalog?.synced_at || new Date().toISOString();
  localStorage.setItem(PRODUCT_SYNC_STORAGE_KEY, String(new Date(completedAt).getTime()));

  window.dispatchEvent(new CustomEvent('livingfinds:products-synced', {
    detail: { reports, catalog, links, completedAt },
  }));

  return { reports, catalog, links, completedAt };
}


export default function AppLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [accountMode, setAccountMode] = useState('mock');
  const [account, setAccount] = useState(null);
  const [productSyncing, setProductSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');
  const [lastSync, setLastSync] = useState(() => {
    const stored = Number(localStorage.getItem(PRODUCT_SYNC_STORAGE_KEY) || 0);
    return stored ? new Date(stored).toISOString() : null;
  });
  const location = useLocation();

  const executeProductSync = useCallback(async (trigger = 'manual') => {
    if (!account?.id || productSyncing) return;

    setProductSyncing(true);
    setSyncMessage('Solicitando relatórios e sincronizando produtos...');

    try {
      const result = await runUnifiedProductSync(account.id, trigger);
      setLastSync(result.completedAt);

      const reportCount = result.reports?.requested?.length || 0;
      const updated = result.catalog?.updated || result.catalog?.total_updated || 0;
      const fixed = result.links?.updated || 0;
      setSyncMessage(`${updated} produtos atualizados · ${fixed} vínculos corrigidos · ${reportCount} relatórios solicitados`);

      if (window.location.pathname === '/products') {
        setTimeout(() => window.location.reload(), 700);
      }
    } catch (error) {
      setSyncMessage(error?.message || 'Falha na sincronização de produtos.');
    } finally {
      setProductSyncing(false);
    }
  }, [account, productSyncing]);

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

        const current = accounts[0] || null;
        if (!mounted || !current) return;

        setAccount(current);
        setAccountMode(current.mode || 'real');
      } catch (error) {
        console.error('[Inicialização Amazon]', error?.message || error);
      }
    };

    initialize();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!account?.id) return;

    if (shouldRunAutomaticSync()) executeProductSync('automatic_app_start');

    const interval = window.setInterval(() => {
      if (shouldRunAutomaticSync()) executeProductSync('automatic_interval');
    }, PRODUCT_SYNC_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [account, executeProductSync]);


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
                <Activity className="w-3 h-3 animate-pulse" />
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