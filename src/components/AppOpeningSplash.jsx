/**
 * AppOpeningSplash
 *
 * Tela de abertura exibida por ~4s no acesso/reload da aplicação.
 * Apenas lê dados persistidos — NÃO executa sync, report, download ou Autopilot.
 *
 * Controle por sessão: sessionStorage key livingfinds_boot_splash_seen:{userId}:{accountId}
 * Reaparece ao recarregar a página (sessionStorage é zerado no reload quando não há tab opener).
 */
import { useState, useEffect, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { Zap } from 'lucide-react';

// ── Utilitários ───────────────────────────────────────────────────────────────

function getGreeting() {
  const h = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false });
  const hour = parseInt(h, 10);
  if (hour >= 5 && hour < 12) return 'Bom dia';
  if (hour >= 12 && hour < 18) return 'Boa tarde';
  return 'Boa noite';
}

function getFirstName(user) {
  if (!user) return '';
  const full = user.full_name || user.name || user.first_name || '';
  const first = full.trim().split(/\s+/)[0];
  if (first) return first;
  // fallback: parte antes do @ no email
  return (user.email || '').split('@')[0] || 'você';
}

function getAccountName(account) {
  return account?.display_name || account?.seller_name || account?.account_name || 'Conta Amazon';
}

function fmtLastSync(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const time = d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  return isToday ? `hoje às ${time}` : d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const STEPS = [
  { label: 'Carregando sua conta', pct: 10 },
  { label: 'Atualizando produtos', pct: 30 },
  { label: 'Atualizando campanhas', pct: 55 },
  { label: 'Atualizando métricas', pct: 80 },
  { label: 'Preparando seu painel', pct: 95 },
];

const TOTAL_MS = 4000;
const FADE_IN_MS = 500;
const FADE_OUT_START_MS = 3200;
const FADE_OUT_MS = 800;
const SAFETY_TIMEOUT_MS = 5000;

// ── Componente principal ──────────────────────────────────────────────────────

export default function AppOpeningSplash({ onComplete }) {
  const [phase, setPhase] = useState('fadein'); // fadein | visible | fadeout
  const [progress, setProgress] = useState(0);
  const [stepLabel, setStepLabel] = useState(STEPS[0].label);
  const [user, setUser] = useState(null);
  const [account, setAccount] = useState(null);
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [syncStatus, setSyncStatus] = useState('updated');
  const [done, setDone] = useState(false);
  const completedRef = useRef(false);

  const greeting = getGreeting();
  const firstName = getFirstName(user);
  const accountName = getAccountName(account);
  const lastSyncLabel = fmtLastSync(lastSyncAt);

  const syncStatusMsg = {
    updated: 'Dados atualizados',
    updating_background: 'Sincronização em segundo plano em andamento.',
    partial: 'Alguns dados ainda estão sendo processados. Último conjunto válido carregado.',
    stale: 'Exibindo os últimos dados disponíveis.',
    failed: 'Não foi possível verificar uma das fontes. Dados anteriores preservados.',
  }[syncStatus] || '';

  // ── Completar e chamar onComplete ─────────────────────────────────────────
  const complete = () => {
    if (completedRef.current) return;
    completedRef.current = true;
    setDone(true);
    onComplete?.();
  };

  // ── Hidratação dos dados persistidos ──────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    const hydrate = async () => {
      try {
        // 1. Usuário
        const me = await base44.auth.me();
        if (cancelled) return;
        setUser(me);
        setProgress(STEPS[0].pct);
        setStepLabel(STEPS[0].label);

        // 2. Conta Amazon (apenas leitura do banco)
        let accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id }).catch(() => []);
        if (!accounts.length) accounts = await base44.entities.AmazonAccount.filter({ status: 'connected' }, null, 1).catch(() => []);
        if (cancelled) return;
        const acc = accounts[0] || null;
        setAccount(acc);
        if (acc?.last_sync_at) setLastSyncAt(acc.last_sync_at);
        setProgress(STEPS[1].pct);
        setStepLabel(STEPS[1].label);

        // 3. Produtos (somente leitura)
        if (acc?.id) {
          await base44.entities.Product.filter({ amazon_account_id: acc.id }, null, 5).catch(() => null);
        }
        if (cancelled) return;
        setProgress(STEPS[2].pct);
        setStepLabel(STEPS[2].label);

        // 4. Campanhas (somente leitura)
        if (acc?.id) {
          await base44.entities.Campaign.filter({ amazon_account_id: acc.id }, null, 5).catch(() => null);
        }
        if (cancelled) return;
        setProgress(STEPS[3].pct);
        setStepLabel(STEPS[3].label);

        // 5. Métricas (somente leitura)
        if (acc?.id) {
          await base44.entities.CampaignMetricsDaily.filter({ amazon_account_id: acc.id }, '-date', 5).catch(() => null);
        }
        if (cancelled) return;

        // Determinar sync status real
        if (acc?.last_sync_at) {
          const ageH = (Date.now() - new Date(acc.last_sync_at).getTime()) / 3600000;
          setSyncStatus(ageH < 25 ? 'updated' : ageH < 48 ? 'stale' : 'partial');
        } else {
          setSyncStatus('stale');
        }

        setProgress(STEPS[4].pct);
        setStepLabel(STEPS[4].label);
      } catch {
        if (!cancelled) setSyncStatus('failed');
      }
    };

    hydrate();
    return () => { cancelled = true; };
  }, []);

  // ── Sequência de animação ──────────────────────────────────────────────────
  useEffect(() => {
    // Safety timeout — libera app após 5s no máximo
    const safety = setTimeout(complete, SAFETY_TIMEOUT_MS);

    // fade in → visible
    const t1 = setTimeout(() => setPhase('visible'), FADE_IN_MS);
    // progress até 100% em paralelo com a barra visual
    const t2 = setTimeout(() => setProgress(100), FADE_OUT_START_MS - 200);
    // iniciar fade out
    const t3 = setTimeout(() => setPhase('fadeout'), FADE_OUT_START_MS);
    // completo
    const t4 = setTimeout(complete, TOTAL_MS);

    return () => {
      clearTimeout(safety);
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (done) return null;

  const opacity = phase === 'fadein' ? 0 : phase === 'fadeout' ? 0 : 1;
  const transition = phase === 'fadein'
    ? `opacity ${FADE_IN_MS}ms ease-in`
    : phase === 'fadeout'
    ? `opacity ${FADE_OUT_MS}ms ease-out`
    : 'opacity 0ms';

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Carregando o LivingFinds"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        opacity,
        transition,
        background: 'var(--app-bg, #0B1120)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1.5rem',
        pointerEvents: phase === 'fadeout' ? 'none' : 'all',
      }}
    >
      <div className="flex flex-col items-center gap-6 w-full max-w-sm text-center">
        {/* Logo */}
        <div className="w-14 h-14 rounded-2xl bg-cyan/20 border border-cyan/30 flex items-center justify-center">
          <Zap className="w-7 h-7 text-cyan" />
        </div>

        {/* Saudação */}
        <div className="space-y-1">
          <p className="text-3xl font-bold text-white">
            {greeting}{firstName ? `, ${firstName}` : ''}
          </p>
          <p className="text-sm text-slate-400">
            Atualizando os dados mais recentes da sua conta Amazon
          </p>
        </div>

        {/* Nome da conta */}
        {accountName && (
          <div className="px-4 py-2 rounded-xl bg-surface-1 border border-surface-2">
            <p className="text-[11px] text-slate-500 mb-0.5">Conta</p>
            <p className="text-sm font-semibold text-white">{accountName}</p>
          </div>
        )}

        {/* Barra de progresso */}
        <div className="w-full space-y-2" aria-label={stepLabel}>
          <div className="h-1.5 bg-surface-3 rounded-full overflow-hidden">
            <div
              className="h-full bg-cyan rounded-full"
              style={{
                width: `${progress}%`,
                transition: 'width 0.6s ease-out',
              }}
            />
          </div>
          <p className="text-[11px] text-slate-500 text-left">{stepLabel}</p>
        </div>

        {/* Última sincronização */}
        {lastSyncLabel && (
          <p className="text-[11px] text-slate-600">
            Última atualização: {lastSyncLabel}
          </p>
        )}

        {/* Status de sync — só se não for "updated" */}
        {syncStatus !== 'updated' && syncStatusMsg && (
          <p className={`text-[11px] ${syncStatus === 'failed' ? 'text-amber-400' : 'text-slate-500'}`}>
            {syncStatusMsg}
          </p>
        )}
      </div>

      {/* Reduced-motion: esconder animação da barra */}
      <style>{`
        @media (prefers-reduced-motion: reduce) {
          .living-splash-bar { transition: none !important; }
        }
      `}</style>
    </div>
  );
}