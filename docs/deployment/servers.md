# Deploy to a server

`sixb deploy` runs your project on a Linux server you reach over SSH. You describe the deployment in `sixb.deploy.ts`. Each deploy sends the commit, builds it on the server, starts it beside the live release, and moves traffic to it once it is healthy, so a deploy never takes the project down.

## Before you start

You need:

- **A server** that meets the [host requirements](host-requirements.md): Ubuntu or Debian with systemd, Caddy, and an account named `sixb` you can reach over SSH. The page has a cloud-init script that sets a new server up.
- **A domain** whose DNS you control. Each service gets its own name under it, so one wildcard record such as `*.example.com` pointing at the server covers them all. Ports 80 and 443 must be open; the server gets an HTTPS certificate for each name automatically.
- **Production providers.** The services run as separate processes, so they need storage, a broker, and queues they can share, such as PostgreSQL and Redis, and [authentication](../auth/authentication.md) configured for production. See [Prepare your configuration](overview.md#prepare-your-configuration). The databases can run on the server or anywhere it can reach.

Add the SSH target to the project:

```bash
bun add @sixb/deploy-ssh
```

The server runs the Bun version that `packageManager` pins in `package.json`, such as `"packageManager": "bun@1.4.4"`. A project created with `bun create sixb` pins it already.

## Describe the deployment

Create `sixb.deploy.ts` in the project root:

```ts
// sixb.deploy.ts
import { defineDeploy } from "@sixb/core/deploy"
import { SshTarget } from "@sixb/deploy-ssh"

export default defineDeploy({
  name: "shop",
  domain: "example.com",
  target: new SshTarget({ host: "203.0.113.10" }),
})
```

This serves the API at `shop-api.example.com` and your app at `shop-app.example.com`. It runs the orchestrator, rules, and workers alongside them.

Preview what will run, without connecting to the server:

```bash
bun sixb deploy --dry-run
```

It lists every process with its command, address, and environment.

| Option | Purpose |
| --- | --- |
| `name` | Names the deployment on the server and in default domains. Lowercase letters, numbers, and hyphens. |
| `domain` | Parent domain for services without their own: `<name>-<service>.<domain>`. |
| `target` | Where the deployment runs. |
| `env` | Environment variables for every service. This file is committed, so keep secrets in the [project's settings](#add-the-projects-settings). |
| `services` | Turn services off or adjust them. |
| `processes` | Long-running scripts of your own, supervised alongside the services. |

Every service gets `NODE_ENV=production` and the [public origins](overview.md#configure-public-origins) of the API and the app, so you do not set those yourself.

### The SSH target

`host` is the server's hostname or IP address, or a `Host` alias from your SSH config. Use an alias to reach SSH on a port other than 22. The deployment runs as `sixb`, one per server.

### Services

Set a service to `false` to turn it off, or pass an object to adjust it:

```ts
export default defineDeploy({
  name: "shop",
  domain: "example.com",
  target: new SshTarget({ host: "203.0.113.10" }),
  services: {
    app: { domain: "shop.example.com" },
    rules: false,
    workers: {
      concurrency: { sync: 4 },
      process: { instances: 2, maxMemory: "1G" },
    },
  },
})
```

The rules process waits idly when the project has no rules; turn it off to save memory. Keep the orchestrator on: it runs cron schedules, delivers events whose first delivery failed, brings back runs that lost their worker, and requests [storage maintenance](../datasets/overview.md#storage-maintenance), which runs in the `lake` worker. Without it a lost sync run stays `running`, and later runs of that sync wait behind it. `sixb deploy` warns when a deployment leaves either out. The `lake` worker also writes the changes [`ingest`](../datasets/ingestion.md) stores, with or without the orchestrator; without that worker they wait, and Console › Lake health shows them.

| Service | Settings |
| --- | --- |
| `api`, `app` | `domain`, `env`, `process` |
| `orchestrator`, `rules` | `env`, `process`. Each always runs as one process. |
| `workers` | `types` (default: every type the project registers work for), `concurrency` per type, `env`, `process` |

`process` sets `maxMemory` (restart a process that grows past a size such as `"512M"`), `killTimeoutMs` (how long a stopping process may take; default 10000, and 70000 for `api` and `workers`, which first wait up to 65 seconds for the Actions they are running and their effects), and `restartDelayMs` (the wait before restarting a process that exited, growing with each restart; default 1000). For `workers` and your own processes, `instances` runs several copies.

### Your own processes

Run a script of your own next to the services, restarted like them if it exits:

```ts
processes: {
  "price-feed": { entrypoint: "scripts/price-feed.ts", args: ["--live"] },
},
```

It runs with Bun from the project directory and gets the same environment as the services.

## Check the server

```bash
bun sixb deploy check
```

It checks every [host requirement](host-requirements.md) and where each domain points, changes nothing, and says what to do about each problem. `sixb deploy` runs the same checks first, and stops before uploading anything when one would make the deploy fail.

## Add the project's settings

To keep them in one place across your team and servers, use [environment variables from Doppler](environment-variables.md#deploy). A deploy then writes the server's `.env` for you, and you can skip the rest of this section.

Otherwise, secrets and connection strings, such as `DATABASE_URL`, API keys, and anything else you keep out of the repository, go in `~/<name>/shared/.env` on the server. Create it readable only by `sixb`, then edit it:

```bash
ssh sixb@203.0.113.10 'mkdir -p ~/shop/shared && install -m 600 /dev/null ~/shop/shared/.env'
ssh -t sixb@203.0.113.10 'nano ~/shop/shared/.env'
```

Every release reads this one file, so `sixb deploy restart` applies an edit. Without a [source](environment-variables.md), a deploy never replaces it, even when the repository has a `.env`.

## Deploy

Commit your changes, then deploy:

```bash
bun sixb deploy
```

Only committed files are sent, with submodules at their recorded commits. Uncommitted changes and ignored files stay on your machine. `--ref <branch|tag|commit>` deploys something other than the checked-out commit.

A deploy:

1. Checks the server.
2. Unpacks the commit into its own `releases/<id>` folder, then installs the pinned Bun and the dependencies.
3. [Writes `.env`](environment-variables.md#deploy) into the release if the project has a source, and runs `sixb build` (carrying one generation of hashed browser chunks forward, so open tabs never `404`).
4. Runs `sixb check --migrate --lake` from the new release: it brings the storage schema up to date, checks every provider, and checks the lake's datasets.
5. Starts the new release beside the live one, on its own ports, without its singletons (`orchestrator`, `rules` and your processes). It waits for the API's `/ready`, and fails if a process exits in its first seconds.
6. Moves Caddy's routes to the new release, then moves the singletons, and checks again.
7. Lets the previous release finish its requests and agent turns for up to five minutes, then stops it. A deploy within those minutes gives it ten more seconds.

Any failure before the routes move leaves the live release serving; a failure after it moves the routes and singletons back. Either way, the deploy says what failed. The server runs the deploy, so closing your laptop or losing the connection doesn't stop it: `sixb deploy status` shows the release once it ends. Two deploys of the same project never overlap; the second waits for the first.

A release with storage migrations is the exception: the live release was built for the schema before them, so it stops while they run, and the new release starts cold once they're done. The cutover takes as long as the migrations and the new release's start, usually seconds. A failure after the services stopped starts the previous release again.

## Operate the deployment

| Command | Purpose |
| --- | --- |
| `sixb deploy status` | Show each process with its memory, CPU, and restarts, and the deployed commit. |
| `sixb deploy logs [service]` | Print recent log lines. `--follow` keeps printing; `--tail <lines>` sets how many (default 100). |
| `sixb deploy restart [service]` | Restart one service, or all of them. `stop` and `start` work the same way. |
| `sixb run --deployed <script>` | Run a one-off [script](../fundamentals/scripts.md) on the deployment, with its environment. |

A process that exits is restarted automatically, and the services start when the server boots, without anyone logging in.

To return to an earlier release, deploy its commit with `--ref`. Storage migrations are not reversed.

## Next steps

- [Deploy from GitHub Actions](github-actions.md) on every push.
- [Host requirements](host-requirements.md): what a server provides, with a cloud-init script.
- The [Northline example](https://github.com/sixb-ai/sixb/tree/main/examples/northline#deploy) deploys this way, with PostgreSQL and Redis.
