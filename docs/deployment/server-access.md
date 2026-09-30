# Server accounts and access

A server set up with `sixb deploy setup` has three kinds of access, each limited to what it is for:

| Account | Used by | Can |
| --- | --- | --- |
| Your admin account | You, to set the server up | Do anything, with `sudo`. `sixb deploy` uses it only for `setup`. |
| The deploy account (`sixb`) | `sixb deploy` and the services it runs | Manage its own files and processes, and reload Caddy. No other `sudo`, and no password: SSH keys only. |
| A CI key | [GitHub Actions](github-actions.md) | Run commands as the deploy account, without port forwarding or a terminal. |

## Give people access

Everyone who deploys or operates the project needs their SSH key authorized on the deploy account:

```bash
bun sixb deploy access list
bun sixb deploy access add ~/Downloads/teammate.pub
bun sixb deploy access add github:octocat
bun sixb deploy access remove teammate@laptop
```

`add` takes a `.pub` file, a key's text, or `github:<user>` for every key on that GitHub account. `remove` takes a key's fingerprint or comment, and refuses to remove the last key. Anyone with access can run every `sixb deploy` command, including `access`.

## Look around on the server

Log in with your admin account. It belongs to the deploy account's group, so it can read each project's code and logs without `sudo`:

| Path | Holds |
| --- | --- |
| `/home/sixb/<name>/code` | The deployed commit, and `.env`. |
| `/home/sixb/<name>/run/logs` | Each process's log. |

Group membership takes effect at your next login after setup. Reading `.env` takes `sudo`. To work as the deploy account:

```bash
sudo -iu sixb
systemctl --user status sixb-<name>
```

## Several projects on one server

Projects can share a server. Give each project its own `ports`; `sixb deploy check` reports a port that another program or deployment already uses:

```ts
target: new SshTarget({
  host: "203.0.113.10",
  ports: { atlas: 3010, app: 3011, api: 3012 },
}),
```

Projects under the same deploy account need no admin login after the first, and each can read the others' files, `.env` included. To wall a project off, give it its own account, and run `sixb deploy setup` for it once to create the account:

```ts
target: new SshTarget({ host: "203.0.113.10", user: "acme" }),
```

## What separate accounts do and do not cover

Separate deploy accounts cannot read each other's files, stop each other's processes, or change each other's routes. They still share:

- **Caddy**, which serves every project's domains. Any deploy account can add routes, so the accounts trust each other not to claim each other's domains.
- **The network.** Any process on the server can connect to another project's local ports.
- **Databases and Redis on the server.** Give each project its own credentials.
- **The admin account**, which can read every project.

`sixb deploy check` warns when Caddy's admin API listens on `localhost:2019`, where any process on the server could change every route. When the Caddyfile is still the one Caddy's package installed, setup moves the admin API to a socket only root and Caddy can use. On a server where Caddy already served other sites, set `admin unix//var/lib/caddy/admin.sock` in the Caddyfile's global options yourself.

Projects that must share nothing belong on separate servers.
