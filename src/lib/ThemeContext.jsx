import { createContext, useContext, useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';

const ThemeContext = createContext({ theme: 'dark', setTheme: () => {} });

export const THEMES = [
  { id: 'dark',        label: 'Escuro',        description: 'Tema padrão da plataforma' },
  { id: 'light',       label: 'Claro',          description: 'Fundo branco, alto contraste' },
  { id: 'beige',       label: 'Bege',           description: 'Fundo creme, visual confortável' },
  { id: 'monochrome',  label: 'Preto e branco', description: 'Sem cores decorativas, apenas contraste' },
];

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => {
    // Ler localStorage síncronamente para evitar flash
    const saved = localStorage.getItem('lf_theme') || 'dark';
    // Aplicar imediatamente no <html> antes do primeiro render
    document.documentElement.setAttribute('data-theme', saved);
    return saved;
  });

  // Sincronizar sempre que o tema mudar
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('lf_theme', theme);
  }, [theme]);

  // Salvar no perfil do usuário (silencioso)
  const setTheme = async (newTheme) => {
    setThemeState(newTheme);
    try {
      await base44.auth.updateMe({ user_appearance_theme: newTheme });
    } catch { /* silencioso */ }
  };

  // Carregar preferência salva no perfil
  useEffect(() => {
    base44.auth.me().then(me => {
      if (me?.user_appearance_theme && me.user_appearance_theme !== theme) {
        setThemeState(me.user_appearance_theme);
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