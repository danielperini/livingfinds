import { useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import {
  AlertTriangle,
  CheckCircle,
  ChevronRight,
  Loader2,
  Rocket,
  X,
  XCircle,
} from 'lucide-react';

function parseKeywords(value) {
  const received = value
    .split(/[\n,;]+/)
    .map(item => item.trim())
    .filter(Boolean);

  const valid = [];
  const duplicates = [];
  const invalid = [];
  const seen = new Set();

  for (const rawItem of received) {
    const text = rawItem
      .replace(/^[\s\d.\-*\u2022+\u2023\u25E6]+/, '')
      .trim();

    if (!text || text.length > 100) {
      if (text) invalid.push(text);
      continue;
    }

    const normalized = text
      .toLowerCase()
      .replace(/\s+/g, ' ');

    if (seen.has(normalized)) {
      duplicates.push(text);
      continue;
    }

    seen.add(normalized);
    valid.push(text);
  }

  return {
    original_count: received.length,
    valid_count: valid.length,
    duplicate_count: duplicates.length,
    invalid_count: invalid.length,
    valid,
    duplicates,
    invalid,
  };
}

export default function AcceleratorModal({
  product,
  account,
  onClose,
  onDone,
}) {
  const [step, setStep] = useState('keywords');
  const [keywordsRaw, setKeywordsRaw] = useState('');
  const [validation, setValidation] = useState(null);
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const parsed = useMemo(() => {
    if (!keywordsRaw.trim()) return null;

    return parseKeywords(keywordsRaw);
  }, [keywordsRaw]);

  const validating =
    step === 'validate' &&
    validation?.loading === true;

  const canValidate =
    Boolean(parsed?.valid_count) &&
    Boolean(account?.id) &&
    Boolean(product?.asin) &&
    !validating;

  const validate = async () => {
    if (validating) return;

    if (!parsed || parsed.valid_count === 0) {
      setError('Insira pelo menos uma palavra-chave válida.');
      return;
    }

    if (!account?.id) {
      setError(
        'Conta Amazon não identificada. Atualize a página e tente novamente.'
      );
      return;
    }

    if (!product?.asin) {
      setError('Produto sem ASIN válido.');
      return;
    }

    setError(null);
    setValidation({
      loading: true,
      passed: false,
      blocks: [],
      alerts: [],
      warnings: [],
    });

    /*
     * Correção principal:
     * muda imediatamente para a etapa de validação.
     */
    setStep('validate');

    try {
      const response = await base44.functions.invoke(
        'validateAdGroupCreation',
        {
          amazon_account_id: account.id,
          asin: product.asin,
          sku: product.sku || null,
          keywords: parsed.valid,
          match_type: 'exact',
          campaign_type: 'SP',
          targeting_type: 'MANUAL',
        }
      );

      const data = response?.data;

      if (!data?.ok) {
        setValidation({
          loading: false,
          passed: false,
          blocks: [],
          alerts: [],
          warnings: [],
          error:
            data?.error ||
            data?.message ||
            'A validação não pôde ser concluída.',
        });

        return;
      }

      const blocks =
        data.validations?.blocks || [];

      const alerts =
        data.validations?.alerts || [];

      const warnings =
        data.validations?.warnings || [];

      setValidation({
        loading: false,
        passed: blocks.length === 0,
        blocks,
        alerts,
        warnings,
        checks:
          data.validations?.checks || {},
        duplicate:
          data.validations?.existing_campaign || null,
        sku_conflict:
          data.validations?.sku_conflict || null,
      });
    } catch (requestError) {
      setValidation({
        loading: false,
        passed: false,
        blocks: [],
        alerts: [],
        warnings: [],
        error:
          requestError?.message ||
          'Falha ao validar as palavras-chave.',
      });
    }
  };

  const createCampaign = async () => {
    if (creating) return;

    if (!account?.id) {
      setError('Conta Amazon não identificada.');
      return;
    }

    if (!product?.asin) {
      setError('Produto sem ASIN válido.');
      return;
    }

    if (!parsed?.valid_count) {
      setError('Nenhuma palavra-chave válida foi encontrada.');
      return;
    }

    setCreating(true);
    setError(null);
    setStep('creating');

    try {
      const response = await base44.functions.invoke(
        'createAcceleratorCampaign',
        {
          amazon_account_id: account.id,
          asin: product.asin,
          sku: product.sku || null,
          product_name:
            product.product_name ||
            product.display_name ||
            product.asin,
          keywords_raw: parsed.valid.join('\n'),
          keywords: parsed.valid,
          mode: 'assisted',
        }
      );

      const data = response?.data;

      if (!data?.ok) {
        setError(
          data?.error ||
          data?.message ||
          'Não foi possível criar a campanha.'
        );

        setStep('preview');
        return;
      }

      setResult(data);
      setStep('done');

      onDone?.();
    } catch (requestError) {
      setError(
        requestError?.message ||
        'Falha ao criar a campanha.'
      );

      setStep('preview');
    } finally {
      setCreating(false);
    }
  };

  const returnToKeywords = () => {
    setValidation(null);
    setError(null);
    setStep('keywords');
  };

  const proceedToPreview = () => {
    setError(null);
    setStep('preview');
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget && !creating) {
          onClose();
        }
      }}
    >
      <div className="bg-surface-1 border border-surface-2 rounded-2xl w-full max-w-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-2 flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
              <Rocket className="w-5 h-5 text-cyan" />
            </div>

            <div>
              <h2 className="text-sm font-bold text-white">
                Acelerador de Campanhas
              </h2>

              <p className="text-xs text-slate-400 font-mono">
                {product?.asin || 'Sem ASIN'}
                {product?.sku
                  ? ` · ${product.sku}`
                  : ''}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            disabled={creating}
            aria-label="Fechar"
            className="text-slate-500 hover:text-white transition-colors disabled:opacity-40"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex items-center gap-2 px-6 py-3 bg-surface-2/40 border-b border-surface-2 flex-shrink-0 overflow-x-auto">
          <StepBadge
            active={step === 'keywords'}
            completed={[
              'validate',
              'preview',
              'creating',
              'done',
            ].includes(step)}
            label="1. Keywords"
          />

          <ChevronRight className="w-3 h-3 text-slate-600 flex-shrink-0" />

          <StepBadge
            active={step === 'validate'}
            completed={[
              'preview',
              'creating',
              'done',
            ].includes(step)}
            label="2. Validar"
          />

          <ChevronRight className="w-3 h-3 text-slate-600 flex-shrink-0" />

          <StepBadge
            active={step === 'preview'}
            completed={[
              'creating',
              'done',
            ].includes(step)}
            label="3. Prévia"
          />

          <ChevronRight className="w-3 h-3 text-slate-600 flex-shrink-0" />

          <StepBadge
            active={step === 'creating'}
            completed={step === 'done'}
            label="4. Criar"
          />

          <ChevronRight className="w-3 h-3 text-slate-600 flex-shrink-0" />

          <StepBadge
            active={step === 'done'}
            completed={false}
            label="5. Concluído"
          />
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {step === 'keywords' && (
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-white mb-1">
                  Palavras-chave
                </h3>

                <p className="text-xs text-slate-500">
                  Cole uma palavra-chave por linha ou separe por
                  vírgula ou ponto e vírgula.
                </p>
              </div>

              <textarea
                value={keywordsRaw}
                onChange={(event) => {
                  setKeywordsRaw(event.target.value);
                  setError(null);
                  setValidation(null);
                }}
                placeholder={
                  'lixeira automática\n' +
                  'lixeira inteligente 13 litros\n' +
                  'lixeira com sensor de aproximação'
                }
                className="w-full h-48 px-4 py-3 bg-surface-2 border border-surface-3 rounded-xl text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan/50 resize-none font-mono"
              />

              {parsed && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <MetricCard
                    label="Recebidas"
                    value={parsed.original_count}
                    variant="default"
                  />

                  <MetricCard
                    label="Válidas"
                    value={parsed.valid_count}
                    variant="success"
                  />

                  <MetricCard
                    label="Duplicadas"
                    value={parsed.duplicate_count}
                    variant="warning"
                  />

                  <MetricCard
                    label="Inválidas"
                    value={parsed.invalid_count}
                    variant="error"
                  />
                </div>
              )}

              {error && (
                <Notice
                  type="error"
                  title="Não foi possível validar"
                  message={error}
                />
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors"
                >
                  Cancelar
                </button>

                <button
                  type="button"
                  onClick={validate}
                  disabled={!canValidate}
                  className="flex items-center gap-2 px-5 py-2 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Validar

                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {step === 'validate' &&
            validation?.loading && (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <Loader2 className="w-9 h-9 text-cyan animate-spin" />

                <p className="text-sm font-semibold text-white">
                  Validando palavras-chave
                </p>

                <p className="text-xs text-slate-500">
                  Verificando conta, produto, estrutura e possíveis
                  duplicações.
                </p>
              </div>
            )}

          {step === 'validate' &&
            validation &&
            !validation.loading && (
              <div className="space-y-4">
                {validation.error && (
                  <Notice
                    type="error"
                    title="Erro na validação"
                    message={validation.error}
                  />
                )}

                {validation.blocks?.map(
                  (block, index) => (
                    <Notice
                      key={`block-${index}`}
                      type="error"
                      title={`Bloqueio${
                        block?.field
                          ? `: ${block.field}`
                          : ''
                      }`}
                      message={
                        block?.message ||
                        String(block)
                      }
                    />
                  )
                )}

                {validation.alerts?.map(
                  (alert, index) => (
                    <Notice
                      key={`alert-${index}`}
                      type="warning"
                      title={`Alerta${
                        alert?.field
                          ? `: ${alert.field}`
                          : ''
                      }`}
                      message={
                        alert?.message ||
                        String(alert)
                      }
                    />
                  )
                )}

                {validation.warnings?.map(
                  (warning, index) => (
                    <Notice
                      key={`warning-${index}`}
                      type="warning"
                      title="Aviso"
                      message={
                        warning?.message ||
                        String(warning)
                      }
                    />
                  )
                )}

                {validation.duplicate && (
                  <Notice
                    type="warning"
                    title="Campanha já existente"
                    message={
                      validation.duplicate
                        ?.campaign_name
                        ? `Já existe a campanha ${validation.duplicate.campaign_name}.`
                        : 'Foi encontrada uma campanha equivalente para este produto.'
                    }
                  />
                )}

                {validation.sku_conflict && (
                  <Notice
                    type="warning"
                    title="Conflito de SKU"
                    message="O ASIN possui mais de um SKU associado. Revise o SKU antes de continuar."
                  />
                )}

                {validation.passed && (
                  <Notice
                    type="success"
                    title="Validação concluída"
                    message={`${parsed.valid_count} palavras-chave estão prontas para a próxima etapa.`}
                  />
                )}

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={returnToKeywords}
                    className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors"
                  >
                    Voltar
                  </button>

                  {validation.passed && (
                    <button
                      type="button"
                      onClick={proceedToPreview}
                      className="flex items-center gap-2 px-5 py-2 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg"
                    >
                      Continuar

                      <ChevronRight className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            )}

          {step === 'preview' && (
            <div className="space-y-4">
              <div className="bg-surface-2 rounded-xl p-4 border border-surface-3">
                <h3 className="text-sm font-semibold text-white mb-4">
                  Prévia da campanha
                </h3>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                  <PreviewField
                    label="Produto"
                    value={
                      product?.product_name ||
                      product?.display_name ||
                      product?.asin
                    }
                  />

                  <PreviewField
                    label="ASIN"
                    value={product?.asin || 'N/A'}
                  />

                  <PreviewField
                    label="SKU"
                    value={product?.sku || 'N/A'}
                  />

                  <PreviewField
                    label="Correspondência"
                    value="Exata"
                  />

                  <PreviewField
                    label="Palavras-chave"
                    value={String(
                      parsed?.valid_count || 0
                    )}
                  />

                  <PreviewField
                    label="Moeda"
                    value="BRL — Real brasileiro"
                  />
                </div>
              </div>

              <div className="bg-surface-2 rounded-xl p-4 border border-surface-3">
                <p className="text-xs text-slate-500 font-semibold mb-3">
                  Palavras-chave que serão processadas
                </p>

                <div className="max-h-48 overflow-y-auto space-y-1.5">
                  {parsed?.valid.map(
                    (keyword) => (
                      <div
                        key={keyword}
                        className="flex items-center gap-2 bg-surface-3 rounded-lg px-3 py-2"
                      >
                        <CheckCircle className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />

                        <span className="text-xs text-slate-300">
                          {keyword}
                        </span>
                      </div>
                    )
                  )}
                </div>
              </div>

              {error && (
                <Notice
                  type="error"
                  title="Erro"
                  message={error}
                />
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={returnToKeywords}
                  className="px-4 py-2 text-sm text-slate-400 hover:text-white"
                >
                  Voltar
                </button>

                <button
                  type="button"
                  onClick={createCampaign}
                  disabled={creating}
                  className="flex items-center gap-2 px-5 py-2 bg-emerald-500 hover:bg-emerald-400 text-white text-sm font-semibold rounded-lg disabled:opacity-50"
                >
                  {creating ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Rocket className="w-4 h-4" />
                  )}

                  {creating
                    ? 'Criando...'
                    : 'Criar campanha'}
                </button>
              </div>
            </div>
          )}

          {step === 'creating' && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <Loader2 className="w-10 h-10 text-cyan animate-spin" />

              <p className="text-sm font-semibold text-white">
                Processando campanha
              </p>

              <p className="text-xs text-slate-500 text-center">
                A criação está sendo enviada ao backend do Base44.
              </p>
            </div>
          )}

          {step === 'done' && result && (
            <div className="space-y-4">
              <Notice
                type="success"
                title="Campanha processada"
                message={`${
                  result.keywords_created ||
                  parsed?.valid_count ||
                  0
                } palavras-chave foram processadas.`}
              />

              <div className="bg-surface-2 border border-surface-3 rounded-xl p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
                <PreviewField
                  label="Campanha"
                  value={
                    result.campaign_name ||
                    'Campanha criada'
                  }
                />

                <PreviewField
                  label="Campaign ID"
                  value={
                    result.campaign_id ||
                    'Aguardando sincronização'
                  }
                />

                <PreviewField
                  label="Orçamento"
                  value={
                    result.daily_budget
                      ? `R$ ${Number(
                          result.daily_budget
                        ).toFixed(2)}`
                      : 'Conforme configuração'
                  }
                />

                <PreviewField
                  label="Bid inicial"
                  value={
                    result.initial_bid
                      ? `R$ ${Number(
                          result.initial_bid
                        ).toFixed(2)}`
                      : 'Conforme configuração'
                  }
                />
              </div>

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-5 py-2 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-sm font-semibold rounded-lg"
                >
                  Fechar
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StepBadge({
  label,
  active,
  completed,
}) {
  return (
    <span
      className={`text-xs font-semibold px-2 py-1 rounded-full whitespace-nowrap ${
        active
          ? 'bg-cyan text-white'
          : completed
            ? 'bg-emerald-500/20 text-emerald-400'
            : 'bg-surface-3 text-slate-500'
      }`}
    >
      {label}
    </span>
  );
}

function MetricCard({
  label,
  value,
  variant,
}) {
  const styles = {
    default:
      'bg-surface-2 border-surface-3 text-white',
    success:
      'bg-emerald-400/10 border-emerald-400/20 text-emerald-400',
    warning:
      'bg-amber-400/10 border-amber-400/20 text-amber-400',
    error:
      'bg-red-400/10 border-red-400/20 text-red-400',
  };

  return (
    <div
      className={`rounded-xl p-3 border ${styles[variant]}`}
    >
      <p className="text-xs opacity-80">
        {label}
      </p>

      <p className="text-lg font-bold">
        {value}
      </p>
    </div>
  );
}

function PreviewField({
  label,
  value,
}) {
  return (
    <div className="bg-surface-3 rounded-lg px-3 py-2">
      <p className="text-[10px] text-slate-500 mb-1">
        {label}
      </p>

      <p className="text-xs text-slate-200 break-words">
        {value || '—'}
      </p>
    </div>
  );
}

function Notice({
  type,
  title,
  message,
}) {
  const config = {
    error: {
      wrapper:
        'bg-red-400/10 border-red-400/20',
      title: 'text-red-300',
      text: 'text-red-400/80',
      icon: XCircle,
    },
    warning: {
      wrapper:
        'bg-amber-400/10 border-amber-400/20',
      title: 'text-amber-300',
      text: 'text-amber-400/80',
      icon: AlertTriangle,
    },
    success: {
      wrapper:
        'bg-emerald-400/10 border-emerald-400/20',
      title: 'text-emerald-300',
      text: 'text-emerald-400/80',
      icon: CheckCircle,
    },
  }[type];

  const Icon = config.icon;

  return (
    <div
      className={`flex items-start gap-3 px-4 py-3 border rounded-xl ${config.wrapper}`}
    >
      <Icon
        className={`w-5 h-5 flex-shrink-0 mt-0.5 ${config.title}`}
      />

      <div>
        <p
          className={`text-sm font-semibold ${config.title}`}
        >
          {title}
        </p>

        <p
          className={`text-xs mt-1 ${config.text}`}
        >
          {message}
        </p>
      </div>
    </div>
  );
}
