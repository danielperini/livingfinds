import { createContext, useContext, useEffect } from 'react';

const ThemeContext = createContext({ theme: 'light', setTheme: () => {} });

export const THEMES = [
  { id: 'light', label: 'Claro', description: 'Tema padrão do LivingFinds' },
];

export function ThemeProvider({ children }) {
  // Tema claro único e fixo em todo o sistema.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', 'light');
    localStorage.setItem('lf_theme', 'light');
  }, []);

  const setTheme = () => {
    // Tema único: nenhuma alternância disponível.
  };

  return (
    <ThemeContext.Provider value={{ theme: 'light', setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}