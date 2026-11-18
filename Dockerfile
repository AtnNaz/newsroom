FROM node:22-alpine

WORKDIR /app
COPY package.json LICENSE README.md ./
COPY bin ./bin
COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown node:node /data
USER node

ENV NEWSROOM_HOST=0.0.0.0 \
    NEWSROOM_PORT=8077 \
    NEWSROOM_DATA_DIR=/data \
    NODE_ENV=production

VOLUME ["/data"]
EXPOSE 8077

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8077/api/session >/dev/null || exit 1

ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "bin/newsroom.js"]
CMD ["serve"]
