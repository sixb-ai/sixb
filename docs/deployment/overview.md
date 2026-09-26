# Deployment

Deploy a Sixb project as services that share the same configuration and persistent providers. The CLI builds your project and starts each service.

## Prepare your configuration

Use shared [infrastructure providers](../infrastructure/overview.md) for storage, datasets, files, events, and queues. In-memory providers cannot share state between production processes.

Configure [authentication](../auth/authentication.md), and provide the same project ID, credentials, and OAuth encryption key to each service. Keep these settings in your deployment environment.

## Configure public origins

Set the public addresses of the API, Atlas, and your custom app:

```bash
export SIXB_API_PUBLIC_ORIGIN=https://api.example.com
export SIXB_ATLAS_PUBLIC_ORIGIN=https://atlas.example.com
export SIXB_APP_PUBLIC_ORIGIN=https://app.example.com
```

Omit the app origin if your project has no custom app. Origins contain only the scheme, host, and optional port, with no path. They configure browser access and authentication redirects; they are separate from the host and port a process binds to.

Serve these public origins over HTTPS. Atlas and the custom app connect to the API; they do not serve API routes themselves.

## Run behind a proxy

The API records each client's IP address for sessions and access tokens, and limits CLI login requests per address. Behind a reverse proxy or load balancer, it reads the client from `X-Forwarded-For`, but only the entries appended by proxies it trusts. Entries a client sends itself are ignored.

By default the API trusts proxies on loopback, private, and link-local networks. This covers a proxy on the same host (such as Caddy or nginx), Docker and Kubernetes networking, and most hosting platforms. If a proxy with a public address sits in front, such as a CDN, add its ranges:

```bash
export SIXB_TRUSTED_PROXIES=private,173.245.48.0/20,103.21.244.0/22
```

The value is a comma-separated list of IP addresses, CIDR ranges, and `private`; it replaces the default. If sessions show your proxy's address instead of the client's, that proxy is missing from the list.

## Build and validate

Build the runtime and browser assets, then validate the deployed configuration. This example runs migrations as a separate release step:

```bash
bun sixb build
bun sixb db migrate --entry .sixb/dist/sixb.config.js
bun sixb check --entry .sixb/dist/sixb.config.js
bun sixb lake check --entry .sixb/dist/sixb.config.js
```

Run these with the production provider settings. `check` verifies project configuration and provider health; `lake check` validates dataset definitions against the lake catalog.

Deploy `.sixb/dist`, installed dependencies, and any files your application reads at runtime. Start services from the project root. Production commands use `.sixb/dist/sixb.config.js` when present; use `--entry` for a different build location.

## Start services

Run each needed command as a separate managed process or container:

| Command | Purpose |
| --- | --- |
| `bun sixb api` | Serve the HTTP API, WebSockets, and API docs. |
| `bun sixb atlas` | Serve Atlas. |
| `bun sixb app` | Serve your custom app, if present. |
| `bun sixb orchestrator` | Dispatch event-triggered work. |
| `bun sixb worker-group` | Run workers for the project's registered work. |
| `bun sixb scheduler` | Run cron schedules, if used. |
| `bun sixb rules` | Evaluate rules, if used. |

Keep at least one API process running for event recovery and maintenance. Start workers and rules before the orchestrator and scheduler. On shutdown, stop producers before workers.

In development, `bun sixb dev` starts these services together. Use the separate commands in production so your process manager can restart and scale them independently.

## Migrations

API, worker, scheduler, orchestrator, and rules processes apply storage migrations at startup. If your release step already ran them, pass `--no-migrate` or set `SIXB_SKIP_MIGRATION=1` on those processes.

PostgreSQL serializes concurrent migrations. With SQLite, run migrations separately before starting multiple processes against the same file.

## Scaling and health

API and browser services can run multiple replicas. Queue workers can also scale through replicas or [concurrency settings](../cli/overview.md#worker-options).

Run only **one orchestrator, one scheduler, and one rules process** per project. Multiple instances can duplicate work.

Configure your platform's health checks against the API:

| Endpoint | Purpose |
| --- | --- |
| `/health` | Check that the API process is alive. |
| `/ready` | Check that storage is reachable and its schema is current. Returns `503` when unavailable. |

Inspect failed runs in Atlas and configure [failure notifications](../logging/overview.md#report-failures). A failed external operation may have partially completed; check its outcome before retrying.
