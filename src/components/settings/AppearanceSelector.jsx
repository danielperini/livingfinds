import { useTheme, THEMES } from '@/lib/ThemeContext';
import { Check, Moon, Sun, Coffee, Circle, Grid3X3 } from 'lucide-react';

const THEME_META = {
  dark: {
    icon: Moon,
    bg: '#080C17', surface: '#111B2F', text: '#F8FAFC', textMuted: '#94A3B8',
    accent: '#5574FF', border: '#26344E', previewBars: ['#5574FF', '#4FD18B', '#E9A84B'],
  },
  light: {
    icon: Sun,
    bg: '#F4F7FB', surface: '#FFFFFF', text: '#172033', textMuted: '#667085',
    accent: '#365CF5', border: '#D6DDEA', previewBars: ['#365CF5', '#1F9D68', '#D58A18'],
  },
  beige: {
    icon: Coffee,
    bg: '#F6F0E6', surface: '#FFFDF8', text: '#2F2A24', textMuted: '#756B5E',
    accent: '#8A5A34', border: '#D8CCBC', previewBars: ['#8A5A34', '#4F7A5A', '#C58A2A'],
  },
  monochrome: {
    icon: Circle,
    bg: '#ECEDEF', surface: '#FAFAFA', text: '#111318', textMuted: '#62666D',
    accent: '#2F343B', border: '#C7CBD1', previewBars: ['#2F343B', '#6B7078', '#A0A4AA'],
  },
  mondrian: {
    icon: Grid3X3,
    bg: '#F7F4EA', surface: '#FFFFFF', text: '#111111', textMuted: '#565656',
    accent: '#1455D9', border: '#111111', previewBars: ['#E1251B', '#1455D9', '#F2C300'],
  },
};

export default function AppearanceSelector() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-6">
      <h2 className="text-sm font-semibold text-theme-primary mb-1">Aparência</h2>
      <p className="text-xs text-theme-muted mb-5">
        Selecione um dos cinco sistemas visuais. A preferência é salva por usuário e aplicada em todo o aplicativo.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3">
        {THEMES.map((item) => {
          const meta = THEME_META[item.id];
          const Icon = meta.icon;
          const active = theme === item.id;

          return (
            <button
              type="button"
              key={item.id}
              onClick={() => setTheme(item.id)}
              className={`relative rounded-xl overflow-hidden text-left transition-all focus-visible:ring-2 focus-visible:ring-offset-2 ${active ? 'ring-2 ring-offset-1 shadow-lg scale-[1.02]' : 'hover:scale-[1.01] hover:shadow-md opacity-85 hover:opacity-100'}`}
              aria-pressed={active}
              aria-label={`Aplicar tema ${item.label}`}
            >
              <div style={{ border: `${active ? 2 : 1}px solid ${active ? meta.accent : meta.border}`, borderRadius: '0.75rem', overflow: 'hidden' }}>
                <div style={{ background: meta.bg }} className="p-3 h-[88px] flex flex-col gap-2">
                  <div style={{ background: meta.surface, border: `1px solid ${meta.border}`, borderRadius: 6, padding: 6 }}>
                    <div style={{ background: meta.text, opacity: 0.72, height: 4, borderRadius: 3, width: '70%', marginBottom: 4 }} />
                    <div style={{ background: meta.textMuted, opacity: 0.55, height: 3, borderRadius: 3, width: '46%' }} />
                  </div>
                  <div className="flex gap-1 items-end" style={{ height: 20 }}>
                    {meta.previewBars.map((color, index) => (
                      <div key={color} style={{ background: color, flex: 1, height: `${[100, 66, 82][index]}%`, borderRadius: item.id === 'mondrian' ? 0 : '2px 2px 0 0' }} />
                    ))}
                  </div>
                </div>

                <div style={{ background: meta.surface, borderTop: `1px solid ${meta.border}`, padding: '9px 10px' }} className="flex items-start justify-between gap-2 min-h-[58px]">
                  <div className="flex items-start gap-1.5 min-w-0">
                    <Icon style={{ color: meta.accent, width: 13, height: 13, flexShrink: 0, marginTop: 1 }} />
                    <div className="min-w-0">
                      <p style={{ color: meta.text, fontSize: 11, fontWeight: 700, lineHeight: 1.2 }}>{item.label}</p>
                      <p style={{ color: meta.textMuted, fontSize: 9, lineHeight: 1.35, marginTop: 3 }}>{item.description}</p>
                    </div>
                  </div>
                  <div style={{ background: active ? meta.accent : 'transparent', border: `1.5px solid ${active ? meta.accent : meta.border}`, borderRadius: '50%', width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    {active ? <Check style={{ color: '#fff', width: 11, height: 11 }} /> : null}
                  </div>
                </div>
              </div>

              {active ? <span style={{ position: 'absolute', top: 6, right: 6, background: meta.accent, color: '#fff', fontSize: 8, fontWeight: 800, padding: '2px 5px', borderRadius: 4, letterSpacing: '.05em' }}>ATIVO</span> : null}
            </button>
          );
        })}
      </div>

      <p className="text-[10px] text-theme-muted mt-4 opacity-75">
        A mudança é imediata e não altera dados, métricas, campanhas ou configurações operacionais.
      </p>
    </div>
  );
}
