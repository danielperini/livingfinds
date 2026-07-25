import { useState, useRef, useEffect } from 'react';
import { MessageCircle, X, Send, Loader2, CheckCircle, XCircle, ChevronDown } from 'lucide-react';
import { base44 } from '@/api/base44Client';

const QUICK_SUGGESTIONS = [
  'Resumo do dia',
  'Status de tokens',
  'Campanhas com ACoS alto',
  'Keywords no banco',
  'Vendas desta semana',
  'Alertas ativos',
];

function TypingIndicator() {
  return (
    <div className="flex items-end gap-2 mb-3">
      <div className="w-7 h-7 rounded-full bg-cyan/20 border border-cyan/30 flex items-center justify-center flex-shrink-0">
        <span className="text-[9px] font-bold text-cyan">AI</span>
      </div>
      <div className="bg-surface-2 border border-surface-3 rounded-2xl rounded-bl-sm px-4 py-3">
        <div className="flex gap-1 items-center h-4">
          <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
          <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
          <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
        </div>
      </div>
    </div>
  );
}

function ActionButtons({ action, onApplyNow, onSchedule, appliedState }) {
  if (!action) return null;
  if (appliedState === 'now_success') return (
    <div className="flex items-center gap-1.5 mt-2 text-xs text-emerald-400">
      <CheckCircle className="w-3.5 h-3.5" /> Aplicado com sucesso!
    </div>
  );
  if (appliedState === 'now_error') return (
    <div className="flex items-center gap-1.5 mt-2 text-xs text-red-400">
      <XCircle className="w-3.5 h-3.5" /> Erro ao aplicar. Tente novamente.
    </div>
  );
  if (appliedState === 'scheduled') return (
    <div className="flex items-center gap-1.5 mt-2 text-xs text-amber-400">
      <CheckCircle className="w-3.5 h-3.5" /> Agendado para o próximo ciclo.
    </div>
  );
  if (appliedState === 'loading') return (
    <div className="flex items-center gap-1.5 mt-2 text-xs text-slate-400">
      <Loader2 className="w-3.5 h-3.5 animate-spin" /> Executando...
    </div>
  );

  return (
    <div className="flex gap-2 mt-3 flex-wrap">
      <button
        onClick={onApplyNow}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25 transition-colors"
      >
        ⚡ Aplicar agora
      </button>
      <button
        onClick={onSchedule}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 hover:bg-amber-500/25 transition-colors"
      >
        🕐 Aplicar na próxima janela
      </button>
    </div>
  );
}

