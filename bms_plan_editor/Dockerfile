FROM node:22-bookworm-slim
ARG BUILD_VERSION=1.0.1
ARG BUILD_ARCH=amd64
LABEL io.hass.version="${BUILD_VERSION}" io.hass.type="app" io.hass.arch="${BUILD_ARCH}"
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY bootstrap.mjs askpass.cjs ./
RUN chmod 755 /app/askpass.cjs && mkdir -p /data
ENV NODE_ENV=production
EXPOSE 4174
HEALTHCHECK --interval=30s --timeout=5s --start-period=20m CMD node -e "fetch('http://127.0.0.1:4174/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/bootstrap.mjs"]
