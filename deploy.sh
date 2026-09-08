#!/usr/bin/env bash
set -euo pipefail

cd /srv/sukimacanvas

echo "==> Fetching code"
git fetch origin master
git reset --hard origin/master

echo "==> Building"
docker compose -f docker-compose.hosted.yml build app

echo "==> Restarting"
docker compose -f docker-compose.hosted.yml up -d postgres
docker compose -f docker-compose.hosted.yml run --rm app npm run check:hosted-storage
docker compose -f docker-compose.hosted.yml up -d app

echo "==> Cleaning old images"
docker image prune -f

echo "==> Deployment finished"