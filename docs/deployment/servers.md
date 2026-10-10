# Deploy to a server

`sixb deploy` runs your project on a Linux server you reach over SSH. You describe the deployment in `sixb.deploy.ts`. The CLI prepares the server once, then on each deploy sends the commit, builds it on the server, runs every service under an account without root access, and serves each one on its own domain over HTTPS.

## Before you start

You need:

- **A server** running Ubuntu or Debian with systemd, such as a new virtual machine from a cloud provider, with an account that can use `sudo`, or `root`. You use that account once, to set the server up.
- **A domain** whose DNS you control. Each service gets its own name under it, so one wildcard record such as `*.example.com` pointing at the server covers them all. Ports 80 and 443 must be open; the server gets an HTTPS certificate for each name automatically.
- **Production providers.** The services run as separate processes, so they need storage, a broker, and queues they can share, such as PostgreSQL and Redis, and [authentication](../auth/authentication.md) configured for production. See [Prepare your configuration](overview.md#prepare-your-configuration). The databases can run on the server or anywhere it can reach.

Add the SSH target to the project:

```bash
bun add @sixb/deploy-ssh
```

The server runs the Bun version that `packageManager` pins in `package.json`, such as `"packageManager": "bun@1.4.2"`. A project created with `bun create sixb` pins it already.

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

This serves the API at `shop-api.example.com`, Atlas at `shop-atlas.example.com`, and your app at `shop-app.example.com`. It runs the orchestrator, scheduler, rules, and workers alongside them.

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
| `env` | Environment variables for every service. This file is committed, so keep secrets in the server's [`.env`](#add-the-projects-settings). |
| `services` | Turn services off or adjust them. |
| `processes` | Long-running scripts of your own, supervised alongside the services. |

Every service gets `NODE_ENV=production` and the [public origins](overview.md#configure-public-origins) of the API, Atlas, and app, so you do not set those yourself.

### The SSH target

| Option | Default | Purpose |
| --- | --- | --- |
| `host` | | The server's hostname or IP address, or a `Host` alias from your SSH config. Use an alias to reach SSH on a port other than 22. |
| `user` | `"sixb"` | The account the services run as. Never `root`. See [Several projects on one server](server-access.md#several-projects-on-one-server). |
| `ports` | Atlas 3000, app 3001, API 3002 | The local port each domain is forwarded to. Give each project on a server its own. |

### Services

Set a service to `false` to turn it off, or pass an object to adjust it:

```ts
export default defineDeploy({
  name: "shop",
  domain: "example.com",
  target: new SshTarget({ host: "203.0.113.10" }),
  services: {
    app: { domain: "shop.example.com" },
    scheduler: false,
    workers: {
      concurrency: { sync: 4 },
      process: { instances: 2, maxMemory: "1G" },
    },
  },
})
```

Turn off `app` when the project has no custom app. The scheduler and rules processes wait idly when the project has no schedules or rules; turn them off to save memory.

| Service | Settings |
| --- | --- |
| `api`, `atlas`, `app` | `domain`, `env`, `process` |
| `orchestrator`, `scheduler`, `rules` | `env`, `process`. Each always runs as one process. |
| `workers` | `types` (default: every type the project registers work for), `concurrency` per type (action jobs run one at a time), `agentTurnTimeout` such as `"10m"`, `env`, `process` |

`process` sets `maxMemory` (restart a process that grows past a size such as `"512M"`), `killTimeoutMs` (how long a stopping process may take; default 10000, and 40000 for `api`, which first waits up to 35 seconds for the Actions it is running), and `restartDelayMs` (the wait before restarting a process that exited, growing with each restart; default 1000). For `workers` and your own processes, `instances` runs several copies.

### Your own processes

Run a script of your own next to the services, restarted like them if it exits:

```ts
processes: {
  "price-feed": { entrypoint: "scripts/price-feed.ts", args: ["--live"] },
},
```

It runs with Bun from the project directory and gets the same environment as the services.

## Set up the server

Run this once per server, naming an account with `sudo` (default: `root`):

```bash
bun sixb deploy setup --admin ademattos
```

Setup logs in as that account only when the server needs something, and:

- installs [Caddy](https://caddyserver.com), the web server that routes each domain to its service and handles HTTPS;
- creates the deploy account, `sixb` by default, which accepts your SSH key and no password, and lets its services start at boot;
- lets the deploy account reload Caddy, and nothing else that needs root;
- adds your admin account to the deploy account's group, so it can read the projects without `sudo`.

`--key <file>` authorizes a different public key than the one SSH uses for the server. On a server where Caddy already serves other sites, setup keeps its configuration, adds one import line, and saves the previous file as `/etc/caddy/Caddyfile.before-sixb-deploy`. Setup reports an SSH server that accepts passwords, or a firewall that blocks ports 80 and 443, but changes neither.

Setup is safe to run again. More projects under the same deploy account need no admin login.

Check the server at any time without changing anything:

```bash
bun sixb deploy check
```

It checks the server's tools, the deploy account, the routes, the project's `.env`, its ports, the free disk space, and where each domain points, and says what to do about each problem. `sixb deploy` runs the same checks first, and stops before uploading anything when one would make the deploy fail.

## Add the project's settings

Secrets and connection strings, such as `DATABASE_URL`, API keys, and anything else you keep out of the repository, go in a `.env` file in the project's directory on the server. Create it readable only by the deploy account, then edit it:

```bash
ssh sixb@203.0.113.10 'install -m 600 /dev/null ~/shop/code/.env'
ssh -t sixb@203.0.113.10 'nano ~/shop/code/.env'
```

For a project inside a monorepo, the directory is `~/<name>/code/<path>`; `sixb deploy check` prints the exact path. A deploy never replaces the server's `.env`, even when the repository has one.

## Deploy

Commit your changes, then deploy:

```bash
bun sixb deploy
```

Only committed files are sent, with submodules at their recorded commits. Uncommitted changes and ignored files stay on your machine. `--ref <branch|tag|commit>` deploys something other than the checked-out commit.

A deploy:

1. Checks the server.
2. Sends the commit and updates the project's files. The server's `.env`, `.sixb/`, and `node_modules/` stay.
3. Installs the pinned Bun and the dependencies, and runs `sixb build`.
4. Updates the routes. Caddy must accept them first; otherwise the deploy stops and the previous routes keep working.
5. Stops the services, runs `sixb db migrate`, `sixb check`, and `sixb lake check`, and starts the services again.
6. Waits for the API's `/ready`, and fails if a process exits in the seconds after.

The services are down during step 5. Meanwhile, browsers opening Atlas or your app get an "Updates in progress" page.

A deploy that fails before the services stop leaves them running. One that fails later leaves them stopped until a deploy succeeds: fix the cause and deploy again, or deploy the previous commit with `--ref`. Two deploys of the same project never overlap; the second waits for the first.

## Operate the deployment

| Command | Purpose |
| --- | --- |
| `sixb deploy status` | Show each process with its memory, CPU, and restarts, and the deployed commit. |
| `sixb deploy logs [service]` | Print recent log lines. `--follow` keeps printing; `--tail <lines>` sets how many (default 100). |
| `sixb deploy restart [service]` | Restart one service, or all of them. `stop` and `start` work the same way. |

A process that exits is restarted automatically, and the services start when the server boots, without anyone logging in.

To return to an earlier release, deploy its commit with `--ref`. Storage migrations are not reversed.

## Next steps

- [Deploy from GitHub Actions](github-actions.md) on every push.
- [Server accounts and access](server-access.md): give teammates access, and run several projects on one server.
- The [Northline example](https://github.com/sixb-ai/sixb/tree/main/examples/northline#deploy) deploys this way, with PostgreSQL and Redis.
