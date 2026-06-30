import { useState } from 'react';
import { Book, ChevronRight, ChevronDown, Settings, DollarSign, Target, Zap, Clock, BarChart2, Package, Brain, Megaphone, Search, Shield, FileText, Copy, Check } from 'lucide-react';

const SECTIONS = [
  { id: 'intro', label: 'Introdução', icon: Book },
  { id: 'dashboard', label: 'Dashboard', icon: BarChart2 },
  { id: 'produtos', label: 'Produtos', icon: Package },
  { id: 'gestao-ads', label: 'Gestão Ads', icon: Megaphone },
  { id: 'search-terms', label: 'Search Terms', icon: Search },
  { id: 'recomendacoes', label: 'Recomendações', icon: FileText },
  { id: 'learner', label: 'Learner Engine', icon: Brain },
  { id: 'analytics', label: 'Analytics', icon: BarChart2 },
  { id: 'autopilot', label: 'Ads Autopilot', icon: Zap },
  { id: 'estoque', label: 'Estoque & Vendas', icon: Package },
  { id: 'bids-log', label: 'Log de Bids', icon: FileText },
  { id: 'config', label: 'Config. Campanhas', icon: Settings },
  { id: 'dayparting', label: 'Dayparting', icon: Clock },
  { id: 'integracao', label: 'Integração Amazon', icon: Shield },
  { id: 'saude', label: 'Saúde do Sistema', icon: Shield },
];

