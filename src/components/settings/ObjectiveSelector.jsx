import { useState } from 'react';
import {
  PiggyBank, TrendingUp, Rocket, Shield, PackageX, Wrench, Zap, Boxes, Pencil, AlertTriangle,
} from 'lucide-react';
import { OBJECTIVE_PRESETS } from './objectivePresets';

const ICONS = { PiggyBank, TrendingUp, Rocket, Shield, PackageX, Wrench, Zap, Boxes, Pencil };

/**
 * ObjectiveSelector — cards de objetivos estratégicos com confirmação inline.
 * Props:
 *   objective   — valor atual (goals.objective)
 *   isCustomized — true se campos divergem do preset do objetivo base
 *   onApply(key) — aplica os valores do preset ao selecionar e confirmar
 */
export default function ObjectiveSelector({ objective, isCustomized, onApply }) {
  const [pending, setPending] = useState(null);

  const activeKey = objective || 'profitability';
  const showAsCustom = activeKey === 'custom' || isCustomized;

  const handleClick = (key) => {
    if (key === 'custom') return; // custom é automático, não selecionável
    if (key === activeKey && !isCustomized) return;
    setPending(key);
  };

  const confirm = () => {
    if (pending) onApply(pending);
    setPending(null);
  };

  return (
    <div>
      <label className="block text-xs text-slate-400 mb-2">Objetivo Estratégico</label>
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
        {Object.entries(OBJECTIVE_PRESETS).map(([key, preset]) => {
          if (key === 'custom' && !showAsCustom) return null;
          const Icon = ICONS[preset.icon] || Pencil;
          const isActive = key === 'custom'
            ? showAsCustom
            : key === activeKey && !showAsCustom;
          const isBaseOfCustom = showAsCustom && key === activeKey && activeKey !== 'custom';
          return (
            <button
              key={key}
              type="button"
              onClick={() => handleClick(key)}
              disabled={key === 'custom'}
              className={`relative flex flex-col items-start gap-1 p-2.5 rounded-lg border text-left transition-all
                ${isActive
                  ? 'border-cyan bg-cyan/10'
                  : isBaseOfCustom
                    ? 'border-cyan/40 bg-cyan/5'
                    : 'border-surface-3 bg-surface-2 hover:border-cyan/40'}
                ${key === 'custom' ? 'cursor-default' : 'cursor-pointer'}`}
            >
              <div className="flex items-center gap-1.5 w-full">
                <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${isActive || isBaseOfCustom ? 'text-cyan' : 'text-slate-500'}`} />
                <span className={`text-[11px] font-semibold truncate ${isActive || isBaseOfCustom ? 'text-white' : 'text-slate-300'}`}>
                  {preset.label}
                </span>
                {isBaseOfCustom && <Pencil className="w-2.5 h-2.5 text-amber-400 flex-shrink-0 ml-auto" />}
              </div>
              <span className="text-[9px] text-slate-500 leading-tight line-clamp-2">{preset.tagline}</span>
            </button>
          );
        })}
      </div>

      {showAsCustom && activeKey !== 'custom' && (
        <p className="text-[10px] text-amber-400/80 mt-1.5 flex items-center gap-1">
          <Pencil className="w-2.5 h-2.5" />
          Valores editados — será salvo como Personalizado (base: {OBJECTIVE_PRESETS[activeKey]?.label})
        </p>
      )}

      {pending && (
        <div className="mt-2 flex items-center gap-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 animate-fade-in">
          <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs text-amber-300 font-semibold">
              Aplicar os valores sugeridos de "{OBJECTIVE_PRESETS[pending]?.label}"?
            </p>
            <p className="text-[10px] text-amber-400/70 mt-0.5">
              Isso substituirá os campos de metas abaixo. {OBJECTIVE_PRESETS[pending]?.daypartingNote}.
            </p>
          </div>
          <div className="flex gap-2 flex-shrink-0">
            <button type="button" onClick={confirm}
              className="px-3 py-1.5 text-xs font-semibold bg-amber-500/20 border border-amber-500/40 text-amber-300 hover:bg-amber-500/30 rounded-lg transition-colors">
              Aplicar
            </button>
            <button type="button" onClick={() => setPending(null)}
              className="px-3 py-1.5 text-xs font-semibold bg-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors">
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}