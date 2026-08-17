FROM denoland/deno:2.1.4

WORKDIR /app

# Produção self-hosted: backend, funções, entidades e schedules saem de runtime/.
# A pasta base44/ pode permanecer no repositório como área de contribuição,
# mas não é copiada nem carregada pelo container de produção.
COPY server/ ./server/
COPY runtime/ ./runtime/
COPY dist/ ./dist/

WORKDIR /app/server

ENV FUNCTIONS_DIR=/app/runtime/functions \
    SCHEDULES_FILE=/app/runtime/schedules/amazon-automation-schedule.json \
    ENTITIES_DIR=/app/runtime/entities \
    FRONTEND_DIR=/app/dist \
    PORT=8000

RUN deno cache src/main.ts || true

EXPOSE 8000

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--allow-sys", "src/main.ts"]
