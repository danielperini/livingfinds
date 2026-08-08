import { createContext, useContext, useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';

const ThemeContext = createContext({ theme: 'dark', setTheme: () => {} });
const AUTHENTICATED_THEME = 'dark';

export const THEMES = [
  { id: 'dark',        label: 'Escuro',        description: 'Tema padrão da plataforma' },
  { id: 'light',       label: 'Claro',          description: 'Fundo cinza claro, cartões brancos e texto escuro' },
  { id: 'beige',       label: 'Bege',           description: 'Fundo creme bem claro e visual confortável' },
  { id: 'monochrome',  label: 'Preto e branco', description: 'Fundo branco, texto preto e alertas coloridos' },
];

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => {
    document.documentElement.setAttribute('data-theme', AUTHENTICATED_THEME);
    return AUTHENTICATED_THEME;
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', AUTHENTICATED_THEME);
    localStorage.setItem('lf_theme', AUTHENTICATED_THEME);
  }, [theme]);

  const setTheme = async () => {
    setThemeState(AUTHENTICATED_THEME);
    try {
      await base44.auth.updateMe({ user_appearance_theme: AUTHENTICATED_THEME });
    } catch { /* silencioso */ }
  };

  useEffect(() => {
    base44.auth.me().then(me => {
      if (me?.user_appearance_theme !== AUTHENTICATED_THEME) {
        base44.auth.updateMe({ user_appearance_theme: AUTHENTICATED_THEME }).catch(() => {});
      }
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
