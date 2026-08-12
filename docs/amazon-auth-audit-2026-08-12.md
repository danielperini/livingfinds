# Auditoria e runbook de autenticação Amazon — 2026-08-12

Branch de correção: `fix/amazon-auth-canonical-credentials`

## Escopo e limitação da auditoria

A auditoria cobriu os entrypoints e módulos efetivamente envolvidos no diagnóstico Ads/SP, OAuth, gateway, token manager, UI e jobs do motor. O repositório `danielperini/livingfinds` está marcado pelo conector GitHub como `is_code_search_indexed=false`; portanto a busca global de código do GitHub não é uma fonte confiável para afirmar que um termo inexistente realmente não aparece em nenhum blob. A validação final usa os arquivos mapeados, o diff da branch, `deno check`, testes compartilhados e build do frontend.

Essa limitação deve permanecer explícita até o repositório ser indexado ou uma varredura `grep` local da árvore completa ser executada na VPS/CI.

## 1. Fontes canônicas de credenciais

### Amazon Ads

Fonte canônica de configuração de processo:

- `ADS_CLIENT_ID`
- `ADS_CLIENT_SECRET`
- `ADS_REFRESH_TOKEN`
- `ADS_PROFILE_ID`
- `ADS_ACCOUNT_ID`
- `ADS_REGION`

Fonte canônica de refresh token em runtime depois de OAuth:

1. `AmazonAccount.ads_refresh_token` no banco;
2. `ADS_REFRESH_TOKEN` somente quando o banco não possui refresh token válido.

Se banco e ambiente divergirem, o banco permanece ativo e `ads_token_source_conflict=true`. Um token existente no banco que esteja revogado nunca é substituído silenciosamente pelo token do ambiente.

### SP-API

Fontes canônicas:

- `AMAZON_LWA_CLIENT_ID`
- `AMAZON_LWA_CLIENT_SECRET`
- `AMAZON_SP_REFRESH_TOKEN`

Aliases legados somente como fallback:

- `SP_CLIENT_ID`
- `SP_CLIENT_SECRET`
- `SP_REFRESH_TOKEN`

Ads não utiliza `AMAZON_LWA_*` como fallback. Isso impede que o app LWA da SP-API seja confundido com o app LWA da Amazon Ads.

## 2. Auditoria arquivo × credenciais

| Arquivo | Leitura anterior | Estado após correção | Observação |
|---|---|---|---|
| `base44/shared/amazonCredentials.ts` | inexistente | único resolvedor de `ADS_*`, `AMAZON_*` e aliases `SP_*` | único módulo autorizado a resolver credenciais Amazon do ambiente |
| `base44/functions/testAuthHealth/entry.ts` | Ads/SP resolvidos localmente; SP priorizava `SP_*` | `resolveAmazonAdsCredentials` + `resolveAmazonSpCredentials` | corrige o falso `invalid_client` SP causado por aliases velhos |
| `base44/functions/testSpApiAuth/entry.ts` | `AMAZON_LWA_*` e `AMAZON_SP_REFRESH_TOKEN` diretos | resolvedor canônico SP | não retorna preview de access token |
| `base44/functions/getLWAAccessToken/entry.ts` | seleção local Ads/SP | resolvedores canônicos | rota preservada; não retorna access/refresh token |
| `base44/functions/amazonAdsTokenManager/entry.ts` | DB + `ADS_*`, com fallback ENV capaz de mascarar DB revogado | DB primário + resolver Ads; ENV somente se DB não possui token | resposta HTTP não contém access token |
| `base44/functions/getOAuthSetupInfo/entry.ts` | `ADS_*` e redirect com fallback hardcoded | resolver Ads + `APP_BASE_URL` | diagnóstico live; labels de UI são source+fingerprint, não segredo |
| `base44/functions/exchangeAmazonAdsCode/entry.ts` | `ADS_CLIENT_ID/SECRET` locais | resolver Ads | só persiste refresh token após validar `/v2/profiles` e profile esperado |
| `base44/functions/saveAdsRefreshToken/entry.ts` | `ADS_CLIENT_ID/SECRET` locais | resolver Ads | valida token + profile antes de persistir |
| `base44/functions/amazonAdsProxy/entry.ts` | refresh/client/profile/region próprios | resolver Ads + token manager | access token lido do banco via service-role, nunca do JSON do manager |
| `base44/functions/amazonAdsCommand/entry.ts` | `ADS_REGION`, `ADS_PROFILE_ID`, `ADS_CLIENT_ID`, `ADS_ACCOUNT_ID` diretos | resolver Ads + token manager | preserva guardrails existentes; normaliza reauth explícita |
| `base44/functions/adsHelpers/entry.ts` | `ADS_*` diretos | resolver Ads | helper legado continua sem contexto de AmazonAccount; não lê env diretamente |
| `base44/functions/amazonAuthCallback/entry.ts` | SP local; imprimia refresh token e podia gravá-lo em `ads_refresh_token` | resolvedor SP | removido cross-write SP→Ads e removido log do token |
| `base44/functions/amazonSpApiCallback/entry.ts` | SP local; imprimia refresh token | resolvedor SP | somente fingerprint diagnóstico |
| `base44/functions/amazonApiGatewayCore/entry.ts` | nenhuma credencial | nenhuma credencial | permanece intencionalmente credential-agnostic; recebe endpoint/headers do chamador |
| `server/.env.example` | mantinha conjuntos paralelos sem hierarquia explícita | nomes canônicos e aliases documentados | sem valores reais |

