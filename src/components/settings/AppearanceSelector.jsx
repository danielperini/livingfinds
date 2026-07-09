import { useTheme, THEMES } from '@/lib/ThemeContext';
import { Check, Moon, Sun, Coffee, Circle } from 'lucide-react';

const THEME_META = {
  dark: {
    icon: Moon,
    bg: '#0B1120',
    surface: '#111827',
    text: '#F8FAFC',
    textMuted: '#94A3B8',
    accent: '#3B82F6',
    border: '#263244',
    previewBars: ['#3B82F6', '#10B981', '#F59E0B'],
  },
  light: {
    icon: Sun,
    bg: '#F8FAFC',
    surface: '#FFFFFF',
    text: '#0F172A',
    textMuted: '#64748B',
    accent: '#2563EB',
    border: '#CBD5E1',
    previewBars: ['#2563EB', '#16A34A', '#D97706'],
  },
  beige: {
    icon: Coffee,
    bg: '#F5F0E8',
    surface: '#EDE8DE',
    text: '#2C1F0E',
    textMuted: '#7A6550',
    accent: '#7C5C34',
    border: '#C8C0B0',
    previewBars: ['#7C5C34', '#15803D', '#B45309'],
  },
  monochrome: {
    icon: Circle,
    bg: '#FFFFFF',
    surface: '#F5F5F5',
    text: '#0A0A0A',
    textMuted: '#606060',
    accent: '#171717',
    border: '#CCCCCC',
    previewBars: ['#171717', '#525252', '#A3A3A3'],
  },
};

export default function AppearanceSelector() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-6">
      <h2 className="text-sm font-semibold text-theme-primary mb-1">Aparência</h2>
      <p className="text-xs text-theme-muted mb-5">
        Escolha o visual da plataforma. A preferência é salva por usuário e persiste ao recarregar.
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {THEMES.map(t => {
          const meta = THEME_META[t.id];
          const Icon = meta.icon;
          const active = theme === t.id;

          return (
            <button
              key={t.id}
              onClick={() => setTheme(t.id)}
              style={{ outline: 'none' }}
              className={`relative rounded-xl overflow-hidden text-left transition-all focus-visible:ring-2 focus-visible:ring-offset-2
                ${active
                  ? 'ring-2 ring-offset-1 shadow-lg scale-[1.02]'
                  : 'hover:scale-[1.01] hover:shadow-md opacity-80 hover:opacity-100'
                }`}
              aria-pressed={active}
            >
              {/* Borda colorida no tema ativo */}
              <div
                style={{
                  border: active ? `2px solid ${meta.accent}` : `2px solid ${meta.border}`,
                  borderRadius: '0.75rem',
                  overflow: 'hidden',
                }}
              >
                {/* Mini preview do tema */}
                <div style={{ background: meta.bg }} className="p-3 h-[76px] flex flex-col gap-1.5">
                  {/* Card simulado */}
                  <div
                    style={{
                      background: meta.surface,
                      border: `1px solid ${meta.border}`,
                      borderRadius: '6px',
                      padding: '6px',
                    }}
                  >
                    <div style={{ background: meta.text, opacity: 0.7, height: 4, borderRadius: 3, width: '70%', marginBottom: 4 }} />
                    <div style={{ background: meta.text, opacity: 0.3, height: 3, borderRadius: 3, width: '45%' }} />
                  </div>
                  {/* Barras de gráfico simuladas */}
                  <div className="flex gap-1 items-end" style={{ height: 16 }}>
                    {meta.previewBars.map((color, i) => (
                      <div
                        key={i}
                        style={{
                          background: color,
                          flex: 1,
                          height: `${[100, 65, 80][i]}%`,
                          borderRadius: '2px 2px 0 0',
                          opacity: 0.85,
                        }}
                      />
                    ))}
                  </div>
                </div>

                {/* Label do tema */}
                <div
                  style={{
                    background: meta.surface,
                    borderTop: `1px solid ${meta.border}`,
                    padding: '8px 10px',
                  }}
                  className="flex items-center justify-between gap-1"
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Icon style={{ color: meta.accent, width: 12, height: 12, flexShrink: 0 }} />
                    <div className="min-w-0">
                      <p style={{ color: meta.text, fontSize: 11, fontWeight: 600, lineHeight: 1.2 }} className="truncate">
                        {t.label}
                      </p>
                      <p style={{ color: meta.textMuted, fontSize: 9, lineHeight: 1.3, marginTop: 1 }} className="truncate">
                        {t.description}
                      </p>
                    </div>
                  </div>

                  {/* Indicador de seleção */}
                  {active ? (
                    <div
                      style={{
                        background: meta.accent,
                        borderRadius: '50%',
                        width: 18,
                        height: 18,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      <Check style={{ color: '#ffffff', width: 11, height: 11 }} />
                    </div>
                  ) : (
                    <div
                      style={{
                        border: `1.5px solid ${meta.border}`,
                        borderRadius: '50%',
                        width: 18,
                        height: 18,
                        flexShrink: 0,
                      }}
                    />
                  )}
                </div>
              </div>

              {/* Tag "Ativo" */}
              {active && (
                <div
                  style={{
                    position: 'absolute',
                    top: 6,
                    right: 6,
                    background: meta.accent,
                    color: '#ffffff',
                    fontSize: 8,
                    fontWeight: 700,
                    padding: '2px 5px',
                    borderRadius: 4,
                    letterSpacing: '0.05em',
                  }}
                >
                  ATIVO
                </div>
              )}
            </button>
          );
        })}
      </div>

      <p className="text-[10px] text-theme-muted mt-4 opacity-70">
        O tema é aplicado globalmente. Recarregar a página mantém a preferência salva.
      </p>
    </div>
  );
}