import { useState, useEffect, useMemo } from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Megaphone, Settings, Menu, ChevronLeft, ChevronRight,
  ShoppingBag, Book, Terminal, BarChart2, Sparkles, Factory, Clock, Users,
  Tag, Bot, Activity, Bell, Search, ShieldCheck, CircleDollarSign, PackageSearch,
  FileBarChart, KeyRound
} from 'lucide-react';
import { base44 } from '@/api/base44Client';
import ModeBadge from '@/components/ui/ModeBadge';
import FloatingChat from '@/components/chat/FloatingChat';

const navGroups = [
  {
    label: 'Negócio',
    items: [
      { path: '/', icon: LayoutDashboard, label: 'Visão Geral' },
      { path: '/products', icon: ShoppingBag, label: 'Produtos' },
      { path: '/inventory', icon: PackageSearch, label: 'Estoque e vendas', sub: true },
      { path: '/ads', icon: Megaphone, label: 'Publicidade' },
      { path: '/search-terms', icon: KeyRound, label: 'Termos de busca', sub: true },
      { path: '/analytics', icon: CircleDollarSign, label: 'Finanças' },
      { path: '/repricing', icon: Tag, label: 'Repricing', sub: true },
    ],
  },
  {
    label: 'Automação',
    items: [
      { path: '/sala-de-comando', icon: Bot, label: 'Decisões' },
      { path: '/autopilot', icon: Sparkles, label: 'Autopilot' },
      { path: '/campaign-factory', icon: Factory, label: 'Kick-off e campanhas' },
      { path: '/keyword-management', icon: BarChart2, label: 'Keywords', sub: true },
      { path: '/daypart-crossasin', icon: Clock, label: 'Dayparting', sub: true },
    ],
  },
  {
    label: 'Operação',
    items: [
      { path: '/saude-do-sistema', icon: Activity, label: 'Sincronizações' },
      { path: '/logs', icon: Terminal, label: 'Logs' },
      { path: '/report', icon: FileBarChart, label: 'Relatórios', sub: true },
      { path: '/users', icon: Users, label: 'Usuários' },
      { path: '/manual', icon: Book, label: 'Manual', sub: true },
    ],
  },
];

const pageMeta = {
  '/': ['Visão Geral', 'Saúde, rentabilidade e prioridades do negócio.'],
  '/products': ['Produtos', 'Catálogo, estoque e jornada econômica por ASIN.'],
  '/inventory': ['Estoque e vendas', 'Catálogo, disponibilidade, vendas e dados SP-API.'],
  '/ads': ['Publicidade', 'Campanhas, termos e performance Amazon Ads.'],
  '/search-terms': ['Termos de busca', 'Descoberta, conversão e promoção de termos reais.'],
  '/keyword-management': ['Keywords', 'Lances, correspondência, proteção e performance.'],
  '/analytics': ['Finanças', 'Receita, margem, ACoS, ROAS e eficiência.'],
  '/repricing': ['Repricing', 'Preço, margem, Buy Box e regras econômicas.'],
  '/autopilot': ['Autopilot', 'Regras, proteções e ações automatizadas.'],
  '/sala-de-comando': ['Decisões', 'Recomendações determinísticas, riscos e aprovações.'],
  '/campaign-factory': ['Kick-off e campanhas', 'Criação e manutenção idempotente de campanhas.'],
  '/daypart-crossasin': ['Dayparting', 'Distribuição de orçamento e lances ao longo do dia.'],
  '/saude-do-sistema': ['Sincronizações', 'Estado das integrações, reports e persistência.'],
  '/logs': ['Logs', 'Auditoria operacional e respostas da Amazon.'],
  '/report': ['Relatórios', 'Consolidação operacional e financeira persistida.'],
  '/users': ['Usuários', 'Acessos e permissões do LivingFinds.'],
  '/manual': ['Manual', 'Orientações operacionais do sistema.'],
  '/settings': ['Configurações', 'Conta Amazon, metas e preferências do sistema.'],
};

function BrandMark() {
  return (
    <div
      className="w-9 h-9 rounded-xl border border-white/10 bg-no-repeat shadow-lg shadow-blue-950/30 flex-shrink-0"
      style={{ backgroundImage: "url('/living-finds-mark.png')", backgroundSize: '250%', backgroundPosition: '50% 50%' }}
      role="img"
      aria-label="Living Finds"
    />
  );
}