function CodeBlock({ code }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="relative mt-2">
      <pre className="bg-surface-2 border border-surface-3 rounded-lg p-3 text-xs text-slate-300 font-mono overflow-x-auto">
        {code}
      </pre>
      <button
        onClick={copy}
        className="absolute top-2 right-2 p-1.5 bg-surface-3 border border-surface-3 rounded text-slate-400 hover:text-white transition-colors"
      >
        {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}

function Section({ title, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden mb-4">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-surface-2/30 transition-colors"
      >
        <span className="text-sm font-semibold text-white">{title}</span>
        {open ? <ChevronDown className="w-4 h-4 text-slate-500" /> : <ChevronRight className="w-4 h-4 text-slate-500" />}
      </button>
      {open && <div className="px-5 pb-5 space-y-3 border-t border-surface-2 text-sm text-slate-300">{children}</div>}
    </div>
  );
}

export default function ManualInstrucoes() {
  const [activeSection, setActiveSection] = useState('intro');

  const renderContent = () => {
    switch (activeSection) {
      case 'intro':
        return (
          <div className="space-y-4">
            <Section title="O que é o LivingFinds">
              <p>
                O LivingFinds é uma plataforma de gestão e otimização de campanhas Amazon Ads.
                Utiliza inteligência artificial para analisar desempenho, identificar oportunidades e sugerir ações de otimização.
              </p>
              <div className="bg-cyan/5 border border-cyan/20 rounded-lg p-4 mt-3">
                <p className="text-xs text-cyan font-semibold mb-2">Funcionalidades principais:</p>
                <ul className="text-xs text-slate-300 space-y-1 list-disc list-inside">
                  <li>Sincronização automática de dados da Amazon Ads</li>
                  <li>Análise de desempenho por campanha, produto e palavra-chave</li>
                  <li>Recomendações de bids baseadas em ACoS, ROAS e lucro</li>
                  <li>Criação automatizada de campanhas (AUTO e MANUAL)</li>
                  <li>Proteção contra prejuízos com limites econômicos</li>
                  <li>Dayparting inteligente baseado em padrões horários</li>
                  <li>Controle de budget e pacing diário</li>
                </ul>
              </div>
            </Section>

            <Section title="Primeiros passos">
              <ol className="list-decimal list-inside space-y-2">
                <li>Conecte sua conta Amazon em <strong>Integração Amazon</strong></li>
                <li>Execute o <strong>Sync Amazon Ads 30d</strong> no Dashboard</li>
                <li>Configure suas regras em <strong>Config. Campanhas e IA</strong></li>
                <li>Revise as recomendações em <strong>Recomendações</strong> ou <strong>Learner Engine</strong></li>
                <li>Aprove decisões ou ajuste parâmetros manualmente</li>
              </ol>
            </Section>
          </div>
        );

      case 'dashboard':
        return (
          <div className="space-y-4">
            <Section title="Visão geral">
              <p>O Dashboard é a página inicial com métricas consolidadas dos últimos 30 dias.</p>
            </Section>

            <Section title="KPIs principais">
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="bg-surface-2 rounded-lg p-3">
                  <p className="text-slate-500 mb-1">Ad Spend 30d</p>
                  <p className="text-white font-semibold">Total gasto em anúncios</p>
                </div>
                <div className="bg-surface-2 rounded-lg p-3">
                  <p className="text-slate-500 mb-1">Vendas Ads 30d</p>
                  <p className="text-white font-semibold">Receita atribuída aos anúncios</p>
                </div>
                <div className="bg-surface-2 rounded-lg p-3">
                  <p className="text-slate-500 mb-1">ACoS</p>
                  <p className="text-white font-semibold">(Gasto ÷ Vendas) × 100. Meta típica: 20-30%</p>
                </div>
                <div className="bg-surface-2 rounded-lg p-3">
                  <p className="text-slate-500 mb-1">ROAS</p>
                  <p className="text-white font-semibold">Vendas ÷ Gasto. Meta típica: 3-5x</p>
                </div>
                <div className="bg-surface-2 rounded-lg p-3">
                  <p className="text-slate-500 mb-1">CPC Médio</p>
                  <p className="text-white font-semibold">Custo por clique médio</p>
                </div>
                <div className="bg-surface-2 rounded-lg p-3">
                  <p className="text-slate-500 mb-1">CTR</p>
                  <p className="text-white font-semibold">(Cliques ÷ Impressões) × 100</p>
                </div>
              </div>
            </Section>

            <Section title="Gráfico Spend vs Vendas">
              <p>
                Mostra a evolução diária do gasto e das vendas nos últimos 30 dias.
                Áreas azuis = spend, áreas verdes = vendas.
              </p>
              <p className="text-xs text-slate-400 mt-2">
                <strong>Dica:</strong> Vendas consistentemente acima do spend indicam campanhas lucrativas.
              </p>
            </Section>

            <Section title="Sync Amazon Ads">
              <p>Botão no topo do dashboard para importar dados da Amazon:</p>
              <CodeBlock code="1. Click em 'Sync Amazon Ads 30d'&#10;2. Aguarde importação das campanhas (10-30s)&#10;3. Sistema solicita relatórios de métricas&#10;4. Polling automático a cada 30s&#10;5. Download e processamento dos relatórios&#10;6. Dashboard atualizado com dados reais" />
              <p className="text-xs text-amber-400 mt-2">
                ⚠ Relatórios da Amazon podem levar 2-12 minutos para ficarem prontos.
              </p>
            </Section>

            <Section title="Decisões IA Pendentes">
              <p>
                Painel lateral mostra recomendações da IA aguardando aprovação.
                Click em "Ver todas" para acessar o Learner Engine.
              </p>
            </Section>
          </div>
        );

      case 'produtos':
        return (
          <div className="space-y-4">
            <Section title="Gestão de Produtos">
              <p>
                Lista todos os produtos (ASINs) sincronizados da conta Amazon.
                Mostra status de estoque, campanhas vinculadas e métricas de vendas.
              </p>
            </Section>

            <Section title="Colunas da tabela">
              <div className="space-y-2 text-xs">
                <div><strong className="text-cyan">ASIN:</strong> Identificador único do produto Amazon</div>
                <div><strong className="text-cyan">SKU:</strong> Código interno do vendedor</div>
                <div><strong className="text-cyan">Nome:</strong> Nome do produto (editável)</div>
                <div><strong className="text-cyan">Preço:</strong> Preço atual de venda</div>
                <div><strong className="text-cyan">Estoque FBA:</strong> Unidades disponíveis no centro Amazon</div>
                <div><strong className="text-cyan">Campanha:</strong> Status da campanha vinculada</div>
                <div><strong className="text-cyan">Vendas 30d:</strong> Receita total atribuída</div>
                <div><strong className="text-cyan">ACoS:</strong> Eficiência da campanha</div>
              </div>
            </Section>

            <Section title="Ações disponíveis">
              <ul className="list-disc list-inside space-y-1 text-xs">
                <li><strong className="text-emerald-400">Kick-off:</strong> Cria campanha AUTO + MANUAL para lançamento</li>
                <li><strong className="text-cyan">Acelerador:</strong> Cria campanha MANUAL-EXATA com keywords de IA</li>
                <li><strong className="text-slate-400">Ativar/Desativar:</strong> Toggle de campanha vinculada</li>
                <li><strong className="text-slate-400">Sincronizar nome:</strong> Atualiza nome do produto</li>
              </ul>
            </Section>

            <Section title="Status de campanha">
              <div className="space-y-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full bg-emerald-500" />
                  <span><strong>Ativo:</strong> Campanha veiculando normalmente</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full bg-amber-500" />
                  <span><strong>Pausado:</strong> Campanha pausada manualmente ou por estoque</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full bg-slate-600" />
                  <span><strong>Sem campanha:</strong> Produto sem anúncios ativos</span>
                </div>
              </div>
            </Section>
          </div>
        );

      case 'gestao-ads':
        return (
          <div className="space-y-4">
            <Section title="Gestão de Campanhas">
              <p>
                Interface detalhada para gerenciar campanhas, grupos de anúncios, keywords e search terms.
              </p>
            </Section>

            <Section title="Painel lateral de campanhas">
              <p>Lista todas as campanhas com filtros por status:</p>
              <ul className="list-disc list-inside space-y-1 text-xs">
                <li><strong>Todas:</strong> Sem filtro</li>
                <li><strong>Ativas:</strong> Estado = enabled</li>
                <li><strong>Pausadas:</strong> Estado = paused</li>
                <li><strong>Arquivadas:</strong> Estado = archived</li>
              </ul>
            </Section>

            <Section title="Tabs de gestão">
              <div className="space-y-3 text-xs">
                <div>
                  <strong className="text-cyan">Keywords:</strong>
                  <p className="text-slate-400 mt-1">Lista palavras-chave da campanha com bids atuais, desempenho e sugestões de ajuste.</p>
                </div>
                <div>
                  <strong className="text-cyan">Search Terms:</strong>
                  <p className="text-slate-400 mt-1">Termos de pesquisa reais que geraram cliques/vendas. Permite promover para keyword ou negativar.</p>
                </div>
              </div>
            </Section>

            <Section title="Ações em lote">
              <CodeBlock code="1. Selecione keywords na tabela&#10;2. Ajuste bid no campo 'Nova Bid'&#10;3. Click em 'Aplicar Bids'&#10;4. Confirme a alteração&#10;5. Log registrado em 'Histórico de Bids'" />
            </Section>
          </div>
        );

      case 'config':
        return (
          <div className="space-y-4">
            <Section title="Configuração de Campanhas e IA">
              <p>
                Central de controle para todas as regras de automação, budgets, bids e comportamento da IA.
              </p>
            </Section>

            <Section title="Aba: Geral">
              <div className="space-y-2 text-xs">
                <div><strong>Nome da marca:</strong> Prefixo usado em nomes de campanhas</div>
                <div><strong>Modo de operação:</strong>
                  <ul className="list-disc list-inside mt-1 text-slate-400">
                    <li>Simulação: Nenhuma alteração real na Amazon</li>
                    <li>Manual: Só executa com aprovação explícita</li>
                    <li>Semiautomático: Ações de baixo risco automáticas</li>
                    <li>Automático: IA executa dentro dos limites</li>
                  </ul>
                </div>
                <div><strong>Objetivo principal:</strong> ACoS, ROAS, TACoS, Lucro, Vendas, Lançamento</div>
              </div>
            </Section>

            <Section title="Aba: Budget">
              <div className="space-y-2 text-xs">
                <div><strong>Budget geral diário:</strong> Limite máximo de gasto por dia (obrigatório)</div>
                <div><strong>Distribuição:</strong>
                  <CodeBlock code="Comprovadas: 60% (campanhas vencedoras)&#10;Descoberta: 30% (testes novos)&#10;Testes: 10% (experimental)&#10;Total: 100%" />
                </div>
                <div><strong>Reserva de segurança:</strong> % do budget não alocado para emergências</div>
              </div>
            </Section>

            <Section title="Aba: Objetivos">
              <div className="space-y-2 text-xs">
                <div><strong>ACoS alvo:</strong> Meta de eficiência (ex: 25%)</div>
                <div><strong>ACoS máximo:</strong> Limite absoluto antes de pausa (ex: 40%)</div>
                <div><strong>ROAS alvo:</strong> Retorno mínimo sobre gasto (ex: 4x)</div>
                <div><strong>Margem mínima:</strong> Margem do produto para cálculo de lucro</div>
              </div>
              <p className="text-xs text-amber-400 mt-2">
                ⚠ ACoS alvo deve ser menor que (100 - Margem) para garantir lucro.
              </p>
            </Section>

            <Section title="Aba: Bids">
              <div className="space-y-2 text-xs">
                <div><strong>Bid mínimo/máximo:</strong> Limites globais para todas as keywords</div>
                <div><strong>Aumento/redução máx.:</strong> % de mudança por execução</div>
                <div><strong>Cooldown:</strong> Horas entre alterações na mesma keyword</div>
                <div><strong>Fórmula:</strong>
                  <CodeBlock code="bidIdeal = bidAtual × ACoSAlovo / ACoSObservado&#10;novoBid = bidAtual + 0.25 × (bidIdeal - bidAtual)" />
                </div>
              </div>
            </Section>

            <Section title="Aba: Camps. Manuais">
              <div className="space-y-3 text-xs">
                <div className="bg-surface-2 rounded-lg p-3">
                  <p className="font-semibold text-cyan mb-2">MANUAL-EXACT:</p>
                  <ul className="list-disc list-inside text-slate-400">
                    <li>Criar quando: ≥1 venda, relevância alta</li>
                    <li>Budget inicial: R$ 15</li>
                    <li>Bid inicial: R$ 0,60</li>
                    <li>ACoS máximo: 35%</li>
                  </ul>
                </div>
                <div className="bg-surface-2 rounded-lg p-3">
                  <p className="font-semibold text-cyan mb-2">MANUAL-PHRASE:</p>
                  <ul className="list-disc list-inside text-slate-400">
                    <li>Criar quando: ≥2 vendas consistentes</li>
                    <li>Budget inicial: R$ 15</li>
                    <li>Bid inicial: R$ 0,40</li>
                  </ul>
                </div>
                <div className="bg-surface-2 rounded-lg p-3">
                  <p className="font-semibold text-cyan mb-2">MANUAL-BROAD:</p>
                  <ul className="list-disc list-inside text-slate-400">
                    <li>Desativado por padrão</li>
                    <li>Exige aprovação manual</li>
                  </ul>
                </div>
              </div>
            </Section>

            <Section title="Aba: Dayparting">
              <div className="space-y-2 text-xs">
                <div><strong>Dayparting ativado:</strong> Habilita otimização por horário</div>
                <div><strong>Semanas mínimas:</strong> Período de dados necessário (ex: 4 semanas)</div>
                <div><strong>Cliques mínimos por faixa:</strong> Amostra mínima por slot horário</div>
                <div><strong>Aumento/redução máx.:</strong> % de ajuste por período</div>
              </div>
            </Section>

            <Section title="Aba: Pacing">
              <p className="text-xs">
                Define percentual máximo do budget consumido até cada hora do dia.
                Evita esgotamento precoce do budget.
              </p>
              <CodeBlock code="06h: 5%   (madrugada)&#10;09h: 15%  (início manhã)&#10;12h: 35%  (meio-dia)&#10;15h: 55%  (tarde)&#10;18h: 75%  (fim tarde)&#10;21h: 90%  (noite)&#10;23h59: 100%" />
            </Section>

            <Section title="Aba: Stock & Buy Box">
              <div className="space-y-2 text-xs">
                <div><strong>Pausar sem stock:</strong> Automaticamente pausa campanhas sem estoque</div>
                <div><strong>Reduzir com stock baixo:</strong> Diminui bids quando estoque &lt; mínimo</div>
                <div><strong>Stock mínimo:</strong> Threshold para alerta (ex: 5 unidades)</div>
                <div><strong>Pausar sem Buy Box:</strong> Pausa se perder Buy Box (opcional)</div>
              </div>
            </Section>

            <Section title="Aba: IA">
              <div className="space-y-2 text-xs">
                <div><strong>IA ativada:</strong> Habilita motor de recomendações</div>
                <div><strong>Análise semântica:</strong> Interpreta intenção de search terms</div>
                <div><strong>Detecção de anomalias:</strong> Identifica picos/troughs incomuns</div>
                <div><strong>Execução automática:</strong> IA aplica mudanças sem aprovação (cuidado!)</div>
                <div><strong>Máximo de ações/dia:</strong> Limite de operações diárias</div>
              </div>
            </Section>
          </div>
        );

      case 'dayparting':
        return (
          <div className="space-y-4">
            <Section title="Dayparting Inteligente">
              <p>
                Otimização de bids baseada em padrões de desempenho por hora e dia da semana.
              </p>
            </Section>

            <Section title="Como funciona">
              <ol className="list-decimal list-inside space-y-2 text-xs">
                <li>Coleta dados históricos por hora (30+ dias)</li>
                <li>Classifica cada slot (dia × hora) por eficiência</li>
                <li>Identifica janelas de pico e deficitárias</li>
                <li>Cria regras de ajuste de bid automáticas</li>
                <li>Aplica aumentos em horários rentáveis</li>
                <li>Reduz bids em horários deficitários</li>
              </ol>
            </Section>

            <Section title="Classificação de horários">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-2">
                  <p className="font-semibold text-emerald-400">Pico Alta Rentabilidade</p>
                  <p className="text-slate-400">ROAS ≥4, ACoS ≤25%</p>
                </div>
                <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-2">
                  <p className="font-semibold text-green-400">Pico Conversão</p>
                  <p className="text-slate-400">ROAS ≥3, conversão alta</p>
                </div>
                <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-2">
                  <p className="font-semibold text-blue-400">Eficiente</p>
                  <p className="text-slate-400">ROAS ≥2, ACoS ≤45%</p>
                </div>
                <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-2">
                  <p className="font-semibold text-amber-400">Baixa Eficiência</p>
                  <p className="text-slate-400">ROAS &lt;1, ACoS elevado</p>
                </div>
                <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2">
                  <p className="font-semibold text-red-400">Deficitário</p>
                  <p className="text-slate-400">5+ cliques, 0 vendas</p>
                </div>
                <div className="bg-slate-700/10 border border-slate-700/20 rounded-lg p-2">
                  <p className="font-semibold text-slate-400">Dados Insuficientes</p>
                  <p className="text-slate-400">&lt;3 cliques no slot</p>
                </div>
              </div>
            </Section>

            <Section title="Estratégias de execução">
              <div className="space-y-2 text-xs">
                <div>
                  <strong className="text-cyan">Híbrido (recomendado):</strong>
                  <p className="text-slate-400 mt-1">
                    Bid base reduzido (50%) + regra nativa +100% em picos.
                    Combina controle programático com Schedule Bid Rules da Amazon.
                  </p>
                </div>
                <div>
                  <strong className="text-cyan">Nativo:</strong>
                  <p className="text-slate-400 mt-1">
                    Usa apenas Schedule Bid Rules da Amazon.
                    Limitado a +100% de aumento.
                  </p>
                </div>
                <div>
                  <strong className="text-cyan">Programático:</strong>
                  <p className="text-slate-400 mt-1">
                    Alteração direta de bids via API.
                    Mais flexível, mas requer polling constante.
                  </p>
                </div>
              </div>
            </Section>

            <Section title="Como usar">
              <CodeBlock code="1. Click em 'Analisar Horários'&#10;2. Aguarde processamento (30-60s)&#10;3. Revise campanhas elegíveis&#10;4. Click em 'Revisar' para ver detalhes&#10;5. Escolha modo de execução&#10;6. Click em 'Aprovar e Aplicar'" />
            </Section>
          </div>
        );

      case 'integracao':
        return (
          <div className="space-y-4">
            <Section title="Integração Amazon SP-API">
              <p>
                Conecta o LivingFinds à sua conta Seller Central via Amazon Selling Partner API.
              </p>
            </Section>

            <Section title="Pré-requisitos">
              <ul className="list-disc list-inside space-y-1 text-xs">
                <li>Conta Amazon Seller Central ativa</li>
                <li>Acesso ao Developer Central</li>
                <li>App registrado como 'Solution Provider'</li>
              </ul>
            </Section>

            <Section title="Passo a passo">
              <ol className="list-decimal list-inside space-y-3 text-xs">
                <li>
                  <strong>Acesse 'Integração Amazon':</strong>
                  <p className="text-slate-400 mt-1">Menu lateral → Integração Amazon</p>
                </li>
                <li>
                  <strong>Copie as credenciais:</strong>
                  <CodeBlock code="SP App ID: amzn1.sp.solution.a6d89e43-...&#10;Login URI: https://livingfinds-app.base44.app/integracoes/amazon&#10;Redirect URI: https://livingfinds-app.base44.app/api/auth/amazon/callback" />
                </li>
                <li>
                  <strong>Registe no Seller Central:</strong>
                  <p className="text-slate-400 mt-1">
                    Seller Central → Apps &amp; Services → Editar App → Colar URLs
                  </p>
                </li>
                <li>
                  <strong>Click em 'Conectar Amazon':</strong>
                  <p className="text-slate-400 mt-1">
                    Redireciona para Seller Central para autorização
                  </p>
                </li>
                <li>
                  <strong>Autorize o app:</strong>
                  <p className="text-slate-400 mt-1">
                    Faça login e clique em 'Authorize'
                  </p>
                </li>
                <li>
                  <strong>Retorno automático:</strong>
                  <p className="text-slate-400 mt-1">
                    Redirecionado de volta com status 'Conectado'
                  </p>
                </li>
                <li>
                  <strong>Sync inicial:</strong>
                  <p className="text-slate-400 mt-1">
                    Sincronização automática inicia após conexão
                  </p>
                </li>
              </ol>
            </Section>

            <Section title="Diagnóstico de autenticação">
              <p className="text-xs">
                Botão 'Testar credenciais' executa 4 verificações:
              </p>
              <ul className="list-disc list-inside space-y-1 text-xs mt-2">
                <li>LWA Authentication (OAuth token)</li>
                <li>SP-API Authorization (acesso à API)</li>
                <li>Marketplace Configuration (região correta)</li>
                <li>Endpoint Access (permissões de leitura/escrita)</li>
              </ul>
            </Section>
          </div>
        );

      default:
        return (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Book className="w-12 h-12 text-slate-600 mb-4" />
            <p className="text-sm text-slate-400">
              Documentação em desenvolvimento para esta seção.
            </p>
            <p className="text-xs text-slate-500 mt-2">
              Em breve: guias detalhados para todas as funcionalidades.
            </p>
          </div>
        );
    }
  };

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
          <Book className="w-5 h-5 text-cyan" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-white">Manual de Instruções</h1>
          <p className="text-xs text-slate-400">Guia completo de uso da plataforma LivingFinds</p>
        </div>
      </div>

      <div className="flex gap-5 min-h-0">
        {/* Sidebar */}
        <div className="w-56 flex-shrink-0 space-y-1">
          {SECTIONS.map(s => {
            const Icon = s.icon;
            return (
              <button
                key={s.id}
                onClick={() => setActiveSection(s.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm transition-colors text-left ${
                  activeSection === s.id
                    ? 'bg-cyan/15 text-cyan border border-cyan/20'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-surface-2'
                }`}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                <span className="font-medium text-xs">{s.label}</span>
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {renderContent()}
        </div>
      </div>
    </div>
  );
}