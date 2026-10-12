import {
  Activity, BarChart3, Bot, Boxes, CircleDollarSign, FileText, Gauge,
  KeyRound, LayoutDashboard, Megaphone, PackageSearch, Settings, ShieldCheck,
  ShoppingBag, SlidersHorizontal, Sparkles, Users, Wrench, ClipboardList,
  HeartPulse, Network, ScrollText, Timer, WandSparkles, HelpCircle, Workflow,
} from 'lucide-react';

const journeys = [
  {
    id: 'operar',
    label: 'Operar',
    sections: [
      {
        id: 'principal',
        label: 'Principal',
        primary: true,
        items: [
          { path: '/', label: 'Visão geral', icon: LayoutDashboard, exact: true },
          { path: '/products', label: 'Produtos e estoque', icon: ShoppingBag },
          { path: '/ads', label: 'Campanhas', icon: Megaphone },
        ],
      },
      {
        id: 'catalogo',
        label: 'Catálogo e operação',
        items: [
          { path: '/inventory', label: 'Sincronização de estoque', icon: Boxes },
          { path: '/campaign-factory', label: 'Kick-off', icon: Sparkles },
          { path: '/kickoff-monitor', label: 'Fila de kick-off', icon: ClipboardList },
          { path: '/repricing', label: 'Reprecificação', icon: CircleDollarSign },
          { path: '/products/listing-enhancement', label: 'Conteúdo de produto', icon: WandSparkles },
        ],
      },
    ],
  },
  {
    id: 'analisar',
    label: 'Analisar',
    sections: [
      {
        id: 'resultados',
        label: 'Resultados',
        primary: true,
        items: [
          { path: '/analytics', label: 'Desempenho', icon: BarChart3 },
          { path: '/search-terms', label: 'Termos de busca', icon: PackageSearch },
          { path: '/sala-de-comando', label: 'Central de Decisões', icon: Bot },
          { path: '/metrics', label: 'Métricas', icon: Gauge },
          { path: '/report', label: 'Relatórios', icon: FileText },
        ],
      },
      {
        id: 'otimizacao',
        label: 'Otimização de anúncios',
        items: [
          { path: '/keyword-management', label: 'Palavras-chave', icon: KeyRound },
          { path: '/term-intelligence', label: 'Inteligência de termos', icon: Network },
          { path: '/keyword-ml', label: 'Modelos de keywords', icon: Workflow },
          { path: '/bid-logs', label: 'Histórico de lances', icon: Activity },
        ],
      },
      {
        id: 'diagnosticos',
        label: 'Diagnóstico e histórico',
        items: [
          { path: '/logs', label: 'Histórico e logs', icon: Activity },
          { path: '/diagnostico', label: 'Diagnósticos', icon: HeartPulse },
          { path: '/saude-do-sistema', label: 'Saúde e sincronização', icon: Timer },
          { path: '/optimizer', label: 'Pipeline de otimização', icon: ScrollText },
          { path: '/currency-audit', label: 'Auditoria de moeda', icon: CircleDollarSign },
          { path: '/manual', label: 'Ajuda e manual', icon: HelpCircle },
        ],
      },
    ],
  },
  {
    id: 'configurar',
    label: 'Configurar',
    sections: [
      {
        id: 'operacao',
        label: 'Regras da operação',
        primary: true,
        items: [
          { path: '/settings', label: 'Preferências', icon: Settings },
          { path: '/configuracao-de-campanhas', label: 'Campanhas e limites', icon: SlidersHorizontal },
          { path: '/autopilot', label: 'Autonomia e proteção', icon: ShieldCheck },
          { path: '/daypart-crossasin', label: 'Dayparting e transferências', icon: Timer },
        ],
      },
      {
        id: 'amazon',
        label: 'Conta e conexões Amazon',
        items: [
          { path: '/integracoes/amazon', label: 'Conta e marketplace', icon: Network },
          { path: '/configuracao/apis', label: 'APIs e integrações', icon: Wrench },
          { path: '/amazon-oauth-setup', label: 'Amazon Ads · conectar', icon: ShieldCheck },
          { path: '/settings/ads-authorization', label: 'Amazon Ads · autorização', icon: ShieldCheck },
          { path: '/sp-api-setup', label: 'SP-API · conexão', icon: ShieldCheck },
          { path: '/sp-api-self-auth', label: 'SP-API · autorização', icon: ShieldCheck },
        ],
      },
      {
        id: 'admin',
        label: 'Acesso',
        items: [{ path: '/users', label: 'Usuários', icon: Users }],
      },
    ],
  },
].map(journey => ({
  ...journey,
  items: journey.sections.flatMap(section => section.items),
}));

export const navigationJourneys = journeys;

export function isNavigationItemActive(pathname, item) {
  const matches = navigationJourneys.flatMap(({ items }) => items)
    .filter((candidate) => candidate.exact
      ? pathname === candidate.path
      : pathname === candidate.path || pathname.startsWith(`${candidate.path}/`))
    .sort((a, b) => b.path.length - a.path.length);
  return matches[0]?.path === item.path;
}

export function getJourneyForPath(pathname) {
  for (const journey of navigationJourneys) {
    const item = journey.items.find((candidate) => isNavigationItemActive(pathname, candidate));
    if (item) return { journey, item };
  }
  return null;
}
