FROM node:24-slim AS builder
WORKDIR /app

# 1. Restore dependency layer caching: copy manifests first
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/audio-tags/package.json ./packages/audio-tags/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json

RUN npm ci --no-audit --no-fund

# 2. Copy TypeScript configs and source code, then build all artifacts
COPY tsconfig.base.json tsconfig.build.json ./
COPY scripts ./scripts
COPY packages ./packages
COPY apps ./apps

RUN npm run build \
  && npm prune --omit=dev --workspace=@trackvault/server --workspace=@trackvault/shared --workspace=@trackvault/audio-tags

FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3010
ENV DATA_DIR=/data

RUN addgroup --system trackvault && adduser --system --ingroup trackvault trackvault \
  && mkdir -p /data && chown -R trackvault:trackvault /data

# Copy workspace manifests so Node.js ESM subpath #imports resolve via nearest package.json
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /app/packages/audio-tags/package.json ./packages/audio-tags/package.json
COPY --from=builder /app/apps/server/package.json ./apps/server/package.json

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/audio-tags/dist ./packages/audio-tags/dist
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/web/dist ./apps/web/dist

USER trackvault
EXPOSE 3010

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const port = process.env.PORT || 3010; fetch('http://127.0.0.1:' + port + '/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]
