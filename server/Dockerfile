# Build the frontend from the same source revision as the backend.
FROM node:22-bookworm-slim AS frontend

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

# Runtime image for the self-hosted backend.
FROM denoland/deno:2.9.8

WORKDIR /app

# base44/ (funções, entidades, schedules) fica um nível acima do server/ no repo.
# O build context deve ser a RAIZ do repo (ver docker-compose).
COPY server/ ./server/
COPY base44/ ./base44/
COPY --from=frontend /build/dist ./dist/

WORKDIR /app/server

# Aponta para os artefatos do Base44 + frontend buildado dentro da imagem
ENV DENO_COMPAT=1 \
    FUNCTIONS_DIR=/app/base44/functions \
    SCHEDULES_FILE=/app/base44/schedules/amazon-automation-schedule.json \
    ENTITIES_DIR=/app/base44/entities \
    FRONTEND_DIR=/app/dist \
    PORT=8000

# Pré-cacheia dependências (best-effort; não falha o build se offline)
RUN deno cache src/main.ts || true

EXPOSE 8000

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--allow-sys", "src/main.ts"]