`APP_BASE_URL`, `DATABASE_URL`, `API_TOKEN` e outras variáveis de infraestrutura não são credenciais Amazon e permanecem nos módulos próprios quando necessário.

## 3. Escritores de estado AmazonAccount mapeados

| Escritor | Campos Ads relevantes | Regra após correção |
|---|---|---|
| `amazonAdsTokenManager` | `ads_token_status`, `ads_requires_reauth`, `ads_credentials_error`, erros LWA, `status`, `profile_validation_status`, `profile_validated_at` | `profile_validated_at` somente após GET `/v2/profiles` real contendo o profile esperado |
| `testAuthHealth` | mesmos estados de saúde | health live Ads + SP; não considera LWA Ads isoladamente suficiente |
| `getOAuthSetupInfo` | estado Ads e validação de profile | corrige campo persistido para refletir a verificação live |
| `exchangeAmazonAdsCode` | refresh/access token, timestamps, status e profile | persiste apenas após troca de code + validação real do profile esperado |
| `saveAdsRefreshToken` | refresh/access token, timestamps, status e profile | mesma regra validate-before-write |
| `amazonAdsCommand` | marca revogado em 401/403 persistente | usa `ADS_TOKEN_REVOKED_REAUTH_REQUIRED` |
| `amazonAdsProxy` | marca revogado em 401/403 persistente | usa `ADS_TOKEN_REVOKED_REAUTH_REQUIRED` |
| `testSpApiAuth` | `status` geral | SP não pode sobrescrever erro Ads revogado com `connected` |
| `amazonAuthCallback` / `amazonSpApiCallback` | `status` geral | SP não pode sobrescrever erro Ads; não escreve campos de refresh Ads |

Frontend alterado:

- `src/pages/integracoes/Amazon.jsx`: `status='connected'` não é suficiente se `ads_requires_reauth=true`, `ads_token_status='revoked'` ou `ads_credentials_error=true`.
- `src/pages/AmazonAdsCallback.jsx`: authorization code não é logado; nenhum preview de token é exibido.

## 4. Fluxo OAuth Amazon Ads após a correção

1. Usuário abre `${APP_BASE_URL}/amazon-oauth-setup`.
2. `getOAuthSetupInfo` resolve a redirect URI exclusivamente como `${APP_BASE_URL}/amazon-ads-callback`.
3. A tela exibe a redirect URI exata e monta a URL OAuth com o scope `advertising::campaign_management`.
4. Amazon redireciona o navegador para `/amazon-ads-callback?code=...`.
5. `src/pages/AmazonAdsCallback.jsx` mantém o code somente em memória e chama `exchangeAmazonAdsCode`.
6. `exchangeAmazonAdsCode` troca o code por tokens sem logar valores.
7. Com o access token recém-obtido, chama `GET /v2/profiles` no host Ads da região configurada.
8. Confirma que o profile esperado está presente. Para a conta auditada: `1489314938316530`.
9. Somente depois grava `ads_refresh_token`, `ads_refresh_token_updated_at`, access token interno, `ads_token_status='active'`, `ads_requires_reauth=false`, `profile_validation_status='valid'`, `profile_validated_at` e `status='connected'`.
10. Se a validação falhar, o refresh token anterior não é sobrescrito e a resposta informa `token_persisted=false`.
11. Se o token novo do banco divergir de `ADS_REFRESH_TOKEN` da VPS, a UI retorna aviso de sincronização necessária sem retornar qualquer valor de token.

