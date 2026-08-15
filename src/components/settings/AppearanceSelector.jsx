import { Moon, ShieldCheck } from 'lucide-react';

/**
 * O shell autenticado usa uma única paleta operacional para não alternar
 * tabelas, menus portais ou diálogos para superfícies claras.
 */
export default function AppearanceSelector() {
  return (
    <section className="bg-surface-1 border border-surface-2 rounded-xl p-6" aria-labelledby="appearance-title">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-indigo-400/25 bg-indigo-500/10 text-indigo-300">
          <Moon className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h2 id="appearance-title" className="text-sm font-semibold text-theme-primary">Aparência operacional</h2>
          <p className="mt-1 text-xs text-theme-muted">
            Tema escuro premium aplicado em todo o ambiente autenticado, inclusive tabelas, filtros, menus e modais.
          </p>
        </div>
      </div>
      <div className="mt-5 flex items-center gap-2 rounded-lg border border-emerald-400/20 bg-emerald-400/[0.07] px-3 py-2.5 text-xs text-emerald-200">
        <ShieldCheck className="h-4 w-4 flex-none" aria-hidden="true" />
        Contraste e consistência visual protegidos para a operação diária.
      </div>
    </section>
  );
}
