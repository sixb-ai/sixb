# @sixb/deploy-ssh

The SSH target for `sixb deploy`. It runs a Sixb project on a Linux server you reach over SSH, under
an account without root access, with Caddy serving each domain over HTTPS.

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

- [Deploy to a server](https://docs.sixb.ai/deployment/servers): the options, setup, and commands.
- [Deploy from GitHub Actions](https://docs.sixb.ai/deployment/github-actions).
- [Server accounts and access](https://docs.sixb.ai/deployment/server-access): who can do what, and
  several projects on one server.

## How it works

The rest of this file is for working on the package.

### On the server

Each deployment lives in its deploy user's home:

```
~/<name>/code      the deployed commit, with the project's .env
~/<name>/deploy    the lock, uploads, file list, release record, process manifest, and ctl
~/<name>/run       process state and logs
~/.sixb/bun/<v>    Bun, shared by the user's projects on the same version
```

- **Processes.** The user unit `~/.config/systemd/user/sixb-<name>.service` runs the supervisor
  (`src/server/`, this package's `sixb-deploy-ssh` bin) over `deploy/processes.json`. The
  supervisor restarts a process that exits, waiting `restartDelayMs` times its restart count up to
  a cap, restarts one past `maxMemory`, and rotates logs at 20 MB. Linger starts the unit at boot.
  `deploy/ctl` is what `status`, `logs`, and `restart` call.
- **Routes.** Each deployment writes `/etc/caddy/sixb.d/<user>/<name>.caddy`. Caddy loads it through
  the root-owned `/etc/caddy/sixb.d/<user>.caddy`, which imports `/etc/caddy/sixb.d/<user>/*.caddy`,
  and the root Caddyfile imports `/etc/caddy/sixb.d/*.caddy`: Caddy allows one `*` per import
  pattern. A deploy runs `caddy validate` on the whole configuration before
  `sudo systemctl reload caddy`, the one command the `sixb-deploy` group may run as root, and puts
  the previous snippet back when Caddy rejects the new one. Atlas and the app answer 502, 503, and
  504 with the update page in `src/update-page.ts`.
- **The deploy.** `src/scripts.ts` renders one script that holds `deploy/lock` throughout and prints
  a marker around each step, which the CLI turns into progress. `code/` is updated like
  `git reset --hard`, using the previous deploy's `deploy/files.txt` to find removed files.

### From your machine

- Each command uses one SSH connection, multiplexed, in batch mode: it never prompts.
  `src/transport.ts` rewords OpenSSH's own failures as what to do about them.
- The source is a `git archive` of the repository and of each submodule at its recorded commit,
  streamed into `deploy/incoming/`.
- `setup` runs `src/setup.ts`'s script as the admin login with a terminal attached, so `sudo` can
  ask for a password. `check` runs `src/check.ts`'s script as the deploy user; it prints one
  `__SIXB_CHECK__` line per check.
- `access` rewrites `authorized_keys` through a rename, and refuses when the file changed since it
  was read. `ci` makes its key in `src/ci.ts`.

### Testing

`bun test deploy/ssh/tests` runs the unit tests. `tests/server.e2e.ts` deploys Northline to a
server that `sixb deploy setup` prepared, and drives it through the CLI:

```bash
SIXB_DEPLOY_TEST_HOST=203.0.113.10 SIXB_DEPLOY_TEST_DOMAIN=example.com \
  bun test ./deploy/ssh/tests/server.e2e.ts
```
