FROM node:24-alpine

LABEL org.opencontainers.image.source="https://github.com/lovasoa/whitebophir"

WORKDIR /opt/app

# Both data roots exist before the unprivileged user takes over, so a volume
# mounted over either one is writable by the runtime user. `server-data` is
# WBO_HISTORY_DIR (board snapshots); `hosted-data` is WBO_HOSTED_DATA_DIR
# (accounts, sessions, organizers, reservations, mutation ledgers, archives,
# exports, queues). Neither survives a container rebuild unless mounted.
RUN mkdir -p /opt/app/server-data /opt/app/hosted-data \
  && chown -R 1000:1000 /opt/app

# Allow node to bind to port 80
RUN apk update && apk add libcap
RUN setcap CAP_NET_BIND_SERVICE=+eip /usr/local/bin/node

USER 1000:1000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --chown=1000:1000 . .

ENV PORT=80
EXPOSE 80

VOLUME /opt/app/server-data
VOLUME /opt/app/hosted-data

CMD ["/usr/local/bin/node", "server/server.mjs"]
