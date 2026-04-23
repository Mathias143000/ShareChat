# ShareChat Architecture

## Intent

ShareChat is the portfolio's real-time/stateful systems lab.
It shows how a chat and file-sharing workload behaves when moved from a single-node app to a production-like runtime with:

- multiple replicas
- an edge proxy
- shared state coordination
- object storage
- basic observability

## Components

### Edge

- `nginx` is the public entrypoint on `:18300`
- proxies HTTP traffic to the app pool
- upgrades WebSocket connections for `/socket.io/`
- applies security headers
- rate-limits upload and file-management paths

### App replicas

- `app1` and `app2` run the same Node.js + TypeScript build
- both expose the same HTTP and Socket.IO surface
- each replica exports `/api/metrics`, `/api/health`, `/api/ready`, `/api/live`, `/api/runtime`

### Redis

Redis is used for:

- chat persistence synchronization
- rate-limit storage
- cross-replica socket event fan-out

The app uses a Redis-backed event channel so that a message or file event generated on one replica is re-broadcast to clients connected to the other replica.

### MinIO

MinIO is the main demo object-storage backend.

- uploads are stored there instead of local disk
- preview and download paths still work through the app/edge layer
- the compose lab bootstraps the `sharechat` bucket automatically

### Observability

- `Prometheus` scrapes both replicas
- `Alertmanager` receives alert traffic from Prometheus
- `Grafana` visualizes metrics and alert state

Current dashboard emphasis:

- active socket connections
- chat message throughput
- upload throughput
- upload failures
- rate-limit hits

## Operational Trade-Offs

### Why Redis event fan-out instead of sticky-only sessions

Sticky sessions alone would not solve cross-replica message delivery.
The current design uses:

- `websocket` transport only for the demo
- `Redis` for shared state and replica-to-replica event propagation

That keeps the demo understandable while still covering the key distributed behavior.

### Why MinIO instead of local disk in the main demo

Local disk mode is still supported, but MinIO is more useful for portfolio value because it shows:

- object storage integration
- upload lifecycle handling
- a more production-like storage path

## Failure Model Covered Today

The current lab already proves:

- one replica can serve clients while the other exists in the pool
- a message created on one replica is delivered to a client connected to another replica
- uploads survive the edge path and are readable back through preview/download

The lab does not yet fully automate:

- rolling restart drills
- Redis outage drills
- MinIO outage drills
- local TLS for the compose path
