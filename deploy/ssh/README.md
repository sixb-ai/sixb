# @sixb/deploy-ssh

Deploy a Sixb project to a Linux server you reach over SSH. `sixb deploy` sends the commit, builds
it on the server, runs every service under an unprivileged deploy user, and routes each domain to
its service through Caddy.

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

| Option | Default | Description |
| --- | --- | --- |
| `host` | — | The server: a hostname, an IP address, or a `Host` alias from your SSH config. Use an alias for an SSH port other than 22. |
| `user` | `"sixb"` | The Linux user the deployment runs as. Projects under one user can read each other's files; give a project its own user to wall it off. Never `root`. |
| `ports` | atlas 3000, app 3001, api 3002 | Local ports Caddy forwards to. Set them when projects share a server so that each has its own. |

Add `@sixb/cli` and `@sixb/deploy-ssh` to the project's dependencies, and pin Bun with
`"packageManager": "bun@1.4.2"` in its `package.json`; the server runs that version.

## Commands

| Command | Does |
| --- | --- |
| `sixb deploy` | Deploys the committed `HEAD`. `--ref <ref>` deploys another branch, tag, or commit. |
| `sixb deploy --dry-run` | Prints every process with its command, address, and environment, without deploying. |
| `sixb deploy status` | Shows each process and the deployed commit. |
| `sixb deploy logs [service]` | Prints recent log lines; `--follow` keeps printing, `--tail <lines>` sets how many. |
| `sixb deploy restart [service]` | Restarts one service, or all of them. Also `start` and `stop`. |

## What a deploy does

1. Sends the committed files, with submodules at their recorded commits. Uncommitted and ignored
   files are never sent, and a committed `.env` never replaces the server's.
2. Takes the deployment's lock, so a second deploy waits for the first.
3. Updates the project the way `git reset --hard` would: files removed from the commit are removed,
   while `.env`, `.sixb/`, and `node_modules/` stay.
4. Installs the pinned Bun, then the dependencies, then runs `sixb build`.
5. Updates the Caddy routes when they changed. Caddy has to accept the whole configuration first;
   otherwise the previous routes stay and the deploy stops, with the previous release still
   serving.
6. Stops the services, runs `sixb db migrate` and `sixb lake check`, and starts them again. Pages
   requested while the app or Atlas is down get an "Updates in progress" page.
7. Waits for the API's `/ready`, and fails if any process exits in the seconds after.

## The server

The server needs Ubuntu or Debian with systemd, Caddy, `curl`, and `unzip`, and a deploy user:

- linger enabled (`loginctl enable-linger <user>`), so its services start at boot;
- your SSH key in its `authorized_keys`;
- in the `sixb-deploy` group, which may run `sudo systemctl reload caddy` and nothing else;
- owning `/etc/caddy/sixb.d/<user>/`, which Caddy loads through a root-owned
  `/etc/caddy/sixb.d/<user>.caddy` holding `import /etc/caddy/sixb.d/<user>/*.caddy`. The root
  Caddyfile imports those with `import /etc/caddy/sixb.d/*.caddy`; Caddy allows only one `*` per
  import pattern.

Keep Caddy's admin API off `localhost:2019`, where any local process could change every route: set
`admin unix//var/lib/caddy/admin.sock` in the root Caddyfile's global options.

Put the project's secrets in `.env` in its directory on the server, readable only by the deploy
user: `~/<name>/code/.env`, or `~/<name>/code/<path>/.env` for a project inside a monorepo.

Each deployment lives in the deploy user's home:

```
~/<name>/code      the deployed commit
~/<name>/deploy    the lock, uploads, file list, release record, and process manifest
~/<name>/run       process state and logs
~/.sixb/bun/<v>    Bun, shared by the user's projects on the same version
```

Projects on one server share Caddy, so they trust each other for routing, and they can reach each
other's local ports. Give projects their own credentials on a shared database or Redis. Put
projects that must share nothing on separate servers.
