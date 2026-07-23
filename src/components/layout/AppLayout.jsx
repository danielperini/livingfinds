import { useState, useEffect } from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Megaphone, Package, Settings, Menu, ChevronLeft, ChevronRight,
  Zap, ShoppingBag, BookOpen, Book, Terminal, BarChart2, Sparkles, Factory, Clock } from
'lucide-react';
import { base44 } from '@/api/base44Client';
import ModeBadge from '@/components/ui/ModeBadge';

const navItems = [
{ path: '/', icon: LayoutDashboard, label: 'Dashboard' },
{ path: '/analytics', icon: BarChart2, label: 'Analytics' },
{ path: '/products', icon: ShoppingBag, label: 'Produtos' },
{ path: '/products/listing-enhancement', icon: Sparkles, label: 'Aprimoramento de Listings', sub: true },
{ path: '/ads', icon: Megaphone, label: 'Campanhas' },
{ path: '/term-bank', icon: BookOpen, label: 'Term Bank' },
{ path: '/campaign-factory', icon: Factory, label: 'Campaign Factory' },
{ path: '/daypart-crossasin', icon: Clock, label: 'Daypart & Cross-ASIN' },
{ path: '/sala-de-comando', icon: Terminal, label: 'Sala de Controle' },
{ path: '/settings', icon: Settings, label: 'Configurações' },
{ path: '/manual', icon: Book, label: 'Manual' }];


export default function AppLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [accountMode, setAccountMode] = useState('real');
  const [account, setAccount] = useState(null);
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
    return () => {mounted = false;};
  }, []);

  return (
    <div className="flex h-screen bg-canvas overflow-hidden">
      {mobileOpen ? <div className="fixed inset-0 bg-black/60 z-40 lg:hidden" onClick={() => setMobileOpen(false)} /> : null}

      <aside
        className={`
          fixed lg:relative z-50 h-full flex flex-col
          bg-[#0D0F14] border-r border-surface-2
          transition-all duration-300 ease-in-out
          ${collapsed ? 'w-16' : 'w-64'}
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        `}>
        
        <div className={`flex items-center h-14 border-b border-surface-2 px-4 ${collapsed ? 'justify-center' : 'justify-between'}`}>
          {!collapsed ? (
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-cyan flex items-center justify-center">
                <Zap className="w-4 h-4 text-white" />
              </div>
              <span className="font-heading font-bold text-white text-base">Living Finds</span>
            </div>
          ) : (
            <div className="w-7 h-7 rounded-lg bg-cyan flex items-center justify-center">
              <Zap className="w-4 h-4 text-white" />
            </div>
          )}
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            className="hidden lg:flex items-center justify-center w-6 h-6 text-slate-500 hover:text-slate-300 transition-colors"
            aria-label={collapsed ? 'Expandir menu' : 'Recolher menu'}
            title={collapsed ? 'Expandir menu' : 'Recolher menu'}>
            
            {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>
        </div>

        <nav className="flex-1 py-4 overflow-y-auto scrollbar-thin" aria-label="Navegação principal">
          {navItems.map(({ path, icon: Icon, label, sub }) => {
            const active = location.pathname === path || (path !== '/' && location.pathname.startsWith(path));
            return (
              <Link
                key={path}
                to={path}
                onClick={() => setMobileOpen(false)}
                className={`
                  flex items-center gap-3 mb-1 px-3 py-2.5 rounded-lg transition-all duration-150
                  ${sub ? 'mx-4' : 'mx-2'}
                  ${active ?
                'bg-cyan/15 text-cyan border border-cyan/20' :
                'text-slate-400 hover:text-slate-200 hover:bg-surface-2'}
                  ${collapsed ? 'justify-center px-0' : ''}
                `}
                title={collapsed ? label : undefined}>
                <Icon className={`flex-shrink-0 ${sub ? 'w-3.5 h-3.5' : 'w-4 h-4'}`} />
                {!collapsed ? <span className={`font-medium ${sub ? 'text-xs' : 'text-sm'}`}>{label}</span> : null}
              </Link>);
          })}
        </nav>

        {!collapsed ? (
          <div className="p-4 border-t border-surface-2">
            <ModeBadge mode={accountMode} />
          </div>
        ) : null}
      </aside>

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="min-h-14 flex items-center justify-between gap-3 px-4 py-2 border-b border-surface-2 bg-surface-1 flex-shrink-0">
          <button
            type="button"
            className="lg:hidden p-2 text-slate-400 hover:text-slate-200"
            onClick={() => setMobileOpen(true)}
            aria-label="Abrir menu"
            title="Abrir menu">
            
            <Menu className="w-5 h-5" />
          </button>

          <div className="flex-1 min-w-0" />

          <div className="flex items-center gap-3">
            <ModeBadge mode={accountMode} className="hidden sm:flex" />
            <div className="w-8 h-8 rounded-full bg-cyan/20 border border-cyan/30 flex items-center justify-center" title="Living Finds">
              <span className="text-xs font-semibold text-cyan">LF</span>
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto scrollbar-thin">
          <Outlet />
        </main>
      </div>
    </div>);

}