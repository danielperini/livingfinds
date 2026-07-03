import { useState, useEffect } from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Megaphone, Package, Settings, Activity, Menu, ChevronLeft, ChevronRight,
  Zap, Bell, Bot, ShoppingBag, FileText, Link2, Book, AlertTriangle, BookOpen
} from 'lucide-react';
import { base44 } from '@/api/base44Client';
import ModeBadge from '@/components/ui/ModeBadge';

const navItems = [
  { path: '/', icon: LayoutDashboard, label: 'Painel e análises' },
  { path: '/products', icon: ShoppingBag, label: 'Produtos' },
  { path: '/ads', icon: Megaphone, label: 'Gestão de anúncios' },
  { path: '/autopilot', icon: Bot, label: 'Automação e IA' },
  { path: '/inventory', icon: Package, label: 'Estoque e vendas' },
  { path: '/bids-log', icon: FileText, label: 'Histórico de lances' },
  { path: '/term-bank', icon: BookOpen, label: 'Banco de termos' },
  { path: '/alerts', icon: AlertTriangle, label: 'Alertas' },
  { path: '/manual', icon: Book, label: 'Manual' },
  { path: '/integracoes/amazon', icon: Link2, label: 'Integração com a Amazon' },
  { path: '/saude-do-sistema', icon: Activity, label: 'Saúde do sistema' },
  { path: '/settings', icon: Settings, label: 'Configurações' },
];

export default function AppLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [accountMode, setAccountMode] = useState('mock');
  const location = useLocation();

  useEffect(() => {
    document.documentElement.lang = 'pt-BR';
    document.title = 'Living Finds — Gestão Amazon';

    base44.auth.me().then(me => {
      return base44.entities.AmazonAccount.filter({ user_id: me.id });
    }).then(accounts => {
      if (accounts.length > 0) setAccountMode(accounts[0].mode || 'real');
    }).catch(() => {});
  }, []);

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
          <div className="p-4 border-t border-surface-2">
            <ModeBadge mode={accountMode} />
          </div>
        )}
      </aside>

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="h-14 flex items-center justify-between px-4 border-b border-surface-2 bg-surface-1 flex-shrink-0">
          <button
            type="button"
            className="lg:hidden p-2 text-slate-400 hover:text-slate-200"
            onClick={() => setMobileOpen(true)}
            aria-label="Abrir menu"
            title="Abrir menu"
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="flex-1" />
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
