/**
 * Endpoint legado de pesquisa pública.
 * A integração externa foi desativada para que o motor use somente fontes
 * oficiais e dados internos auditáveis.
 */
export default async function(): Promise<Response> {
  return Response.json({
    ok: false,
    disabled: true,
    error: "Pesquisa pública externa desativada. Use os termos de busca e sugestões oficiais da Amazon Ads.",
  }, { status: 410 });
}
