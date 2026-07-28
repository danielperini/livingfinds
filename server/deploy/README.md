# Deploy sem interrupção na VPS Hostinger

Esta estrutura usa blue/green deployment. `app_blue` e `app_green` compartilham o mesmo
PostgreSQL, mas o Nginx envia tráfego para somente uma delas. O candidato é iniciado e
testado antes da troca. A versão anterior permanece em execução para rollback.

O scheduler roda em um serviço separado (`worker`). Isso impede que as duas cores
executem automações e decisões duplicadas.

## Garantias

- o volume `livingfinds_pgdata` não é recriado durante deploy;
- PostgreSQL não publica porta para a internet;
- um dump é criado antes de qualquer migração;
- migrações são ordenadas, registradas e exclusivamente incrementais;
- o frontend é compilado dentro da imagem Docker;
- a release candidata precisa passar no health check;
- todas as funções da versão ativa precisam continuar existindo;
- Nginx só troca o tráfego depois dessas validações;
- rollback troca API, frontend e worker para a imagem anterior;
- falha do candidato não altera o tráfego atual.

## Preparação inicial

Na VPS, dentro do repositório:

```bash
cp server/.env.example server/.env
cp server/deploy/.release.env.example server/deploy/.release.env
chmod +x server/deploy/*.sh
```

Preencha `server/.env`. Em produção, `DB_PASSWORD`, `ADMIN_PASSWORD`, `API_TOKEN` e
`APP_BASE_URL` são obrigatórios. `ADMIN_PASSWORD` e `API_TOKEN` devem ser diferentes.

Para incorporar uma instalação Docker já existente, identifique a imagem que está
rodando e preencha inicialmente `BLUE_IMAGE` e `WORKER_IMAGE` com essa tag. Se a
instalação atual não usa uma imagem reutilizável, crie uma tag antes:

```bash
docker commit CONTAINER_ATUAL livingfinds:pre-blue-green
```

Use essa tag como `BLUE_IMAGE`, `GREEN_IMAGE` e `WORKER_IMAGE` na primeira ativação.
O volume existente deve ser associado ao nome externo `livingfinds_pgdata`; não copie
arquivos internos do PostgreSQL com o banco em execução.

## Publicar

```bash
git pull --ff-only
./server/deploy/deploy.sh
```

Também é possível fornecer um identificador:

```bash
./server/deploy/deploy.sh release-2026-07-28
```

O Nginx deste Compose escuta somente em `127.0.0.1:8000`. O Nginx principal da VPS,
que mantém domínio e certificado atuais, deve continuar apontando para esse endereço.

## Rollback

```bash
./server/deploy/rollback.sh
```

O rollback é instantâneo para código, frontend e máquina de decisões. O banco não é
automaticamente restaurado porque toda migração deve ser retrocompatível. Restaurar
um dump por cima de produção poderia apagar registros criados depois do deploy.

## Como evoluir sem quebrar produção

### Frontend

O frontend pode ser totalmente alterado, mas durante uma release deve continuar
aceitando as respostas da API antiga. Quando o formato de uma resposta precisar
mudar, publique primeiro a API que retorna os campos antigos e novos; altere o
frontend na release seguinte.

### APIs e funções

- Adicione novas rotas e funções; não reutilize nomes com significado diferente.
- Mantenha parâmetros e campos já existentes.
- Campos novos devem ser opcionais ou ter valor padrão.
- Para substituir uma função, mantenha a anterior como adaptador por pelo menos uma release.
- O deploy cancela antes da troca se detectar que alguma função ativa desapareceu.

### Banco

Adicione um arquivo novo em `server/migrations/` para cada mudança. Nunca edite uma
migração já aplicada. Use a sequência expand/migrate/contract:

1. **Expand:** crie estrutura nova sem remover a antiga.
2. **Migrate:** copie dados em lotes reiniciáveis e valide contagens.
3. **Contract:** remova a estrutura antiga somente em release futura e manutenção aprovada.

### Máquina de decisões

- Novas regras devem iniciar desativadas por configuração/feature flag.
- Grave a versão da regra e os dados de entrada em `DecisionLog`.
- Execute primeiro em modo sombra: calcula e registra, mas não aplica ações na Amazon.
- Compare o resultado novo com o atual.
- Ative gradualmente por conta/campanha.
- Preserve idempotência para impedir ações repetidas durante retry ou rollback.
- Mudanças de scheduler só entram no `worker`, nunca nos serviços blue/green.

## Antes de cada release

1. Execute o preflight e os testes do servidor.
2. Confirme que a migração SQL é aditiva.
3. Teste login e uma leitura/escrita de entidade em homologação.
4. Teste as APIs Amazon, Google Drive, e-mail e IA utilizadas pela alteração.
5. Confirme espaço livre para imagem e backup.
6. Mantenha a versão anterior até concluir a observação da nova release.
