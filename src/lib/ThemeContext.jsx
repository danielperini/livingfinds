import { createContext, useContext, useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';

const ThemeContext = createContext({ theme: 'light', setTheme: () => {} });

export const THEMES = [
  { id: 'dark',        label: 'Escuro',        description: 'Tema padrão da plataforma' },
  { id: 'light',       label: 'Claro',          description: 'Fundo cinza claro, cartões brancos e texto escuro' },
  { id: 'beige',       label: 'Bege',           description: 'Fundo creme bem claro e visual confortável' },
  { id: 'monochrome',  label: 'Preto e branco', description: 'Fundo branco, texto preto e alertas coloridos' },
];

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => {
    // Tema escuro forçado em todo o sistema: leitura confortável e alto contraste.
    const initial = 'dark';
    localStorage.setItem('lf_theme', initial);
    document.documentElement.setAttribute('data-theme', initial);
    return initial;
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('lf_theme', theme);
  }, [theme]);

  const setTheme = async (newTheme) => {
    setThemeState(newTheme);
    try {
      await base44.auth.updateMe({ user_appearance_theme: newTheme });
    } catch { /* silencioso */ }
  };

  useEffect(() => {
    base44.auth.me().then(me => {
      // Persiste o tema escuro no perfil do usuário para garantir uniformidade visual.
      if (me?.user_appearance_theme && me.user_appearance_theme !== 'dark') {
        base44.auth.updateMe({ user_appearance_theme: 'dark' }).catch(() => {});
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