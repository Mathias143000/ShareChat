# ShareChat Demo Runbook

## Purpose

This runbook is the shortest path to showing the repository as a portfolio-ready real-time DevOps lab.

## 1. Prepare Environment

```bash
npm ci
node scripts/bootstrap-env.js
```

That creates `.env` from `.env.example` if it does not exist.

## 2. Validate The App Build

```bash
npm run build
npm test
```

This proves the standalone application still works outside the compose lab.

## 3. Start The Full Stack

```bash
docker compose up -d --build
docker compose ps
```

Expected services:

- `redis`
- `minio`
- `minio-init`
- `app1`
- `app2`
- `edge`
- `prometheus`
- `alertmanager`
- `grafana`

## 4. Run The Compose Smoke

```bash
node scripts/compose-smoke.js
```

For the deeper operator proof, including cross-replica WebSocket delivery and upload preview evidence, run:

```bash
SHARECHAT_STRICT_COMPOSE_SMOKE=1 node scripts/compose-smoke.js
```

Expected outcome:

- health endpoints respond
- both replicas accept WebSocket connections
- chat message crosses replica boundary
- upload succeeds through the edge
- preview works
- metrics endpoint is populated
- Prometheus, Alertmanager, Grafana are reachable

## 5. Inspect The Stack

Useful URLs:

- `http://127.0.0.1:18300`
- `http://127.0.0.1:19090`
- `http://127.0.0.1:19093`
- `http://127.0.0.1:13170`
- `http://127.0.0.1:19001`

Grafana credentials:

- `admin`
- `admin12345`

## 6. Collect Evidence

```bash
node scripts/collect-logs.js
```

Artifacts written to:

- `artifacts/evidence/compose-ps.txt`
- `artifacts/evidence/compose-config.txt`
- `artifacts/evidence/compose-logs.txt`

## 7. Stop The Stack

```bash
docker compose down -v --remove-orphans
```

## Troubleshooting

### `compose-smoke` fails on uploads

Check:

- `docker compose logs app1 app2 edge --no-color`
- `docker compose logs minio --no-color`

The most likely failure area is object-storage upload configuration.

### Replica health is not green

Check:

- `docker compose ps`
- `docker compose logs app1 --no-color`
- `docker compose logs app2 --no-color`

### Metrics are missing

Check:

- `http://127.0.0.1:18301/api/metrics`
- `http://127.0.0.1:18302/api/metrics`
- `http://127.0.0.1:19090/targets`