function ChatMessage({ msg, onApplyNow, onSchedule }) {
  const [appliedState, setAppliedState] = useState(null);
  const isUser = msg.role === 'user';

  const handleApplyNow = async () => {
    setAppliedState('loading');
    try {
      await onApplyNow(msg.action);
      setAppliedState('now_success');
    } catch {
      setAppliedState('now_error');
    }
  };

  const handleSchedule = async () => {
    setAppliedState('loading');
    try {
      await onSchedule(msg.action);
      setAppliedState('scheduled');
    } catch {
      setAppliedState('now_error');
    }
  };

  if (isUser) {
    return (
      <div className="flex justify-end mb-3">
        <div className="max-w-[80%] px-4 py-2.5 bg-cyan/20 border border-cyan/25 rounded-2xl rounded-br-sm">
          <p className="text-sm text-slate-100 leading-relaxed">{msg.content}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-end gap-2 mb-3">
      <div className="w-7 h-7 rounded-full bg-cyan/20 border border-cyan/30 flex items-center justify-center flex-shrink-0 mb-1">
        <span className="text-[9px] font-bold text-cyan">AI</span>
      </div>
      <div className="max-w-[85%]">
        <div className="bg-surface-2 border border-surface-3 rounded-2xl rounded-bl-sm px-4 py-3">
          <p className="text-sm text-slate-100 leading-relaxed whitespace-pre-wrap">{msg.content}</p>
        </div>
        {msg.action && (
          <div className="px-1">
            <p className="text-[10px] text-slate-500 mt-1.5 mb-1">
              Ação sugerida: <span className="text-slate-400 font-medium">{msg.action.label}</span>
            </p>
            <ActionButtons
              action={msg.action}
              onApplyNow={handleApplyNow}
              onSchedule={handleSchedule}
              appliedState={appliedState}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default function FloatingChat({ accountId }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, open, loading]);

  useEffect(() => {
    if (open && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  const sendMessage = async (text) => {
    const content = (text || input).trim();
    if (!content || loading) return;
    setInput('');

    const userMsg = { role: 'user', content };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setLoading(true);

    try {
      // Build history for API (exclude current message, already in newMessages)
      const history = newMessages.map(m => ({ role: m.role, content: m.content }));
      const res = await base44.functions.invoke('chatAssistant', {
        messages: history,
        amazon_account_id: accountId,
      });
      const data = res?.data || res;
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: data.message || 'Não consegui gerar uma resposta.',
        action: data.action || null,
      }]);
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Erro ao conectar com o assistente: ${err.message}`,
        action: null,
      }]);
    } finally {
      setLoading(false);
    }
  };

  const handleApplyNow = async (action) => {
    if (!action?.function_name) throw new Error('Função não definida');
    const payload = { ...(action.payload || {}), amazon_account_id: accountId };
    const res = await base44.functions.invoke(action.function_name, payload);
    if (res?.data?.ok === false || res?.data?.error) throw new Error(res.data.error || 'Erro');
  };

  const handleSchedule = async (action) => {
    if (!action?.function_name) throw new Error('Ação não definida');
    await base44.entities.OptimizationDecision.create({
      amazon_account_id: accountId,
      decision_type: 'strategy_change',
      entity_type: 'account',
      action: action.function_name,
      rationale: `Agendado via Chat Assistente: ${action.label}`,
      status: 'proposed',
      requires_approval: false,
      risk: 'low',
      source_function: 'chatAssistant',
      created_at: new Date().toISOString(),
      idempotency_key: `chat_schedule:${accountId}:${action.function_name}:${Date.now()}`,
    });
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const isEmpty = messages.length === 0;

  return (
    <>
      {/* Drawer */}
      {open && (
        <div className="fixed inset-0 z-[998] pointer-events-none">
          {/* Backdrop para fechar */}
          <div
            className="absolute inset-0 pointer-events-auto"
            onClick={() => setOpen(false)}
          />
          {/* Drawer */}
          <div
            className="absolute right-0 top-0 bottom-0 w-full max-w-[420px] bg-surface-1 border-l border-surface-2 flex flex-col pointer-events-auto shadow-2xl animate-fade-in"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-surface-2 flex-shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-full bg-cyan/20 border border-cyan/30 flex items-center justify-center">
                  <MessageCircle className="w-4 h-4 text-cyan" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-white">Assistente Living Finds</p>
                  <p className="text-[10px] text-slate-500">GPT-4o • Dados em tempo real</p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                {messages.length > 0 && (
                  <button
                    onClick={() => setMessages([])}
                    className="p-1.5 text-slate-500 hover:text-slate-300 rounded-lg hover:bg-surface-2 transition-colors text-xs"
                    title="Limpar conversa"
                  >
                    Limpar
                  </button>
                )}
                <button
                  onClick={() => setOpen(false)}
                  className="p-1.5 text-slate-500 hover:text-slate-300 rounded-lg hover:bg-surface-2 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 scrollbar-thin">
              {isEmpty ? (
                <div className="flex flex-col items-center justify-center h-full gap-4 text-center">
                  <div className="w-14 h-14 rounded-2xl bg-cyan/10 border border-cyan/20 flex items-center justify-center">
                    <MessageCircle className="w-7 h-7 text-cyan" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-white mb-1">Como posso ajudar?</p>
                    <p className="text-xs text-slate-500">Faça perguntas sobre suas campanhas, métricas e muito mais.</p>
                  </div>
                  <div className="grid grid-cols-2 gap-2 w-full mt-2">
                    {QUICK_SUGGESTIONS.map(s => (
                      <button
                        key={s}
                        onClick={() => sendMessage(s)}
                        className="px-3 py-2 text-xs text-slate-300 bg-surface-2 border border-surface-3 rounded-xl hover:bg-surface-3 hover:text-white transition-colors text-left"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  {messages.map((msg, i) => (
                    <ChatMessage
                      key={i}
                      msg={msg}
                      onApplyNow={handleApplyNow}
                      onSchedule={handleSchedule}
                    />
                  ))}
                  {loading && <TypingIndicator />}
                  <div ref={messagesEndRef} />
                </>
              )}
            </div>

            {/* Input */}
            <div className="p-3 border-t border-surface-2 flex-shrink-0">
              <div className="flex items-end gap-2">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Pergunte sobre campanhas, métricas..."
                  rows={1}
                  className="flex-1 px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-xl text-sm text-white placeholder-slate-600 focus:outline-none focus:border-cyan/50 resize-none scrollbar-thin"
                  style={{ maxHeight: '120px', overflowY: 'auto' }}
                  onInput={e => {
                    e.target.style.height = 'auto';
                    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
                  }}
                  disabled={loading}
                />
                <button
                  onClick={() => sendMessage()}
                  disabled={!input.trim() || loading}
                  className="w-10 h-10 flex-shrink-0 flex items-center justify-center rounded-xl bg-cyan hover:bg-cyan/90 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-[10px] text-slate-600 mt-1.5 text-center">Enter para enviar • Shift+Enter para nova linha</p>
            </div>
          </div>
        </div>
      )}

      {/* FAB */}
      <button
        onClick={() => setOpen(o => !o)}
        className={`fixed bottom-6 right-6 z-[999] w-14 h-14 rounded-full shadow-lg flex items-center justify-center transition-all duration-200 ${
          open
            ? 'bg-surface-2 border border-surface-3 text-slate-300 hover:bg-surface-3'
            : 'bg-cyan hover:bg-cyan/90 text-white shadow-cyan/20'
        }`}
        title="Assistente IA"
        aria-label="Abrir assistente"
      >
        {open ? <ChevronDown className="w-5 h-5" /> : <MessageCircle className="w-6 h-6" />}
      </button>
    </>
  );
}