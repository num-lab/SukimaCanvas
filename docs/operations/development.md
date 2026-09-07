## 启动开发环境
```bash
docker compose \
  -f docker-compose.hosted.yml \
  -f docker-compose.dev.yml \
  up -d --no-build --force-recreate app
```
查看日志
```bash
docker compose \
  -f docker-compose.hosted.yml \
  -f docker-compose.dev.yml \
  logs -f app
```