import { QueryClient } from '@tanstack/react-query';

export const queryClientInstance = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      // staleTime: 0 (padrão) — cada query define o seu próprio via useAccountData
    },
  },
});