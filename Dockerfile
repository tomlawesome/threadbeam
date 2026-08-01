FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

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
