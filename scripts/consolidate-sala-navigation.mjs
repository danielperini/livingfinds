import fs from 'node:fs';

const path = 'src/pages/SalaDeComando.jsx';
let source = fs.readFileSync(path, 'utf8');

const oldTabs = `const TABS = [
  { id: 'visao_geral', label: 'Visão Geral' },
  { id: 'acoes_janela', label: 'Ações da Janela' },
  { id: 'prelecao', label: 'Preleção Semanal' },
  { id: 'estrategias', label: 'Motor de Estratégias' },
  { id: 'kickoff', label: 'Kick-off' },
  { id: 'alertas', label: 'Alertas' },
  { id: 'fila', label: 'Fila e Execuções' },
  { id: 'pausas', label: 'Pausas Pendentes' },
  { id: 'historico', label: 'Histórico e Decisões' },
  { id: 'autopilot', label: 'Automação IA' },
  { id: 'reparo', label: 'Reparo de Campanhas' },
  { id: 'sync_monitor', label: 'Monitor de Sync' },
  { id: 'backup', label: 'Backup' },
];`;

const newTabs = `const TAB_GROUPS = [
  {
    id: 'overview',
    label: 'Visão Geral',
    tabs: [
      { id: 'visao_geral', label: 'Resumo' },
      { id: 'acoes_janela', label: 'Ações da Janela' },
    ],
  },
  {
    id: 'operations',
    label: 'Operações Ads',
    tabs: [
      { id: 'fila', label: 'Fila e Execuções' },
      { id: 'pausas', label: 'Pausas Pendentes' },
      { id: 'reparo', label: 'Reparo de Campanhas' },
    ],
  },
  {
    id: 'strategy',
    label: 'Estratégia & IA',
    tabs: [
      { id: 'estrategias', label: 'Motor de Estratégias' },
      { id: 'prelecao', label: 'Revisão Semanal' },
      { id: 'historico', label: 'Histórico e Decisões' },
      { id: 'autopilot', label: 'Automação IA' },
    ],
  },
  {
    id: 'kickoff_group',
    label: 'Kick-off',
    tabs: [{ id: 'kickoff', label: 'Produtos e Ciclos' }],
  },
  {
    id: 'monitoring',
    label: 'Monitoramento',
    tabs: [
      { id: 'alertas', label: 'Alertas' },
      { id: 'sync_monitor', label: 'Sincronizações' },
    ],
  },
  {
    id: 'system',
    label: 'Sistema',
    tabs: [{ id: 'backup', label: 'Backup' }],
  },
];

const TABS = TAB_GROUPS.flatMap(group => group.tabs);

function findTabGroup(tabId) {
  return TAB_GROUPS.find(group => group.tabs.some(tab => tab.id === tabId)) || TAB_GROUPS[0];
}`;

if (!source.includes(oldTabs)) {
  throw new Error('Bloco TABS original não encontrado; migração interrompida para evitar alteração insegura.');
}
source = source.replace(oldTabs, newTabs);

const navStart = source.indexOf('      {/* Tabs */}');
const navEndMarker = '\n\n      {loading ? (';
const navEnd = source.indexOf(navEndMarker, navStart);
if (navStart < 0 || navEnd < 0) {
  throw new Error('Bloco de navegação original não encontrado.');
}

const newNavigation = `      {/* Navegação consolidada: áreas principais + funções internas */}
      {(() => {
        const activeGroup = findTabGroup(tab);
        const renderBadge = (tabId) => (
          <>
            {tabId === 'acoes_janela' && windowActions.filter(a => a.status === 'failed').length > 0 && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 bg-red-500/20 text-red-400 rounded-full">{windowActions.filter(a => a.status === 'failed').length}</span>}
            {tabId === 'kickoff' && kickoffQueue.filter(i => i.status === 'failed').length > 0 && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 bg-red-500/20 text-red-400 rounded-full">{kickoffQueue.filter(i => i.status === 'failed').length}</span>}
            {tabId === 'kickoff' && kickoffQueue.filter(i => i.status === 'scheduled' || i.status === 'processing').length > 0 && kickoffQueue.filter(i => i.status === 'failed').length === 0 && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 bg-violet-500/20 text-violet-400 rounded-full">{kickoffQueue.filter(i => i.status === 'scheduled' || i.status === 'processing').length}</span>}
            {tabId === 'alertas' && activeAlerts > 0 && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 bg-red-500/20 text-red-400 rounded-full">{activeAlerts}</span>}
            {tabId === 'fila' && queueFailed > 0 && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 bg-red-500/20 text-red-400 rounded-full">{queueFailed}</span>}
            {tabId === 'pausas' && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 bg-amber-500/20 text-amber-400 rounded-full"><Clock className="w-2.5 h-2.5 inline" /></span>}
            {tabId === 'autopilot' && pendingDecisions > 0 && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 bg-amber-500/20 text-amber-400 rounded-full">{pendingDecisions}</span>}
            {tabId === 'sync_monitor' && syncRuns.some(r => r.status === 'error') && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 bg-red-500/20 text-red-400 rounded-full">!</span>}
          </>
        );

        return (
          <div className="space-y-2">
            <div className="flex gap-2 overflow-x-auto scrollbar-thin pb-1" role="tablist" aria-label="Áreas da Sala de Controle">
              {TAB_GROUPS.map(group => {
                const isActive = activeGroup.id === group.id;
                const groupHasError = group.tabs.some(item => (
                  (item.id === 'alertas' && activeAlerts > 0) ||
                  (item.id === 'fila' && queueFailed > 0) ||
                  (item.id === 'sync_monitor' && syncRuns.some(r => r.status === 'error')) ||
                  (item.id === 'kickoff' && kickoffQueue.some(i => i.status === 'failed'))
                ));
                return (
                  <button
                    key={group.id}
                    type="button"
                    onClick={() => setTab(group.tabs[0].id)}
                    className={\`inline-flex items-center rounded-xl border px-4 py-2 text-sm font-semibold whitespace-nowrap transition-colors \${isActive ? 'border-cyan/40 bg-cyan/15 text-cyan' : 'border-surface-3 bg-surface-1 text-slate-400 hover:text-white hover:bg-surface-2'}\`}
                    aria-selected={isActive}
                  >
                    {group.label}
                    {groupHasError && <span className="ml-2 h-2 w-2 rounded-full bg-red-400" aria-label="Há itens pendentes" />}
                  </button>
                );
              })}
            </div>

            {activeGroup.tabs.length > 1 && (
              <div className="flex border-b border-surface-2 overflow-x-auto scrollbar-thin" role="tablist" aria-label={\`Funções de \${activeGroup.label}\`}>
                {activeGroup.tabs.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setTab(item.id)}
                    className={\`px-4 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors \${tab === item.id ? 'border-cyan text-cyan' : 'border-transparent text-slate-500 hover:text-slate-300'}\`}
                    aria-selected={tab === item.id}
                  >
                    {item.label}
                    {renderBadge(item.id)}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })()}`;

source = source.slice(0, navStart) + newNavigation + source.slice(navEnd);
fs.writeFileSync(path, source);
console.log('Navegação da Sala de Controle consolidada com sucesso.');
