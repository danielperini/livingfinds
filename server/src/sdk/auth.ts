/**
 * Auth — reimplementa `base44.auth.me()` / `isAuthenticated()`.
 *
 * O sistema é single-tenant (um seller: Daniel Perini). Não há multi-usuário real,
 * então `me()` devolve o usuário-padrão configurado por env. A verificação de acesso
 * externo é feita na borda (API_TOKEN no main.ts); aqui dentro consideramos autenticado.
 */
// deno-lint-ignore no-explicit-any
type User = Record<string, any>;

export function makeAuth(_req?: Request) {
  const user: User = {
    id: Deno.env.get('DEFAULT_USER_ID') ?? 'system',
    email: 'contato@livingfinds.com.br',
    full_name: 'Daniel Perini',
    role: 'admin',
  };
  return {
    me: (): Promise<User> => Promise.resolve(user),
    isAuthenticated: (): Promise<boolean> => Promise.resolve(true),
  };
}
