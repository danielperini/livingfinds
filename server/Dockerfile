FROM denoland/deno:2.1.4

WORKDIR /app

# base44/ (funções, entidades, schedules) fica um nível acima do server/ no repo.
# O build context deve ser a RAIZ do repo (ver docker-compose). Copiamos server/ e base44/.
COPY server/ ./server/
COPY base44/ ./base44/

WORKDIR /app/server

# Aponta para os artefatos do Base44 dentro da imagem
ENV FUNCTIONS_DIR=/app/base44/functions \
    SCHEDULES_FILE=/app/base44/schedules/amazon-automation-schedule.json \
    ENTITIES_DIR=/app/base44/entities \
    PORT=8000

# Pré-cacheia dependências (best-effort; não falha o build se offline)
RUN deno cache src/main.ts || true

EXPOSE 8000

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--allow-sys", "src/main.ts"]
