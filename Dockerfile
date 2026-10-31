# TKD-Net Arena server. Build: docker build -t tkd-arena-server .   Run: docker run -p 8080:8080 --env-file arena.env tkd-arena-server
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 MALLOC_ARENA_MAX=2
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY lib ./lib
COPY vendor ./vendor
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1
# exec form: node is PID 1 and receives SIGTERM directly (graceful save on stop/deploy)
CMD ["node", "server.js"]
