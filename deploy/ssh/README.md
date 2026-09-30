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

## First deploy

Start from a fresh Ubuntu or Debian server you can reach over SSH as root, or as a user with sudo:

```sh
sixb deploy setup --admin ademattos   # once per server; asks for sudo if needed
ssh sixb@203.0.113.10 'install -m 600 /dev/null ~/northline/code/.env'
ssh -t sixb@203.0.113.10 'nano ~/northline/code/.env'   # the project's secrets
sixb deploy
```

Point each domain at the server before the first deploy, so Caddy can get certificates for it.

## Commands

| Command | Does |
| --- | --- |
| `sixb deploy setup` | Prepares the server and the deploy user. `--admin <login>` is who logs in to do it (default `root`); `--key <file>` is the key to authorize (default: the one SSH would use). Safe to run again. |
| `sixb deploy check` | Checks the server, the project, its ports, and its DNS, changing nothing. Exits 1 when a deploy would fail. |
| `sixb deploy` | Runs the checks, then deploys the committed `HEAD`. `--ref <ref>` deploys another branch, tag, or commit. |
| `sixb deploy --dry-run` | Prints every process with its command, address, and environment, without deploying. |
| `sixb deploy status` | Shows each process and the deployed commit. |
| `sixb deploy logs [service]` | Prints recent log lines; `--follow` keeps printing, `--tail <lines>` sets how many. |
| `sixb deploy restart [service]` | Restarts one service, or all of them. Also `start` and `stop`. |
| `sixb deploy ci` | Deploys from GitHub Actions on every push to the default branch, or to `--branch <name>`. See below. |
| `sixb deploy access list` | Lists the keys that can deploy, with their fingerprints. |
| `sixb deploy access add <key>` | Authorizes a key: a `.pub` file, the key's text, or `github:<user>` for that account's keys. |
| `sixb deploy access remove <match>` | Revokes the keys with that fingerprint or comment. Never removes the last key. |

## Deploying from GitHub Actions

Run `sixb deploy ci` from the project, with the [GitHub CLI](https://cli.github.com) logged in as
someone who can change the repository's settings. It:

1. Makes a new SSH key for the repository's deploys and authorizes it on the server, restricted to
   running commands: no port forwarding, no terminal. The private key goes straight to GitHub and
   is never written anywhere else.
2. Stores it, with the server's host keys, as secrets of the repository's `production` environment.
   The host keys are read over your own connection, which SSH has already checked, so CI never
   trusts whatever answers at the address.
3. Revokes the keys it made for this repository before, once GitHub holds the new one. Run the
   command again to rotate the key.
4. Writes `.github/workflows/deploy-<name>.yml`. Commit it and push.

The workflow reads only the repository (`contents: read`), runs one deploy at a time, and uses
actions pinned by commit. Add protection rules to the `production` environment in the repository's
settings to require an approval before each deploy.

Submodules are checked out at their recorded commits. When one is private, CI's own token cannot
read it: create a fine-grained token with read access to its contents, and store it with
`gh secret set SIXB_GITHUB_TOKEN --env production`. The workflow stops with that name when it is
missing.

CI connects to the server directly, so `host` must be an address GitHub can reach. When
`sixb.deploy.ts` reads environment variables, add them to the workflow's `env`.

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

`sixb deploy setup` logs in as the admin once and leaves the server like this; `sixb deploy check`
reports anything that is missing. The server runs Ubuntu or Debian with systemd, Caddy, `git`,
`curl`, and `unzip`, and has a deploy user:

- linger enabled (`loginctl enable-linger <user>`), so its services start at boot;
- your SSH key in its `authorized_keys`;
- in the `sixb-deploy` group, which may run `sudo systemctl reload caddy` and nothing else;
- owning `/etc/caddy/sixb.d/<user>/`, which Caddy loads through a root-owned
  `/etc/caddy/sixb.d/<user>.caddy` holding `import /etc/caddy/sixb.d/<user>/*.caddy`. The root
  Caddyfile imports those with `import /etc/caddy/sixb.d/*.caddy`; Caddy allows only one `*` per
  import pattern.

Keep Caddy's admin API off `localhost:2019`, where any local process could change every route: set
`admin unix//var/lib/caddy/admin.sock` in the root Caddyfile's global options. Setup does this when
the Caddyfile is still the one Caddy's package installed. A server that already serves other sites
keeps its Caddyfile, gains the one import line, and keeps a copy of the previous file in
`/etc/caddy/Caddyfile.before-sixb-deploy`.

Setup adds the admin to the deploy user's group, so the admin can read every project under that
user without sudo; `.env` files stay readable only by the deploy user. It reports, but never
changes, an SSH server that accepts passwords or a firewall that blocks ports 80 and 443.

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
