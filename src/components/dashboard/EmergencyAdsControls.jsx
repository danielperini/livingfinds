import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, LoaderCircle, PauseCircle, PlayCircle, RefreshCw, ShieldAlert } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const unwrap = (response) => response?.data ?? response ?? {};
const phraseFor = (action) => action === "pause_all" ? "PAUSAR TODAS" : "REATIVAR LOTE EMERGENCIAL";
const formatTime = (value) => value ? new Date(value).toLocaleString("pt-BR") : "—";

export default function EmergencyAdsControls({ account, user, campaigns = [], onRefresh }) {
  const [dialogAction, setDialogAction] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [statusLoading, setStatusLoading] = useState(false);
  const [status, setStatus] = useState(null);
  const [result, setResult] = useState(null);
  const [message, setMessage] = useState("");

  const localActiveCounts = useMemo(() => {
    const unique = new Map();
    for (const campaign of campaigns) {
      const id = String(campaign?.campaign_id || campaign?.amazon_campaign_id || "").trim();
      const type = String(campaign?.campaign_type || "SP").toUpperCase();
      const state = String(campaign?.state || campaign?.status || campaign?.amazon_status || "").toLowerCase();
      if (!id || !["SP", "SB", "SD"].includes(type)) continue;
      const key = `${type}|${id}`;
      const prior = unique.get(key);
      const updated = String(campaign?.synced_at || campaign?.updated_date || "");
      if (!prior || updated > prior.updated) unique.set(key, { state, updated });
    }
    return [...unique.entries()].reduce((counts, [key, item]) => {
      if (item.state === "enabled") counts[key.split("|")[0]] += 1;
      return counts;
    }, { SP: 0, SB: 0, SD: 0 });
  }, [campaigns]);

  const refreshStatus = useCallback(async () => {
    if (!account?.id) return;
    setStatusLoading(true);
    try {
      const response = await base44.functions.invoke("emergencyAdsControl", {
        action: "status", amazon_account_id: account.id,
      });
      const payload = unwrap(response);
      if (response?.ok === false || payload?.ok === false) throw new Error(payload?.error || "Não foi possível consultar o lote emergencial.");
      setStatus(payload);
    } catch (error) {
      setMessage(error?.message || "Falha ao consultar o estado do controle emergencial.");
    } finally {
      setStatusLoading(false);
    }
  }, [account?.id]);

  useEffect(() => { refreshStatus(); }, [refreshStatus]);
  useEffect(() => {
    if (!busy) return undefined;
    const timer = window.setInterval(refreshStatus, 8000);
    return () => window.clearInterval(timer);
  }, [busy, refreshStatus]);

  if (!account?.id || user?.role !== "admin") return null;

  const submit = async () => {
    const action = dialogAction;
    if (!action || confirmation.trim() !== phraseFor(action)) return;
    setBusy(true);
    setResult(null);
    setMessage("Solicitação aceita pelo app. Acompanhe os estados confirmados e pendentes abaixo.");
    try {
      const response = await base44.functions.invoke("emergencyAdsControl", {
        action, amazon_account_id: account.id, confirmation: confirmation.trim(),
      });
      const payload = unwrap(response);
      setResult(payload);
      if (response?.ok === false && payload?.ok !== false) throw new Error(response?.error || "A requisição falhou.");
      if (payload?.ok === false && !payload?.status) throw new Error(payload?.error || "A operação não foi concluída.");
      const partial = payload?.status === "partial";
      setMessage(partial
        ? "Execução parcial: veja os itens confirmados, incertos e com falha. Itens incertos não serão reenviados automaticamente."
        : action === "pause_all"
          ? Number(payload.target_count || 0) === 0
            ? "A consulta completa da Amazon não encontrou campanhas ativas; nenhuma alteração foi enviada."
            : "Pausa concluída e reconciliada. A análise de métricas aparece abaixo quando os dados estavam completos."
          : Number(payload.confirmed?.length || 0) === 0
            ? "Nenhuma campanha passou pelos critérios de reativação; nada foi enviado."
            : "Lote elegível reconciliado. Campanhas sem estoque FBA recente permaneceram pausadas.");
      await refreshStatus();
      if (typeof onRefresh === "function") await onRefresh();
    } catch (error) {
      setMessage(error?.message || "A execução falhou. Consulte novamente o estado antes de tentar outra vez.");
      await refreshStatus();
    } finally {
      setBusy(false);
      setDialogAction("");
      setConfirmation("");
    }
  };

  const latest = status?.latest_pause;
  const restorableCount = Number(status?.restorable_count || 0);
  const restorableCountComplete = status?.restorable_count_complete === true;
  const liveProgress = latest?.run_state === "processing" || latest?.status === "started" || latest?.status === "processing";
  const currentResult = result?.ai_reanalysis || latest?.ai_reanalysis;
  const risks = currentResult?.analysis?.risks || [];

  return (
    <section className="rounded-xl border border-red-500/25 bg-red-950/20 p-4 space-y-3" aria-labelledby="emergency-ads-title">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex gap-3 min-w-0">
          <span className="mt-0.5 rounded-lg bg-red-500/15 p-2 text-red-300"><ShieldAlert className="h-5 w-5" /></span>
          <div className="min-w-0">
            <h2 id="emergency-ads-title" className="font-semibold text-white">Controle emergencial de anúncios</h2>
            <p className="mt-1 text-xs leading-5 text-slate-300">Pausa campanhas ativas de Sponsored Products, Sponsored Brands e Sponsored Display após leitura completa da Amazon. A reativação fica limitada ao lote deste controle e exige estoque FBA recente.</p>
            <p className="mt-1 text-[11px] text-slate-400">Ativas no cache do app: SP {localActiveCounts.SP} · SB {localActiveCounts.SB} · SD {localActiveCounts.SD}. A contagem final vem da leitura remota na confirmação.</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 shrink-0">
          <button type="button" onClick={() => { setDialogAction("pause_all"); setConfirmation(""); setMessage(""); }} disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg border border-red-400/40 bg-red-500 px-3 py-2 text-sm font-semibold text-white hover:bg-red-400 disabled:opacity-50">
            <PauseCircle className="h-4 w-4" /> Pausar todas as ativas
          </button>
          <button type="button" onClick={() => { setDialogAction("reactivate_emergency"); setConfirmation(""); setMessage(""); }} disabled={busy || !restorableCountComplete || restorableCount === 0}
            title={!restorableCountComplete ? "A leitura do estado local está incompleta; a reativação fica bloqueada." : restorableCount === 0 ? "Nenhuma campanha está marcada para restauração." : "Reativa somente campanhas pausadas por este controle e com estoque FBA recente."}
            className="inline-flex items-center gap-2 rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-sm font-semibold text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50">
            <PlayCircle className="h-4 w-4" /> {restorableCountComplete ? `Reativar lote (${restorableCount})` : "Reativar lote (contagem indisponível)"}
          </button>
          <button type="button" onClick={refreshStatus} disabled={statusLoading} aria-label="Atualizar estado do lote" className="rounded-lg border border-slate-600 px-2.5 py-2 text-slate-300 hover:bg-slate-800 disabled:opacity-50">
            <RefreshCw className={`h-4 w-4 ${statusLoading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {message ? <div role="status" className="rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-xs text-slate-200">{busy && <LoaderCircle className="mr-2 inline h-3.5 w-3.5 animate-spin" />}{message}</div> : null}
      {latest ? <div className="grid gap-2 rounded-lg border border-slate-700 bg-slate-900/60 p-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <div><span className="text-slate-400">Último lote:</span> <strong className="text-white">{latest.status}</strong></div>
        <div><span className="text-slate-400">Incertas / falhas:</span> <strong className="text-amber-300">{Number(latest.unknown_count || 0) + Number(latest.failed_count || 0)}</strong></div>
        <div><span className="text-slate-400">Confirmadas / alvo:</span> <strong className="text-emerald-300">{latest.confirmed_count || 0} / {latest.target_count || 0}</strong></div>
        <div><span className="text-slate-400">Iniciado:</span> <strong className="text-slate-200">{formatTime(latest.started_at)}</strong></div>
        {liveProgress ? <div className="sm:col-span-2 lg:col-span-4 text-amber-200">Execução em andamento; a tela consulta o registro persistente a cada 8 segundos. Não inicie outro lote.</div> : null}
        {latest.error_message ? <div role="alert" className="sm:col-span-2 lg:col-span-4 text-red-300">{latest.error_message}</div> : null}
      </div> : null}

      {currentResult?.ok && currentResult?.analysis ? <div className="rounded-lg border border-cyan-500/20 bg-cyan-950/20 p-3 text-xs text-slate-200">
        <strong className="text-cyan-200">Reanálise de métricas Ads (somente diagnóstico)</strong>
        <p className="mt-1">{currentResult.analysis.overall_assessment}</p>
        {risks.length > 0 ? <ul className="mt-2 list-disc space-y-1 pl-5">{risks.slice(0, 4).map((risk, index) => <li key={index}>{risk}</li>)}</ul> : null}
        <p className="mt-2 text-[10px] text-slate-400">Janela fechada: {currentResult.window?.join(" a ") || "—"}. Nenhuma recomendação foi executada pela IA.</p>
      </div> : currentResult?.skipped ? <p className="text-xs text-amber-200">Reanálise da IA não executada: {currentResult.reason || "dados incompletos"}.</p>
        : currentResult?.error ? <p role="alert" className="text-xs text-red-300">A pausa foi registrada, mas a reanálise da IA falhou: {currentResult.error}</p> : null}

      {status?.latest_restore ? <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-3 text-xs text-slate-300">
        Última reativação: <strong>{status.latest_restore.status}</strong> · confirmadas {status.latest_restore.confirmed_count} · incertas {status.latest_restore.unknown_count} · falhas {status.latest_restore.failed_count} · ignoradas {status.latest_restore.skipped_count}
        {status.latest_restore.error_message ? <p role="alert" className="mt-1 text-red-300">{status.latest_restore.error_message}</p> : null}
      </div> : null}

      {result && <div className="text-[11px] text-slate-400">Resultado desta solicitação: {result.status || (result.ok ? "consultado" : "sem confirmação")}; lote {result.batch_id || result.source_batch_id || "—"}. Alvo: {result.target_count ?? "—"}; verificadas individualmente: {result.confirmed?.length || 0}; incertas: {result.unknown?.length || 0}; falhas: {result.failed?.length || 0}; não elegíveis para reativar: {result.skipped?.length || 0}.</div>}

      <Dialog open={Boolean(dialogAction)} onOpenChange={(open) => { if (!open && !busy) { setDialogAction(""); setConfirmation(""); } }}>
        {dialogAction ? <DialogContent className="border-slate-600 bg-slate-950 text-white sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-amber-300" />{dialogAction === "pause_all" ? "Pausar todas as campanhas ativas?" : "Reativar lote emergencial?"}</DialogTitle>
            <DialogDescription className="text-slate-300">{dialogAction === "pause_all"
              ? "A ação pausa campanhas que a Amazon confirmar como ativas nos três formatos. Uma resposta incompleta cancela a operação antes das escritas. Cada lote será consultado novamente para confirmar o estado."
              : "Somente campanhas pausadas por este lote, ainda pausadas na Amazon e vinculadas sem ambiguidade a anúncio vendável confirmado, com estoque FBA e listagem verificados nas últimas 24 horas, serão reativadas."}</DialogDescription>
          </DialogHeader>
          <div>
            <label htmlFor="emergency-confirmation" className="text-xs text-slate-400">Para confirmar, digite <code className="rounded bg-slate-800 px-1.5 py-0.5 text-white">{phraseFor(dialogAction)}</code>.</label>
            <input id="emergency-confirmation" autoFocus value={confirmation} onChange={(event) => setConfirmation(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") submit(); }} disabled={busy}
              className="mt-2 w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400 disabled:opacity-50" />
          </div>
          <DialogFooter>
            <button type="button" onClick={() => { setDialogAction(""); setConfirmation(""); }} disabled={busy} className="rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-200 disabled:opacity-50">Cancelar</button>
            <button type="button" onClick={submit} disabled={busy || confirmation.trim() !== phraseFor(dialogAction)} className={`inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-white disabled:opacity-40 ${dialogAction === "pause_all" ? "bg-red-600 hover:bg-red-500" : "bg-emerald-600 hover:bg-emerald-500"}`}>
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : dialogAction === "pause_all" ? <PauseCircle className="h-4 w-4" /> : <PlayCircle className="h-4 w-4" />}
              {busy ? "Executando…" : dialogAction === "pause_all" ? "Confirmar pausa" : "Confirmar reativação"}
            </button>
          </DialogFooter>
        </DialogContent> : null}
      </Dialog>
    </section>
  );
}
