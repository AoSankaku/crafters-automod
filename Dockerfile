FROM node:24-bookworm-slim AS build

WORKDIR /app
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY src ./src
COPY scripts ./scripts
COPY rules.md rules.generated.json ./
RUN pnpm run build

FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    HEALTH_PORT=8787

COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.HEALTH_PORT+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "./dist/index.js"]
