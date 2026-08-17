FROM denoland/deno:2.1.4

WORKDIR /app

# Artefatos self-hosted (funções, entidades e schedules) ficam em runtime/.
# O build context deve ser a RAIZ do repo (ver docker-compose).
COPY server/ ./server/
COPY runtime/ ./runtime/
COPY dist/ ./dist/

WORKDIR /app/server

# Aponta exclusivamente para os artefatos self-hosted executados na Hostinger.
ENV FUNCTIONS_DIR=/app/runtime/functions \
    SCHEDULES_FILE=/app/runtime/schedules/amazon-automation-schedule.json \
    ENTITIES_DIR=/app/runtime/entities \
    FRONTEND_DIR=/app/dist \
    PORT=8000

# Pré-cacheia dependências (best-effort; não falha o build se offline)
RUN deno cache src/main.ts || true

EXPOSE 8000

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--allow-sys", "src/main.ts"]