O caminho manual `saveAdsRefreshToken` aplica a mesma regra validate-before-write.

## 5. Região Ads para Brasil

O código resolve:

- `NA` → `https://advertising-api.amazon.com`
- `EU` → `https://advertising-api-eu.amazon.com`
- `FE` → `https://advertising-api-fe.amazon.com`

Para a conta brasileira auditada, `ADS_REGION=NA` é a configuração esperada. O profile retornado por `/v2/profiles` continua sendo a verificação definitiva de que a autorização está no ambiente/região corretos.

## 6. Falha explícita do motor

Jobs de decisão agendados passam por autenticação antes de chamar os decisores:

- `runUnifiedDecisionEngineWithAuthGuard`
- `executeApprovedDecisionQueueWithAuthGuard`
- `runAdsAutomationWithAuthGuard` para `runCanonicalDaypartingEngine`
- `runAdsAutomationWithAuthGuard` para `runServingCampaignGrowthObjective`

Quando Ads está revogada:

- erro: `ADS_TOKEN_REVOKED_REAUTH_REQUIRED`;
- `aborted_before_decisions=true`;
- `decisions_enqueued=0` nos ciclos de decisão;
- `executed=0` e fila intacta no executor;
- não retorna `partial`;
- erro é persistido em `SyncExecutionLog`.

## 7. Reautorização manual exata

### 7.1 Conferir APP_BASE_URL e a Return URL

Na raiz do repositório da VPS:

```bash
grep '^APP_BASE_URL=' server/.env
set -a
source server/.env
set +a
printf 'SETUP: %s/amazon-oauth-setup\n' "${APP_BASE_URL%/}"
printf 'RETURN URL: %s/amazon-ads-callback\n' "${APP_BASE_URL%/}"
```

`APP_BASE_URL` não é segredo. A `RETURN URL` impressa acima deve ser idêntica à exibida na página `/amazon-oauth-setup`.

### 7.2 Conferir o aplicativo LWA

No portal de desenvolvedor da Amazon, abra o aplicativo LWA correspondente ao `ADS_CLIENT_ID` da VPS e confira **Allowed Return URLs**.

A URL cadastrada precisa ser exatamente:

```text
${APP_BASE_URL}/amazon-ads-callback
```

Sem trocar protocolo, host, caminho ou adicionar/remover barra final.

Scope utilizado pelo app:

```text
advertising::campaign_management
```

### 7.3 Autorizar

1. Abra `${APP_BASE_URL}/amazon-oauth-setup`.
2. Clique em **Autorizar Amazon Ads**.
3. Entre com a conta Amazon que administra a publicidade da `LivingFinds.oc` no Brasil.
4. O fluxo só será aceito se `/v2/profiles` retornar o profile esperado `1489314938316530`.
5. Após o callback, confira na tela:
   - token ativo;
   - profile esperado validado;
   - `ads_requires_reauth=false`;
   - nenhuma mensagem `ADS_EXPECTED_PROFILE_NOT_FOUND`.

### 7.4 Sincronizar o token novo do banco para o `.env` da VPS sem exibi-lo

Depois do OAuth bem-sucedido, execute na raiz do repositório da VPS:

```bash
bash server/scripts/sync-ads-refresh-token-env.sh 6a40448b9af1241f356e9fcc
```

O script:

1. lê `AmazonAccount.data.ads_refresh_token` diretamente do Postgres dentro do container;
2. nunca imprime o token;
3. grava/atualiza `ADS_REFRESH_TOKEN` em `server/.env` com permissão restrita;
4. cria backup restrito do `.env`;
5. recria somente o container `app` para carregar a nova variável.

Após confirmar a estabilidade, remova backups antigos de `.env` conforme a política operacional de secrets da VPS.

### 7.5 Verificação pós-restart sem exibir token

Use a UI `/amazon-oauth-setup` e execute **Verificar novamente**. O estado esperado é:

```text
token_status = valid
expected_profile_validated = true
ads_token_status = active
ads_requires_reauth = false
profile_validation_status = valid
status = connected
```

O health retorna apenas origem/fingerprint das credenciais, nunca o valor do token.

## 8. Rollback

Rollback de código: reverter o PR/commit e redeployar.

Rollback do `.env`: o script cria `server/.env.bak.<timestamp>` com permissão `600`. Se necessário, com o app parado, restaure o backup escolhido, recrie o container `app` e remova backups obsoletos depois da recuperação.

Não restaurar um refresh token revogado apenas para recuperar o estado visual `connected`.
