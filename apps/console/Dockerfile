FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/console/package.json apps/console/package.json
COPY packages/agent-core/package.json packages/agent-core/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/llm/package.json packages/llm/package.json
COPY packages/rate-limiter/package.json packages/rate-limiter/package.json
COPY packages/store-redis/package.json packages/store-redis/package.json
RUN pnpm install --frozen-lockfile --filter @agent/console...

FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/console apps/console
ARG AGENT_URL=http://server:8787
ENV AGENT_URL=${AGENT_URL}
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @agent/console build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3001 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

RUN groupadd --system --gid 999 console \
 && useradd --system --uid 999 --gid console --home-dir /app --no-create-home --shell /usr/sbin/nologin console

COPY --from=build --chown=console:console /app/apps/console/.next/standalone ./
COPY --from=build --chown=console:console /app/apps/console/.next/static ./apps/console/.next/static
COPY --from=build --chown=console:console /app/apps/console/public ./apps/console/public

USER console
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/console/server.js"]
