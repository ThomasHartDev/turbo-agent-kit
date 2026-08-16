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
RUN pnpm install --frozen-lockfile --filter @agent/server...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/agent-core packages/agent-core
COPY packages/llm packages/llm
COPY packages/rate-limiter packages/rate-limiter
COPY apps/server apps/server
RUN pnpm --filter @agent/server... build \
 && pnpm --filter @agent/server deploy --prod --legacy /out

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8787
WORKDIR /app

RUN groupadd --system --gid 999 agent \
 && useradd --system --uid 999 --gid agent --home-dir /app --no-create-home --shell /usr/sbin/nologin agent

COPY --from=build --chown=agent:agent /out ./

USER agent
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