export default function AppLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [accountMode, setAccountMode] = useState('real');
  const [account, setAccount] = useState(null);
  const location = useLocation();

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

  const currentMeta = useMemo(() => {
    const exact = pageMeta[location.pathname];
    if (exact) return exact;
    const parent = Object.entries(pageMeta)
      .filter(([path]) => path !== '/' && location.pathname.startsWith(path))
      .sort(([a], [b]) => b.length - a.length)[0];
    return parent?.[1] || ['Living Finds', 'Gestão inteligente de Amazon Ads e marketplace.'];
  }, [location.pathname]);

  return (
    <div className="lf-app-shell flex h-screen overflow-hidden text-[var(--text-primary)]">
      {mobileOpen ? <button type="button" className="fixed inset-0 bg-black/70 z-40 lg:hidden cursor-default" onClick={() => setMobileOpen(false)} aria-label="Fechar menu" /> : null}

      <aside className={`lf-sidebar fixed lg:relative z-50 h-full flex flex-col border-r transition-all duration-200 ease-out ${collapsed ? 'w-[76px]' : 'w-[238px]'} ${mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
        <div className={`flex items-center h-[72px] px-4 ${collapsed ? 'justify-center' : 'justify-between'}`}>
          <Link to="/" className="flex items-center gap-3 min-w-0" aria-label="Ir para a visão geral">
            <BrandMark />
            {!collapsed ? <span className="font-semibold text-theme-primary text-[17px] tracking-[-0.03em]">livingfinds</span> : null}
          </Link>
          {!collapsed ? <button type="button" onClick={() => setCollapsed(true)} className="lf-icon-button hidden lg:flex items-center justify-center w-8 text-slate-500 hover:text-slate-200" aria-label="Recolher menu" title="Recolher menu"><ChevronLeft className="w-4 h-4" /></button> : null}
        </div>

        <nav className="flex-1 px-2.5 pb-4 overflow-y-auto scrollbar-thin" aria-label="Navegação principal">
          {navGroups.map((group) => (
            <div key={group.label} className="mb-4">
              {!collapsed ? <p className="px-3 mb-2 text-[10px] font-semibold tracking-[0.12em] uppercase text-slate-400">{group.label}</p> : null}
              <div className="space-y-1">
                {group.items.map(({ path, icon: Icon, label, sub }) => {
                  const active = location.pathname === path || (path !== '/' && location.pathname.startsWith(path));
                  return (
                    <Link key={path} to={path} onClick={() => setMobileOpen(false)} className={`lf-nav-link flex items-center gap-3 px-3 rounded-lg text-slate-300 hover:text-white hover:bg-surface-2 transition-colors ${active ? 'lf-nav-link-active !bg-amazon-light !text-amazon font-semibold' : ''} ${collapsed ? 'justify-center' : ''} ${sub && !collapsed ? 'ml-3' : ''}`} title={collapsed ? label : undefined}>
                      <Icon className={`${sub ? 'w-3.5 h-3.5' : 'w-[18px] h-[18px]'} flex-shrink-0`} strokeWidth={1.8} />
                      {!collapsed ? <span className={`${sub ? 'text-xs' : 'text-sm'} font-medium truncate`}>{label}</span> : null}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="p-3 space-y-2 border-t border-[var(--border-color)]">
          <Link to="/settings" className={`lf-nav-link flex items-center gap-3 px-3 rounded-lg text-slate-300 hover:text-white hover:bg-surface-2 transition-colors ${location.pathname.startsWith('/settings') ? 'lf-nav-link-active !bg-amazon-light !text-amazon font-semibold' : ''} ${collapsed ? 'justify-center' : ''}`} title={collapsed ? 'Configurações' : undefined}>
            <Settings className="w-[18px] h-[18px]" strokeWidth={1.8} />
            {!collapsed ? <span className="text-sm font-medium">Configurações</span> : null}
          </Link>
          {!collapsed ? (
            <div className="rounded-xl border border-[var(--border-color)] bg-theme-card-2 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-theme-primary truncate">Conta Amazon</p>
                  <p className="text-[10px] text-theme-muted mt-0.5 truncate">{account?.name || account?.profile_name || 'Conta conectada'}</p>
                </div>
                {account?.status === 'connected' ? (
                  <span className="relative flex w-2 h-2 flex-shrink-0" title="Conta conectada">
                    <span className="absolute inline-flex w-full h-full rounded-full bg-emerald-400 opacity-60 animate-pulse-badge" />
                    <span className="relative inline-flex w-2 h-2 rounded-full bg-emerald-500" />
                  </span>
                ) : (
                  <ShieldCheck className="w-4 h-4 text-amber-500 flex-shrink-0" />
                )}
              </div>
              <ModeBadge mode={accountMode} className="mt-2" />
            </div>
          ) : <button type="button" onClick={() => setCollapsed(false)} className="lf-icon-button w-full flex items-center justify-center text-slate-300 hover:text-white" aria-label="Expandir menu" title="Expandir menu"><ChevronRight className="w-4 h-4" /></button>}
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="lf-topbar min-h-[72px] flex items-center gap-3 px-4 md:px-6 border-b flex-shrink-0">
          <button type="button" className="lf-icon-button lg:hidden w-10 flex items-center justify-center text-slate-300 hover:text-white" onClick={() => setMobileOpen(true)} aria-label="Abrir menu" title="Abrir menu"><Menu className="w-5 h-5" /></button>
          <div className="min-w-0 flex-1"><h1 className="text-lg md:text-xl font-semibold text-white tracking-[-0.025em] truncate">{currentMeta[0]}</h1><p className="hidden sm:block text-xs text-slate-500 mt-0.5 truncate">{currentMeta[1]}</p></div>
          <div className="hidden xl:flex lf-search h-10 w-[320px] items-center gap-2 px-3" role="search"><Search className="w-4 h-4 text-slate-500" /><span className="text-xs text-slate-500">Use a busca disponível em cada área</span></div>
          <button type="button" className="lf-icon-button relative w-10 flex items-center justify-center border border-white/[0.06] bg-white/[0.025] text-slate-400 hover:text-white" aria-label="Notificações" title="Notificações"><Bell className="w-[18px] h-[18px]" /></button>
          <Link to="/sala-de-comando" className="lf-primary-button flex items-center gap-2 px-3.5 text-xs font-semibold whitespace-nowrap"><Bot className="w-4 h-4" /><span className="hidden sm:inline">Central de Decisões</span></Link>
        </header>
        <main className="lf-workspace flex-1 overflow-y-auto scrollbar-thin"><Outlet /></main>
      </div>
      <FloatingChat accountId={account?.id} />
    </div>
  );
}