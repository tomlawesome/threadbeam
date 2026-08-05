FROM node:26-alpine@sha256:a4fb14143ee24c038c851864fe85fd90f9121abc8fdca3092798bcc02e06b1d8

WORKDIR /app

ENV NODE_ENV=production \
    THREADBEAM_HOST=0.0.0.0 \
    THREADBEAM_PORT=4317 \
    THREADBEAM_STORE_DIR=/data

COPY --chown=node:node package.json ./
COPY --chown=node:node bin ./bin
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
COPY --chown=node:node server.mjs ./server.mjs

RUN install -d -m 0700 -o node -g node /data

USER node

VOLUME ["/data"]
EXPOSE 4317

CMD ["node", "server.mjs"]
