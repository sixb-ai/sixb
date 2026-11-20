# @sixb/deploy-ssh

The SSH target for `sixb deploy`. It runs a Sixb project on a Linux server you reach over SSH, as
the account `sixb`, with Caddy serving each domain over HTTPS, and ships each release without
downtime.

```ts
// sixb.deploy.ts
import { defineDeploy } from "@sixb/core/deploy"
import { SshTarget } from "@sixb/deploy-ssh"

export default defineDeploy({
  name: "northline",
  domain: "example.com",
  target: new SshTarget({ host: "203.0.113.10" }),
})
```

- [Deploy to a server](https://docs.sixb.ai/deployment/servers): the options and commands.
- [Host requirements](https://docs.sixb.ai/deployment/host-requirements): what a server provides.
- [Deploy from GitHub Actions](https://docs.sixb.ai/deployment/github-actions).

## How it works

The rest of this file is for working on the package. The package never sets a server up: it checks
the host requirements (`src/check/`) and ships releases.

### On the server

```
~/<name>/releases/<id>   immutable releases: code, node_modules, .sixb/dist, .env
~/<name>/current         the live release; `code` points here too
~/<name>/shared/.env     the `.env` kept on the server, for a project without a source
~/<name>/env-token       the token a deploy pulls `.env` with, for a project with one
~/<name>/deploy/         lock, uploads and run logs, release record, live slot, slot files, ctl
~/<name>/run/<slot>/     each slot's supervisor state, control requests and logs
~/.sixb/bun/<version>    Bun, shared by releases on the same version
```

- **Slots.** A deployment runs in one of two slots, blue (ports 3001/3002) and green (3011/3012).
  Each is an instance of the template unit `~/.config/systemd/user/sixb-<name>@.service`, whose
  `ExecStart` is the slot's launcher, `deploy/<slot>`: its release's supervisor
  (`src/server/supervisor.ts`) with that release's Bun, over `deploy/<slot>.json`. Lingering starts
  the live slot at boot. Stopping a slot's service signals only the supervisor (`KillMode=mixed`),
  which gives the API and workers up to five minutes to finish their work; the next deploy gives
  a slot still draining ten seconds more before it takes the slot over.
- **The supervisor** restarts a process that exits, waiting `restartDelayMs` times its restart
  count up to a cap, restarts one past `maxMemory`, and rotates logs at 20 MB. A manifest with
  `holdExclusive` leaves the singletons and project scripts stopped until a deploy starts them.
- **Routes.** Each deployment writes `/etc/caddy/sixb.d/sixb/<name>.caddy`, which the root
  Caddyfile imports. A deploy validates the whole configuration before
  `sudo systemctl reload caddy`, and puts the previous routes back when Caddy rejects the new ones.
  The app answers 502, 503 and 504 with the update page in `src/update-page.ts`. Caddy compresses
  the API's complete JSON responses; it keeps WebSockets open through a reload with
  `stream_close_delay`, so a retiring API can ask pages to reconnect.
- **`deploy/ctl`** runs the live release's server half (`src/server/cli.ts`); `status`, `logs`,
  `restart`, `start`, `stop` and `run` go through it.

### A deploy

1. **Laptop** (`src/operations.ts`): `git archive` of the repository and each submodule, streamed
   into `deploy/incoming/`, then the plan (`src/plan.ts`) and `src/bootstrap.sh` into
   `deploy/runs/`. The bootstrap starts with `setsid`, detached from the SSH session, and the
   laptop follows its log with `tail --pid` until the RFC 7464 event that carries its exit code.
2. **Bootstrap** (`src/bootstrap.sh`): takes `deploy/lock`, unpacks the release, installs the
   pinned Bun and the dependencies, then runs the release's own runner, which inherits the lock.
3. **Runner** (`src/server/release.ts`): pulls `.env`, builds, runs `sixb check --migrate --lake`,
   starts the idle slot, waits until it is healthy, moves the routes, moves the singletons, checks
   again, then makes the slot live and stops the other one. Each step that changes what serves
   records an undo; a failure runs them in reverse, so the live release serves throughout. The
   runner reaches systemd, Caddy and the supervisors through `ReleaseHost`, which the tests fake.

A server from before slots runs one unit, `sixb-<name>.service`. The first slot deploy adopts it as
the live slot, on the ports its manifest records, and retires it once the new slot serves.

### Testing

`bun test deploy/ssh/tests` runs the unit tests: the rollout against a fake server
(`release.test.ts`), the bootstrap with stand-in tools, the probe and its judge, the supervisor.
`tests/server.e2e.ts` deploys Northline to a real server and drives it through the CLI:

```bash
SIXB_DEPLOY_TEST_HOST=203.0.113.10 SIXB_DEPLOY_TEST_DOMAIN=example.com \
  bun test ./deploy/ssh/tests/server.e2e.ts
```
