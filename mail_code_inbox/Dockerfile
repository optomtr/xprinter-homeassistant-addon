FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && node -e "require('better-sqlite3')(':memory:').close()"

FROM node:22-bookworm-slim
ARG BUILD_VERSION=0.4.0
ARG BUILD_ARCH=amd64
LABEL io.hass.version="${BUILD_VERSION}" io.hass.type="app" io.hass.arch="${BUILD_ARCH}"
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data HTTP_HOST=0.0.0.0 SMTP_HOST=0.0.0.0
COPY --from=deps /app/node_modules ./node_modules
COPY package.json main.js app.js db.js mail.js ./
COPY public ./public
RUN mkdir /data
EXPOSE 3000 2525 8099
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.HTTP_PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "main.js"]
