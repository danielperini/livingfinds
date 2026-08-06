import { createContext, useContext, useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';

const ThemeContext = createContext({ theme: 'dark', setTheme: () => {} });

export const THEMES = [
  { id: 'dark', label: 'Navy Indigo', description: 'Escuro premium, tecnológico e focado em operação' },
  { id: 'light', label: 'Claro Executivo', description: 'Claro, limpo e com alto contraste para uso diário' },
  { id: 'beige', label: 'Editorial Areia', description: 'Quente, confortável e menos cansativo em longas análises' },
  { id: 'monochrome', label: 'Sóbrio Monocromático', description: 'Neutro, discreto e com mínima distração visual' },
  { id: 'mondrian', label: 'Mondrian', description: 'Branco, preto e cores primárias em blocos gráficos' },
];

const THEME_IDS = new Set(THEMES.map(({ id }) => id));
const normalizeTheme = (value) => THEME_IDS.has(value) ? value : 'dark';

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => {
    const saved = normalizeTheme(localStorage.getItem('lf_theme'));
    document.documentElement.setAttribute('data-theme', saved);
    return saved;
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.style.colorScheme = theme === 'dark' ? 'dark' : 'light';
    localStorage.setItem('lf_theme', theme);
  }, [theme]);

  const setTheme = async (newTheme) => {
    const normalized = normalizeTheme(newTheme);
    setThemeState(normalized);
    try {
      await base44.auth.updateMe({ user_appearance_theme: normalized });
    } catch {
      // A preferência local permanece válida mesmo quando o perfil não puder ser atualizado.
    }
  };

  useEffect(() => {
    base44.auth.me().then((me) => {
      const profileTheme = normalizeTheme(me?.user_appearance_theme);
      if (me?.user_appearance_theme && profileTheme !== theme) setThemeState(profileTheme);
    }).catch(() => {});
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
