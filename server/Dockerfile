FROM node:22-alpine AS frontend

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.js jsconfig.json components.json tailwind.config.js postcss.config.js ./
COPY base44/ ./base44/
COPY src/ ./src/

ARG VITE_BASE44_APP_ID=selfhosted
ENV VITE_BASE44_APP_ID=${VITE_BASE44_APP_ID}
RUN npm run build

FROM denoland/deno:2.1.4

WORKDIR /app

COPY server/ ./server/
COPY base44/ ./base44/
COPY --from=frontend /build/dist ./dist/

WORKDIR /app/server

ENV FUNCTIONS_DIR=/app/base44/functions \
    SCHEDULES_FILE=/app/base44/schedules/amazon-automation-schedule.json \
    ENTITIES_DIR=/app/base44/entities \
    FRONTEND_DIR=/app/dist \
    PORT=8000

RUN deno cache src/main.ts

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=5 \
  CMD deno eval "const r=await fetch('http://127.0.0.1:8000/health');if(!r.ok)Deno.exit(1)"

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--allow-sys", "src/main.ts"]
