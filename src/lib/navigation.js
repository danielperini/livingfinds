import {
  Activity, BarChart3, Bot, Boxes, CircleDollarSign, FileText, Gauge,
  KeyRound, LayoutDashboard, Megaphone, PackageSearch, Settings, ShieldCheck,
  ShoppingBag, SlidersHorizontal, Sparkles, Users, Wrench, ClipboardList,
  HeartPulse, Network, ScrollText, Timer, WandSparkles, HelpCircle, Workflow,
} from 'lucide-react';

/** Navigation groups reorganize existing destinations without changing routes. */
export const navigationJourneys = [
  {
    id: 'operar',
    label: 'Operar',
    items: [
      { path: '/', label: 'Visão geral', icon: LayoutDashboard, exact: true },
      { path: '/products', label: 'Produtos e estoque', icon: ShoppingBag },
      { path: '/inventory', label: 'Sincronização de estoque', icon: Boxes },
      { path: '/ads', label: 'Campanhas', icon: Megaphone },
      { path: '/campaign-factory', label: 'Kick-off', icon: Sparkles },
      { path: '/kickoff-monitor', label: 'Fila de kick-off', icon: ClipboardList },
      { path: '/repricing', label: 'Reprecificação', icon: CircleDollarSign },
      { path: '/products/listing-enhancement', label: 'Conteúdo de produto', icon: WandSparkles },
    ],
  },
  {
    id: 'analisar',
    label: 'Analisar',
    items: [
      { path: '/analytics', label: 'Desempenho', icon: BarChart3 },
      { path: '/search-terms', label: 'Termos de busca', icon: PackageSearch },
      { path: '/keyword-management', label: 'Palavras-chave', icon: KeyRound },
      { path: '/sala-de-comando', label: 'Decisões e alertas', icon: Bot },
      { path: '/term-intelligence', label: 'Inteligência de termos', icon: Network },
      { path: '/keyword-ml', label: 'Modelos de keywords', icon: Workflow },
      { path: '/metrics', label: 'Métricas', icon: Gauge },
      { path: '/bid-logs', label: 'Histórico de lances', icon: Activity },
      { path: '/report', label: 'Relatórios', icon: FileText },
      { path: '/logs', label: 'Histórico e logs', icon: Activity },
      { path: '/diagnostico', label: 'Diagnósticos', icon: HeartPulse },
      { path: '/saude-do-sistema', label: 'Saúde e sincronização', icon: Timer },
      { path: '/optimizer', label: 'Pipeline de otimização', icon: ScrollText },
      { path: '/currency-audit', label: 'Auditoria de moeda', icon: CircleDollarSign },
      { path: '/manual', label: 'Ajuda e manual', icon: HelpCircle },
    ],
  },
  {
    id: 'configurar',
    label: 'Configurar',
    items: [
      { path: '/settings', label: 'Preferências', icon: Settings },
      { path: '/configuracao/apis', label: 'APIs e integrações', icon: Wrench },
      { path: '/configuracao-de-campanhas', label: 'Campanhas e limites', icon: SlidersHorizontal },
      { path: '/autopilot', label: 'Autonomia e proteção', icon: ShieldCheck },
      { path: '/users', label: 'Usuários', icon: Users },
      { path: '/integracoes/amazon', label: 'Conta Amazon', icon: Network },
      { path: '/amazon-oauth-setup', label: 'Autorização Amazon Ads', icon: ShieldCheck },
      { path: '/sp-api-setup', label: 'Conexão SP-API', icon: ShieldCheck },
      { path: '/sp-api-self-auth', label: 'Autorização SP-API', icon: ShieldCheck },
      { path: '/settings/ads-authorization', label: 'Autorização de Ads', icon: ShieldCheck },
      { path: '/daypart-crossasin', label: 'Dayparting', icon: Timer },
    ],
  },
];

export function isNavigationItemActive(pathname, item) {
  return item.exact ? pathname === item.path : pathname === item.path || pathname.startsWith(`${item.path}/`);
}

export function getJourneyForPath(pathname) {
  for (const journey of navigationJourneys) {
    const item = journey.items.find((candidate) => isNavigationItemActive(pathname, candidate));
    if (item) return { journey, item };
  }
  return null;
}
