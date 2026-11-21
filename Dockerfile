# pii-shield HTTP service (`pii-shield serve`): docs/server.md#docker
FROM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json README.md LICENSE CHANGELOG.md ./
COPY src ./src
COPY docs/openapi.yaml ./docs/
# The optional peers the service uses (/mcp, Redis, Postgres), at the versions the repo tests against.
RUN mkdir /out && npm run build \
  && npm pack --pack-destination /out \
  && node -e "for (const p of ['@modelcontextprotocol/sdk', 'ioredis', 'pg']) console.log(p + '@' + require('./node_modules/' + p + '/package.json').version)" > /out/peers.txt

FROM node:24-alpine
ENV NODE_ENV=production \
    PII_SERVICE_HOST=0.0.0.0 \
    PII_SERVICE_PORT=8088
WORKDIR /app
COPY --from=build /out /tmp/out
RUN apk add --no-cache tini \
  && echo '{"private":true}' > package.json \
  && npm install --omit=dev --no-audit --no-fund /tmp/out/*.tgz $(cat /tmp/out/peers.txt) \
  && npm cache clean --force \
  && rm -rf /tmp/out \
  && mkdir /data && chown node:node /data
USER node
EXPOSE 8088
# tini as PID 1: a SIGTERM before the CLI has set its handlers still stops the container.
ENTRYPOINT ["/sbin/tini", "--", "node", "/app/node_modules/@waswrongassembled/pii-shield/dist/bin.js"]
CMD ["serve"]
