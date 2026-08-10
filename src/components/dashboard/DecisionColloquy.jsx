import { useMemo } from 'react';
import {
  Target, Stethoscope, Gauge, ListChecks, ArrowRight, CalendarClock,
  Lightbulb, Ban, ShieldCheck, TrendingUp, Clock3, CheckCircle2, AlertTriangle,
} from 'lucide-react';

const RISK_LETTER = { low: 'Baixo', medium: 'Médio', high: 'Alto', critical: 'Crítico' };

function fmtBRL(v) {
  if (v == null || v === '' || isNaN(Number(v))) return null;
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2 });
}
function fmtNum(v) {
  if (v == null || v === '' || isNaN(Number(v))) return null;
  return Number(v).toLocaleString('pt-BR');
}
function fmtPct(v, d = 1) {
  if (v == null || v === '' || isNaN(Number(v))) return null;
  return `${Number(v).toFixed(d)}%`;
}

function pickNum(raw, keys) {
  for (const k of keys) {
    const v = raw?.[k];
    if (v != null && v !== '' && !isNaN(Number(v))) return Number(v);
  }
  return null;
}
function pickStr(raw, keys) {
  for (const k of keys) {
    const v = raw?.[k];
    if (v != null && `${v}`.trim()) return `${v}`.trim();
  }
  return null;
}

function dirVerb(direction, changePct) {
  const d = String(direction || '').toLowerCase();
  const sign = Number(changePct) || 0;
  if (d.includes('increase') || sign > 0) return { verb: 'Aumentar', tone: 'text-emerald-600' };
  if (d.includes('decrease') || sign < 0) return { verb: 'Reduzir', tone: 'text-rose-600' };
  if (d === 'unchanged' || d === 'restore') return { verb: 'Restaurar', tone: 'text-sky-600' };
  return { verb: 'Ajustar', tone: 'text-slate-600' };
}

function actionKind(raw) {
  const dt = String(raw?.decision_type || raw?.action || '').toLowerCase();
  if (dt.includes('pause')) return 'pause';
  if (dt.includes('activ') || dt.includes('reactivat')) return 'activate';
  if (dt.includes('budget')) return 'budget';
  if (dt.includes('placement')) return 'placement';
  if (dt.includes('bid') || dt.includes('negative') === false) return 'bid';
  return 'other';
}

function buildObjective(kind, sub) {
  const head = {
    pause: 'PROTEÇÃO',
    activate: 'CRESCIMENTO',
    budget: 'ALOCAÇÃO',
    placement: 'VISIBILIDADE',
    bid: 'PROFITABILITY',
    other: 'OTIMIZAÇÃO',
  }[kind] || 'OTIMIZAÇÃO';
  const tail = {
    pause: 'conter perda enquanto o termo é reavaliado',
    activate: 'restaurar exposição do anúncio',
    budget: 'reequilibrar o orçamento da campanha',
    placement: 'ajustar a posição no leilão',
    bid: 'reduzir desperdício mantendo a keyword ativa para aprendizado',
    other: 'refinar a operação do motor',
  }[kind] || 'refinar a operação do motor';
  return `${head}: ${sub || tail}`;
}

