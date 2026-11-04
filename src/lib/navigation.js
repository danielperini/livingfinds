import {
  BarChart3, Bot, CircleDollarSign, HelpCircle, KeyRound,
  LayoutDashboard, Megaphone, Network, Settings, ShieldCheck,
  ShoppingBag, SlidersHorizontal, Timer, Users, PackageSearch,
} from 'lucide-react';

const journeys = [
  {
    id: 'operar',
    label: 'Operação',
    sections: [{
      id: 'principal',
      label: 'Principal',
      primary: true,
      items: [
        { path: '/', label: 'Visão geral', icon: LayoutDashboard, exact: true },
        { path: '/products', label: 'Produtos', icon: ShoppingBag },
        { path: '/ads', label: 'Campanhas', icon: Megaphone },
        { path: '/search-terms', label: 'Termos e palavras-chave', icon: PackageSearch },
      ],
    }, {
      id: 'regras',
      label: 'Regras da operação',
      items: [
        { path: '/repricing', label: 'Reprecificação', icon: CircleDollarSign },
        { path: '/configuracao-de-campanhas', label: 'Campanhas e limites', icon: SlidersHorizontal },
        { path: '/autopilot', label: 'Autonomia e proteção', icon: ShieldCheck },
        { path: '/daypart-crossasin', label: 'Dayparting', icon: Timer },
      ],
    }],
  },
  {
    id: 'analisar',
    label: 'Análise',
    sections: [{
      id: 'resultados',
      label: 'Resultados',
      primary: true,
      items: [
        { path: '/analytics', label: 'Desempenho', icon: BarChart3 },
        { path: '/sala-de-comando', label: 'Decisões e alertas', icon: Bot },
      ],
    }, {
      id: 'apoio',
      label: 'Apoio',
      items: [
        { path: '/saude-do-sistema', label: 'Saúde e sincronização', icon: Network },
        { path: '/manual', label: 'Ajuda', icon: HelpCircle },
      ],
    }],
  },
  {
    id: 'configurar',
    label: 'Configuração',
    sections: [{
      id: 'conta',
      label: 'Conta e acesso',
      primary: true,
      items: [
        { path: '/settings', label: 'Preferências', icon: Settings },
        { path: '/integracoes/amazon', label: 'Conta Amazon', icon: Network },
        { path: '/configuracao/apis', label: 'APIs e integrações', icon: ShieldCheck },
        { path: '/users', label: 'Usuários', icon: Users },
      ],
    }],
  },
].map(journey => ({ ...journey, items: journey.sections.flatMap(section => section.items) }));

export const navigationJourneys = journeys;

export function isNavigationItemActive(pathname, item) {
  const matches = navigationJourneys.flatMap(({ items }) => items)
    .filter(candidate => candidate.exact
      ? pathname === candidate.path
      : pathname === candidate.path || pathname.startsWith(`${candidate.path}/`))
    .sort((a, b) => b.path.length - a.path.length);
  return matches[0]?.path === item.path;
}

export function getJourneyForPath(pathname) {
  for (const journey of navigationJourneys) {
    const item = journey.items.find(candidate => isNavigationItemActive(pathname, candidate));
    if (item) return { journey, item };
  }
  return null;
}
