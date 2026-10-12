import { useState, useEffect, useMemo, useRef } from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import { Bot, ChevronLeft, ChevronRight, Menu, ShieldCheck, X } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import ModeBadge from '@/components/ui/ModeBadge';
import FloatingChat from '@/components/chat/FloatingChat';
import { getJourneyForPath, isNavigationItemActive, navigationJourneys } from '@/lib/navigation';

const pageMeta = {
  '/': ['Visão geral', 'Saúde, rentabilidade e prioridades do negócio.'],
  '/products': ['Produtos e estoque', 'Catálogo, disponibilidade e operação por produto.'],
  '/inventory': ['Estoque e vendas', 'Disponibilidade, vendas e dados sincronizados da Amazon.'],
  '/ads': ['Campanhas', 'Campanhas, termos e desempenho de Amazon Ads.'],
  '/search-terms': ['Termos de busca', 'Descoberta, conversão e promoção de termos reais.'],
  '/keyword-management': ['Palavras-chave', 'Lances, correspondência e desempenho.'],
  '/analytics': ['Desempenho', 'Receita, margem, ACoS, ROAS e eficiência.'],
  '/repricing': ['Reprecificação', 'Preço, margem, Buy Box e regras econômicas.'],
  '/autopilot': ['Autonomia e proteção', 'Regras, proteções e ações automatizadas.'],
  '/sala-de-comando': ['Decisões e alertas', 'Decisões, riscos e aprovações do motor.'],
  '/campaign-factory': ['Kick-off', 'Criação e manutenção de campanhas.'],
  '/daypart-crossasin': ['Dayparting', 'Distribuição de orçamento e lances ao longo do dia.'],
  '/saude-do-sistema': ['Saúde do sistema', 'Estado das integrações, relatórios e sincronizações.'],
  '/logs': ['Histórico e logs', 'Auditoria operacional e respostas da Amazon.'],
  '/report': ['Relatórios', 'Consolidação operacional e financeira.'],
  '/users': ['Usuários', 'Acessos e permissões do Living Finds.'],
  '/manual': ['Ajuda', 'Orientações operacionais do sistema.'],
  '/settings': ['Preferências', 'Conta Amazon, metas e preferências do sistema.'],
  '/configuracao/apis': ['APIs e integrações', 'Catálogo de integrações e estado de configuração, sem exibir segredos.'],
  '/configuracao-de-campanhas': ['Campanhas e limites', 'Configuração de campanhas e limites operacionais.'],
  '/metrics': ['Métricas', 'Indicadores do negócio e da publicidade.'],
  '/bid-logs': ['Histórico de lances', 'Alterações e confirmações de lances.'],
  '/amazon-oauth-setup': ['Autorização Amazon Ads', 'Configuração de autorização da conta de anúncios.'],
};

function BrandMark() {
  return (
    <div
      className="lf-brand-mark"
      style={{ backgroundImage: "url('/living-finds-mark.png')" }}
      role="img"
      aria-label="Living Finds"
    />
  );
}

