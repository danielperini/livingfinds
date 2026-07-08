import { useTheme, THEMES } from '@/lib/ThemeContext';
import { Check } from 'lucide-react';

const THEME_PREVIEWS = {
  dark: {
    bg: '#0A0B0F',
    surface: '#111318',
    text: '#f8fafc',
    accent: '#3B82F6',
    border: '#1A1D26',
  },
  light: {
    bg: '#ffffff',
    surface: '#f4f4f5',
    text: '#0f172a',
    accent: '#2563EB',
    border: '#e2e8f0',
  },
  beige: {
    bg: '#f5f0e8',
    surface: '#ede8de',
    text: '#2c1f0e',
    accent: '#7c5c34',
    border: '#d6cfc3',
  },
  monochrome: {
    bg: '#ffffff',
    surface: '#f1f1f1',
    text: '#000000',
    accent: '#333333',
    border: '#cccccc',
  },
};

export default function AppearanceSelector() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-6">
      <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-1">Aparência</h2>
      <p className="text-xs text-[var(--text-secondary)] mb-5">Escolha o visual da plataforma. A preferência é salva por usuário.</p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {THEMES.map(t => {
          const preview = THEME_PREVIEWS[t.id];
          const active = theme === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTheme(t.id)}
              className={`relative rounded-xl border-2 overflow-hidden transition-all text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan ${
                active ? 'border-[var(--accent-color)]' : 'border-[var(--border-color)] hover:border-[var(--text-secondary)]'
              }`}
            >
              {/* Mini preview */}
              <div style={{ background: preview.bg }} className="p-3 h-20">
                <div style={{ background: preview.surface, borderColor: preview.border }}
                  className="rounded-md border mb-1.5 p-1.5">
                  <div style={{ background: preview.text, opacity: 0.15 }} className="h-1.5 rounded w-3/4 mb-1" />
                  <div style={{ background: preview.text, opacity: 0.08 }} className="h-1 rounded w-1/2" />
                </div>
                <div className="flex gap-1">
                  <div style={{ background: preview.accent }} className="h-1 rounded flex-1 opacity-80" />
                  <div style={{ background: preview.accent, opacity: 0.3 }} className="h-1 rounded flex-1" />
                  <div style={{ background: preview.accent, opacity: 0.5, width: '40%' }} className="h-1 rounded" />
                </div>
              </div>

              {/* Label */}
              <div style={{ background: preview.surface, borderTop: `1px solid ${preview.border}` }}
                className="px-3 py-2 flex items-center justify-between">
                <div>
                  <p style={{ color: preview.text }} className="text-xs font-semibold leading-tight">{t.label}</p>
                  <p style={{ color: preview.text, opacity: 0.5 }} className="text-[9px] leading-tight mt-0.5">{t.description}</p>
                </div>
                {active && (
                  <div style={{ background: preview.accent }} className="w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0">
                    <Check style={{ color: t.id === 'light' || t.id === 'beige' || t.id === 'monochrome' ? '#fff' : '#fff' }}
                      className="w-2.5 h-2.5" />
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <p className="text-[10px] text-[var(--text-secondary)] mt-4 opacity-60">
        O tema é aplicado globalmente em todas as páginas da plataforma.
      </p>
    </div>
  );
}