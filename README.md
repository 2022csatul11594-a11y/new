# Kubeship test app

A small web app and API for testing Kubeship deployments. It has no dependencies, listens on **port 8080**, and
writes one JSON log line per event.

## Run it

```
node server.js          # http://localhost:8080
docker build -t kubeship-test-app . && docker run -p 8080:8080 kubeship-test-app
```

## What to try in Kubeship

| Do this | Look here |
|---|---|
| Open the public address | the dashboard shows the pod name, uptime, memory |
| Add to-do items | the list survives a page reload |
| Press *Info / Warning / Error line* | **Logs** tab: JSON lines with a `level` |
| Press *CPU for 30 s* or *Hold 100 MB* | **Metrics** tab: CPU and memory rise, then fall |
| Press *100 quick requests* | **Metrics** tab: the request count jumps |
| Press *Crash the app* | the pod restarts; the dashboard comes back |
| Add variables named `PUBLIC_SOMETHING` in **Variables** | they appear under "Public env" (other variables are hidden) |
| Scale to 2 replicas | the "Pod" name changes between reloads |

## Endpoints

`GET /` dashboard · `GET /health` · `GET /ready` · `GET /metrics` (Prometheus text) · `GET /api/info` ·
`GET/POST /api/todos` · `PATCH/DELETE /api/todos/:id` · `GET /api/slow?ms=` · `GET /api/error` · `GET /api/crash` ·
`GET /api/log?level=&msg=` · `GET /api/load/cpu?seconds=` · `GET /api/load/memory?mb=` · `GET /api/load/release`

Settings: `PORT` (default 8080), `APP_VERSION`, `DATA_DIR` (where the to-do list is saved; default `/tmp/data`).