export default function AppLayout() {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('lf_sidebar_collapsed') === 'true'; } catch { return false; }
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [accountMode, setAccountMode] = useState('real');
  const [account, setAccount] = useState(null);
  const location = useLocation();
  const menuButtonRef = useRef(null);
  const drawerRef = useRef(null);

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
      } catch (error) {
        console.error('[AppLayout init]', error?.message);
      }
    };
    initialize();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    try { localStorage.setItem('lf_sidebar_collapsed', String(collapsed)); } catch { /* storage can be disabled */ }
  }, [collapsed]);

  useEffect(() => {
    if (!mobileOpen) return undefined;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusTarget = drawerRef.current?.querySelector('a, button');
    focusTarget?.focus();
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setMobileOpen(false);
        menuButtonRef.current?.focus();
      }
      if (event.key !== 'Tab' || !drawerRef.current) return;
      const focusable = [...drawerRef.current.querySelectorAll('a[href], button:not([disabled])')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousBodyOverflow;
      menuButtonRef.current?.focus();
    };
  }, [mobileOpen]);

  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  const currentMeta = useMemo(() => {
    const exact = pageMeta[location.pathname];
    if (exact) return exact;
    const parent = Object.entries(pageMeta)
      .filter(([path]) => path !== '/' && location.pathname.startsWith(`${path}/`))
      .sort(([a], [b]) => b.length - a.length)[0];
    return parent?.[1] || ['Living Finds', 'Gestão inteligente de Amazon Ads e marketplace.'];
  }, [location.pathname]);
  const journey = getJourneyForPath(location.pathname)?.journey;

  const navLinkClass = (active) => `lf-nav-link${active ? ' is-active' : ''}${collapsed ? ' is-collapsed' : ''}`;
  const sidebar = (
    <>
      <div className="lf-sidebar-brand">
        <Link to="/" className="lf-brand-link" aria-label="Living Finds — início">
          <BrandMark />
          {!collapsed && <span className="lf-brand-name">livingfinds</span>}
        </Link>
        {mobileOpen ? (
          <button type="button" className="lf-icon-button lg:hidden" onClick={() => setMobileOpen(false)} aria-label="Fechar navegação">
            <X size={18} />
          </button>
        ) : collapsed ? (
          <button type="button" className="lf-icon-button hidden lg:inline-flex" onClick={() => setCollapsed(false)} aria-label="Expandir navegação" aria-expanded={false} title="Expandir navegação">
            <ChevronRight size={17} />
          </button>
        ) : (
          <button type="button" className="lf-icon-button hidden lg:inline-flex" onClick={() => setCollapsed(true)} aria-label="Recolher navegação" aria-expanded aria-controls="living-finds-navigation" title="Recolher navegação">
            <ChevronLeft size={17} />
          </button>
        )}
      </div>

      <nav className="lf-primary-nav" aria-label="Navegação principal">
        {navigationJourneys.map((group) => (
          <section className="lf-nav-group" key={group.id} aria-label={group.label}>
            {!collapsed && <h2 className="lf-nav-heading">{group.label}</h2>}
            <ul>
              {group.items.map(({ path, icon: Icon, label, exact }) => {
                const active = isNavigationItemActive(location.pathname, { path, exact });
                return (
                  <li key={path}>
                    <Link
                      to={path}
                      onClick={() => mobileOpen && setMobileOpen(false)}
                      className={navLinkClass(active)}
                      title={collapsed ? label : undefined}
                      aria-current={active ? 'page' : undefined}
                    >
                      <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
                      {!collapsed && <span>{label}</span>}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </nav>

      <div className="lf-sidebar-footer">
        {!collapsed ? (
          <div className="lf-account-card">
            <div className="lf-account-card-top">
              <div className="lf-account-card-copy">
                <p>Conta Amazon</p>
                <span>{account?.name || account?.profile_name || 'Conta conectada'}</span>
              </div>
              {account?.status === 'connected'
                ? <span className="lf-connection-dot" aria-label="Conta conectada" />
                : <ShieldCheck size={16} className="lf-icon-warning" aria-label="Estado da conexão não confirmado" />}
            </div>
            <ModeBadge mode={accountMode} className="mt-2" />
          </div>
        ) : (
          <div className="lf-account-card-collapsed" title={account?.name || 'Conta Amazon'}>
            <ShieldCheck size={17} />
          </div>
        )}
      </div>
    </>
  );

  return (
    <div className={`lf-app-shell${collapsed ? ' is-sidebar-collapsed' : ''}`}>
      {mobileOpen && <button type="button" className="lf-drawer-backdrop" onClick={() => { setMobileOpen(false); menuButtonRef.current?.focus(); }} aria-label="Fechar navegação" />}

      <aside
        id="living-finds-navigation"
        ref={drawerRef}
        className={`lf-sidebar${collapsed ? ' is-collapsed' : ''}${mobileOpen ? ' is-mobile-open' : ''}`}
        aria-label="Navegação do Living Finds"
        aria-modal={mobileOpen ? 'true' : undefined}
        role={mobileOpen ? 'dialog' : 'complementary'}
      >
        {sidebar}
      </aside>

      <div className="lf-main-column">
        <header className="lf-topbar">
          <button ref={menuButtonRef} type="button" className="lf-icon-button lf-mobile-menu-button" onClick={() => setMobileOpen(true)} aria-label="Abrir navegação" aria-expanded={mobileOpen} aria-controls="living-finds-navigation">
            <Menu size={20} />
          </button>
          <div className="lf-page-heading">
            <div className="lf-breadcrumbs" aria-label="Você está em">
              <span>Living Finds</span>
              {journey && <><span aria-hidden="true">/</span><span>{journey.label}</span></>}
            </div>
            <h1>{currentMeta[0]}</h1>
            <p>{currentMeta[1]}</p>
          </div>
          <Link to="/sala-de-comando" className="lf-command-link" aria-label="Abrir Central de Decisões">
            <Bot size={17} aria-hidden="true" />
            <span>Central de Decisões</span>
          </Link>
        </header>
        <main className="lf-page-content"><Outlet /></main>
      </div>
      <FloatingChat accountId={account?.id} />
    </div>
  );
}