function buildDiagnosis(raw) {
  const name = pickStr(raw, ['keyword_text', 'keyword', 'campaign_name', 'entity_name', 'term', 'normalized_term']);
  const clicks = pickNum(raw, ['clicks', 'historical_clicks', 'raw_clicks', 'mature_clicks']);
  const spend = pickNum(raw, ['spend', 'spend_before', 'historical_spend']);
  const orders = pickNum(raw, ['orders', 'same_sku_orders', 'historical_orders']);
  const parts = [];
  if (name) parts.push(`"${name}"`);
  if (clicks != null) parts.push(`acumulou ${fmtNum(clicks)} ${clicks === 1 ? 'clique' : 'cliques'}`);
  if (spend != null) parts.push(`${fmtBRL(spend)}`);
  if (orders != null) parts.push(orders > 0 ? `com ${fmtNum(orders)} ${orders === 1 ? 'pedido' : 'pedidos'}` : 'sem nenhum pedido');
  if (parts.length < 2) return null;
  return parts.join(' ').replace(/^(.*?)" /, '"$1 ');
}

function buildEvaluation(raw) {
  const mw = pickStr(raw, ['metric_window', 'decision_window', 'baseline_window']);
  const dw = pickNum(raw, ['data_window_days']);
  if (!mw && !dw) return null;
  if (mw && /72h|horas/i.test(mw)) return 'Dados anteriores à janela de 72h de atribuição';
  if (mw && /(\d+)d/i.test(mw)) {
    const n = RegExp.$1;
    return `Dados consolidados da janela de ${n} dias`;
  }
  if (dw) return `Dados consolidados da janela de ${dw} dia${dw === 1 ? '' : 's'}`;
  return mw ? `Janela de referência: ${mw}` : null;
}

function buildEvidence(raw) {
  const cells = [];
  const add = (label, v) => { if (v != null) cells.push({ label, value: v }); };
  add('Cliques', fmtNum(pickNum(raw, ['clicks', 'historical_clicks', 'raw_clicks', 'mature_clicks'])));
  add('Spend', fmtBRL(pickNum(raw, ['spend', 'spend_before', 'historical_spend'])));
  add('Pedidos', fmtNum(pickNum(raw, ['orders', 'same_sku_orders', 'historical_orders'])));
  add('Vendas', fmtBRL(pickNum(raw, ['sales', 'sales_before', 'historical_sales'])));
  add('ACoS', fmtPct(pickNum(raw, ['acos', 'acos_before', 'current_acos'])));
  add('CPC', fmtBRL(pickNum(raw, ['cpc', 'current_cpc', 'average_cpc_before', 'historical_cpc'])));
  add('ROAS', (() => { const r = pickNum(raw, ['roas', 'roas_before']); return r != null ? `${r.toFixed(2)}x` : null; })());
  add('Maturidade', pickStr(raw, ['maturity', 'attribution_confidence', 'decision_confidence_level'])?.toUpperCase?.() || null);
  const conf = pickNum(raw, ['confidence', 'ai_confidence', 'decision_confidence_level']);
  add('Confiança', conf != null ? `${Math.round(conf)}%` : null);
  return cells.filter(c => c.value != null);
}

function buildRecommendedAction(raw) {
  const kind = actionKind(raw);
  const oldV = pickNum(raw, ['old_bid', 'bid_before', 'value_before', 'current_value']);
  const newV = pickNum(raw, ['new_bid', 'bid_after', 'value_after', 'proposed_value']);
  const chg = pickNum(raw, ['change_percent', 'change_pct', 'change_percent']);
  const dir = pickStr(raw, ['direction']);
  const { verb } = dirVerb(dir, chg);
  if (kind === 'bid' && oldV != null && newV != null) {
    const pctTxt = chg != null ? ` ${Math.abs(Math.round(chg))}%` : '';
    return `${verb} bid${pctTxt}: de ${fmtBRL(oldV)} para ${fmtBRL(newV)}`;
  }
  if (kind === 'budget' && oldV != null && newV != null) {
    const pctTxt = chg != null ? ` ${Math.abs(Math.round(chg))}%` : '';
    return `Ajustar orçamento${pctTxt}: de ${fmtBRL(oldV)} para ${fmtBRL(newV)}`;
  }
  if (kind === 'pause') return 'Pausar a campanha';
  if (kind === 'activate') return 'Reativar a campanha';
  if (kind === 'placement') return `Ajustar placement: ${pickStr(raw, ['entity_name', 'rationale']) || 'top-of-search / other'}`;
  const act = pickStr(raw, ['action', 'decision_type']);
  return act ? `${verb} ${act}` : null;
}

function buildMoment(raw) {
  const block = pickStr(raw, ['block_name', 'stop_type', 'execution_mode', 'queue_window']);
  const scheduled = pickStr(raw, ['scheduled_for', 'execute_before', 'not_before']);
  if (block && /night|next_day|next morning|amanha/i.test(block)) return 'Início do próximo dia';
  if (block && /morning|imediato|exec_now/i.test(block)) return 'Imediato';
  if (scheduled) {
    const d = new Date(scheduled);
    if (!isNaN(d.getTime())) return `Agendado para ${d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`;
  }
  if (block) return block;
  return 'Assim que confirmado pela Amazon';
}

function buildWhyThis(raw) {
  const r = pickStr(raw, ['rationale', 'reason', 'evidence', 'reason_code']);
  if (r) return r;
  const kind = actionKind(raw);
  return {
    pause: 'A campanha não gera retorno proporcional ao gasto; a pausa interrompe a perda enquanto o histórico é reavaliado.',
    activate: 'A campanha está pronta para voltar à exposição e capturar conversões com o termo relevante.',
    budget: 'O gasto atual está desalinhado com a meta do dia; o ajuste mantém o ritmo sem estourar o limite.',
    placement: 'O leilão atual favorece outro posicionamento para maximizar retorno por impressão.',
    bid: 'A redução preserva a possibilidade de conversão a custo menor enquanto a maturidade da keyword amadurece.',
    other: 'A ação ajusta o equilíbrio entre gasto e retorno sem descartar o histórico de aprendizado.',
  }[kind] || null;
}

function buildWhyNot(raw) {
  const kind = actionKind(raw);
  return {
    pause: 'Uma redução gradual não conteria a perda a tempo; manter ativo prolongaria o desperdício; arquivar eliminaria todo o histórico acumulado.',
    activate: 'Aguardar prolongaria a perda de vendas num termo que já demonstrou relevância; reduzir o bid agora seria contraditório.',
    budget: 'Manter o orçamento atual estoura o limite diário; cortar a campanha perde todo o histórico de conversão.',
    placement: 'Manter o placement atual desperdiça gasto em posições de baixo retorno; pausar elimina exposição necessária.',
    bid: 'Negativar neste estágio seria prematuro (pode haver conversões sazonais). Pausar elimina dados futuros. Manter o bid atual aumenta o desperdício.',
    other: 'Qualquer ação mais agressiva descartaria o aprendizado acumulado; manter inalterado prolonga o desvio.',
  }[kind] || null;
}

function buildExpectedOutcome(raw) {
  const kind = actionKind(raw);
  const impact = pickNum(raw, ['expected_impact_pct', 'expected_impact_value']);
  const base = {
    pause: 'Interromper imediatamente a sangria de orçamento enquanto mantém o histórico para decisão futura.',
    activate: 'Restaurar impressões e capturar conversões com o termo já validado.',
    budget: 'Reenquadrar o gasto dentro do limite diário sem perder exposição nas faixas de pico.',
    placement: 'Maximizar retorno por impressão na posição mais eficiente do leilão.',
    bid: 'Manter impressões e cliques a custo reduzido, possibilitando avaliação futura a frequência sustentável.',
    other: 'Refinar a operação sem descartar o histórico de aprendizado.',
  }[kind] || null;
  if (impact != null && base) return `${base} (impacto estimado: ${Math.abs(Math.round(impact))}%).`;
  return base;
}

function buildEvaluationDate(raw) {
  const nd = pickNum(raw, ['next_review_days']);
  if (nd != null) return `Em ${nd} ${nd === 1 ? 'dia' : 'dias'}`;
  const next = pickStr(raw, ['next_evaluation_at', 'cooldown_until', 'next_review_at', 'next_retry_at']);
  if (next) {
    const d = new Date(next);
    if (!isNaN(d.getTime())) return `Em ${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}`;
  }
  return 'Em 7 dias';
}

function buildSuccessCriteria(raw) {
  const kind = actionKind(raw);
  const tgt = pickNum(raw, ['target_acos', 'threshold_value']);
  if (kind === 'bid') {
    return `ACoS abaixo de ${Math.round(tgt || 60)}% após a redução, ou primeiros pedidos surgindo.`;
  }
  if (kind === 'pause') return 'Sem gasto residual até a reavaliação; histórico preservado para decisão de retomada.';
  if (kind === 'activate') return 'Retorno de impressões e pelo menos um pedido no primeiro ciclo.';
  if (kind === 'budget') return `Gasto diário dentro do limite sem perda de cobertura nas janelas de pico.`;
  if (kind === 'placement') return 'ROAS por impressão superior ao placement anterior.';
  return 'Indicador-alvo dentro da meta configurada.';
}

function buildRollbackCriteria(raw) {
  const kind = actionKind(raw);
  if (kind === 'bid') return 'Reverter se impressões caírem > 80% (indicando bid abaixo do mínimo competitivo).';
  if (kind === 'pause') return 'Reativar quando o termo voltar a ter estoque / suporte de marketplace e sinais de demanda.';
  if (kind === 'activate') return 'Pausar novamente se nas primeiras 72h não houver nem cliques nem conversão.';
  if (kind === 'budget') return 'Reajustar se a campanha ficar subutilizada (< 60% do limite) ou estourar o teto.';
  if (kind === 'placement') return 'Voltar ao placement anterior se o ROAS cair > 20% na nova posição.';
  return 'Reverter se o indicador-alvo piorar em mais de 20% após a mudança.';
}

function Row({ icon: Icon, label, children, tone = 'slate' }) {
  const labelTone = {
    slate: 'text-slate-500',
    rose: 'text-rose-600',
    emerald: 'text-emerald-600',
    amber: 'text-amber-600',
    sky: 'text-sky-600',
  }[tone] || 'text-slate-500';
  return (
    <div className="flex gap-2.5 py-1.5">
      <Icon className={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${labelTone}`} />
      <div className="min-w-0 flex-1">
        <span className={`text-[10px] font-semibold uppercase tracking-wide ${labelTone}`}>{label}</span>
        <div className="text-[12px] text-slate-700 leading-relaxed mt-0.5">{children}</div>
      </div>
    </div>
  );
}

function EvidencePill({ label, value }) {
  return (
    <div className="px-2 py-1 rounded-md bg-slate-50 border border-slate-200">
      <span className="text-[9px] text-slate-400 uppercase tracking-wide">{label}</span>
      <span className="ml-1 text-[11px] font-semibold text-slate-700 font-mono">{value}</span>
    </div>
  );
}

/**
 * DecisionColloquy — painel expandível que explica o racional de uma decisão
 * do motor em linguagem natural e estruturada (Objetivo, Diagnóstico, Evidências,
 * Ação, Momento, Por quê, Risco, Resultado, Avaliação, Critérios).
 */
export default function DecisionColloquy({ raw }) {
  const data = useMemo(() => {
    if (!raw) return null;
    const kind = actionKind(raw);
    const objective = buildObjective(kind, null);
    const diagnosis = buildDiagnosis(raw);
    const evaluation = buildEvaluation(raw);
    const evidence = buildEvidence(raw);
    const action = buildRecommendedAction(raw);
    const moment = buildMoment(raw);
    const whyThis = buildWhyThis(raw);
    const whyNot = buildWhyNot(raw);
    const risk = pickStr(raw, ['risk', 'risk_level']);
    const conf = pickNum(raw, ['confidence', 'ai_confidence']);
    const expected = buildExpectedOutcome(raw);
    const evalDate = buildEvaluationDate(raw);
    const success = buildSuccessCriteria(raw);
    const rollback = buildRollbackCriteria(raw);
    return { kind, objective, diagnosis, evaluation, evidence, action, moment, whyThis, whyNot, risk, conf, expected, evalDate, success, rollback };
  }, [raw]);

  if (!data) return null;

  return (
    <div className="mt-3 pt-3 border-t border-[var(--border-color)] space-y-0.5">
      <Row icon={Target} label="Objetivo" tone={data.kind === 'pause' ? 'rose' : data.kind === 'activate' ? 'emerald' : 'sky'}>
        {data.objective}
      </Row>
      {data.diagnosis && (
        <Row icon={Stethoscope} label="Diagnóstico">{data.diagnosis}</Row>
      )}
      {data.evaluation && (
        <Row icon={Gauge} label="Avaliação de atribuição" tone="amber">{data.evaluation}</Row>
      )}
      {data.evidence?.length > 0 && (
        <Row icon={ListChecks} label="Evidências">
          <div className="flex flex-wrap gap-1.5">
            {data.evidence.map(c => <EvidencePill key={c.label} label={c.label} value={c.value} />)}
          </div>
        </Row>
      )}
      {data.action && (
        <Row icon={ArrowRight} label="Ação recomendada" tone="sky">{data.action}</Row>
      )}
      <Row icon={CalendarClock} label="Momento">{data.moment}</Row>
      {data.whyThis && (
        <Row icon={Lightbulb} label="Por que essa ação">{data.whyThis}</Row>
      )}
      {data.whyNot && (
        <Row icon={Ban} label="Por que não outra ação" tone="rose">{data.whyNot}</Row>
      )}
      {data.risk && (data.conf != null) ? (
        <Row icon={ShieldCheck} label="Risco & confiança" tone={data.risk === 'low' ? 'emerald' : data.risk === 'high' || data.risk === 'critical' ? 'rose' : 'amber'}>
          {RISK_LETTER[data.risk] || data.risk}. Confiança: {Math.round(data.conf)}%
        </Row>
      ) : null}
      {data.expected && (
        <Row icon={TrendingUp} label="Resultado esperado" tone="emerald">{data.expected}</Row>
      )}
      <Row icon={Clock3} label="Avaliação">{data.evalDate}</Row>
      <Row icon={CheckCircle2} label="Critério de sucesso" tone="emerald">{data.success}</Row>
      <Row icon={AlertTriangle} label="Critério de rollback" tone="amber">{data.rollback}</Row>
    </div>
  );
}