import { useState, useEffect, useMemo } from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Megaphone, Settings, Menu, ChevronLeft, ChevronRight,
  ShoppingBag, Bot, Bell, ShieldCheck, CircleDollarSign,
} from 'lucide-react';
import { base44 } from '@/api/base44Client';
import ModeBadge from '@/components/ui/ModeBadge';
import FloatingChat from '@/components/chat/FloatingChat';

const navItems = [
  { path: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { path: '/products', icon: ShoppingBag, label: 'Produtos' },
  { path: '/ads', icon: Megaphone, label: 'Publicidade' },
  { path: '/sala-de-comando', icon: Bot, label: 'Motor' },
  { path: '/analytics', icon: CircleDollarSign, label: 'Finanças' },
];

const pageMeta = {
  '/': ['Dashboard', 'Saúde, rentabilidade e prioridades do negócio.'],
  '/products': ['Produtos', 'Catálogo, estoque e jornada econômica por ASIN.'],
  '/inventory': ['Estoque e vendas', 'Catálogo, disponibilidade, vendas e dados SP-API.'],
  '/ads': ['Publicidade', 'Campanhas, termos e performance Amazon Ads.'],
  '/search-terms': ['Termos de busca', 'Descoberta, conversão e promoção de termos reais.'],
  '/keyword-management': ['Keywords', 'Lances, correspondência, proteção e performance.'],
  '/analytics': ['Finanças', 'Receita, margem, ACoS, ROAS e eficiência.'],
  '/repricing': ['Repricing', 'Preço, margem, Buy Box e regras econômicas.'],
  '/autopilot': ['Autopilot', 'Regras, proteções e ações automatizadas.'],
  '/sala-de-comando': ['Motor', 'Decisões determinísticas, riscos e aprovações.'],
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
      className="w-9 h-9 rounded-xl border border-[#E5E7EB] bg-no-repeat flex-shrink-0"
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

  const navLinkClass = (active) =>
    `flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors ${
      active
        ? 'bg-[#EFF6FF] text-[#2563EB] font-semibold'
        : 'text-[#374151] hover:bg-[#F5F6F8] hover:text-[#0D1117]'
    } ${collapsed ? 'justify-center' : ''}`;

  return (
    <div className="flex h-screen overflow-hidden bg-[#F5F6F8] text-[#0D1117]" style={{ isolation: 'isolate' }}>
      {mobileOpen ? <button type="button" className="fixed inset-0 bg-black/40 z-40 lg:hidden cursor-default" onClick={() => setMobileOpen(false)} aria-label="Fechar menu" /> : null}

      <aside
        className={`fixed lg:relative z-50 h-full flex flex-col bg-white border-r border-[#E5E7EB] transition-all duration-200 ease-out ${collapsed ? 'w-[76px]' : 'w-[238px]'} ${mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}
      >
        <div className={`flex items-center h-[68px] px-4 ${collapsed ? 'justify-center' : 'justify-between'}`}>
          <Link to="/" className="flex items-center gap-3 min-w-0" aria-label="Ir para o dashboard">
            <BrandMark />
            {!collapsed ? <span className="font-semibold text-[#0D1117] text-[17px] tracking-[-0.03em]">livingfinds</span> : null}
          </Link>
          {!collapsed ? (
            <button type="button" onClick={() => setCollapsed(true)} className="hidden lg:flex items-center justify-center w-8 h-8 rounded-lg text-[#6B7280] hover:text-[#0D1117] hover:bg-[#F5F6F8]" aria-label="Recolher menu" title="Recolher menu">
              <ChevronLeft className="w-4 h-4" />
            </button>
          ) : null}
        </div>

        <nav className="flex-1 px-2.5 pb-4 pt-2 overflow-y-auto scrollbar-thin space-y-1" aria-label="Navegação principal">
          {navItems.map(({ path, icon: Icon, label }) => {
            const active = location.pathname === path || (path !== '/' && location.pathname.startsWith(path));
            return (
              <Link key={path} to={path} onClick={() => setMobileOpen(false)} className={navLinkClass(active)} title={collapsed ? label : undefined}>
                <Icon className="w-[18px] h-[18px] flex-shrink-0" strokeWidth={1.8} />
                {!collapsed ? <span className="text-[15px] font-medium truncate">{label}</span> : null}
              </Link>
            );
          })}
        </nav>

        <div className="p-3 space-y-2 border-t border-[#E5E7EB]">
          <Link to="/settings" className={navLinkClass(location.pathname.startsWith('/settings'))} title={collapsed ? 'Configurações' : undefined}>
            <Settings className="w-[18px] h-[18px]" strokeWidth={1.8} />
            {!collapsed ? <span className="text-[15px] font-medium">Configurações</span> : null}
          </Link>
          {!collapsed ? (
            <div className="rounded-xl border border-[#E5E7EB] bg-[#F8FAFC] p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-[#0D1117] truncate">Conta Amazon</p>
                  <p className="text-[11px] text-[#6B7280] mt-0.5 truncate">{account?.name || account?.profile_name || 'Conta conectada'}</p>
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
          ) : (
            <button type="button" onClick={() => setCollapsed(false)} className="w-full flex items-center justify-center h-8 rounded-lg text-[#6B7280] hover:text-[#0D1117] hover:bg-[#F5F6F8]" aria-label="Expandir menu" title="Expandir menu">
              <ChevronRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="min-h-[68px] flex items-center gap-3 px-4 md:px-6 bg-white border-b border-[#E5E7EB] flex-shrink-0">
          <button type="button" className="lg:hidden w-10 h-10 flex items-center justify-center rounded-lg text-[#4B5563] hover:bg-[#F5F6F8]" onClick={() => setMobileOpen(true)} aria-label="Abrir menu" title="Abrir menu">
            <Menu className="w-5 h-5" />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg md:text-[22px] font-semibold text-[#0D1117] tracking-[-0.025em] truncate">{currentMeta[0]}</h1>
            <p className="hidden sm:block text-[13px] text-[#6B7280] mt-0.5 truncate">{currentMeta[1]}</p>
          </div>
          <button type="button" className="relative w-10 h-10 flex items-center justify-center rounded-lg border border-[#E5E7EB] bg-white text-[#6B7280] hover:text-[#0D1117] hover:bg-[#F5F6F8]" aria-label="Notificações" title="Notificações">
            <Bell className="w-[18px] h-[18px]" />
          </button>
          <Link to="/sala-de-comando" className="flex items-center gap-2 px-3.5 h-10 rounded-lg bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-sm font-semibold whitespace-nowrap transition-colors">
            <Bot className="w-4 h-4" />
            <span className="hidden sm:inline">Central de Decisões</span>
          </Link>
        </header>
        <main className="flex-1 overflow-y-auto scrollbar-thin bg-[#F5F6F8]"><Outlet /></main>
      </div>
      <FloatingChat accountId={account?.id} />
    </div>
  );
}