# Host requirements

`sixb deploy` ships releases to a server that already has what they need. It never runs as root and never installs anything: whatever prepares your servers, such as cloud-init, Terraform, Ansible or a person, provides these once.

| Requirement | Why |
| --- | --- |
| Ubuntu or Debian with systemd, on x64 or arm64, with `curl`, `unzip`, `tar`, `flock`, `setsid`, `sha256sum`, `ss` and GNU `stat` | Bun runs there, and the deploy uses those tools. |
| An account you can reach over SSH, not `root`, with lingering on (`loginctl enable-linger <account>`) | The deployment runs as that account, and lingering starts its services at boot. Name it anything; these examples call it `deploy`. |
| [Caddy](https://caddyserver.com) 2.7 or later, as described below | Caddy routes each domain to its service and gets its HTTPS certificate. |
| The project's settings: an [env token](environment-variables.md#deploy) at `~/<name>/env-token` (none for a source that reads with the server's own identity, such as a [Key Vault managed identity](environment-variables.md#read-with-the-servers-managed-identity)), or a `.env` at `~/<name>/shared/.env`, readable only by the account (mode 600) | A deploy pulls `.env` with the token, or links the `.env` you keep on the server. `<name>` is the deployment's `name`. |
| Outbound HTTPS to GitHub, the npm registry and your env source | A deploy downloads Bun and the dependencies. |
| Ports 80 and 443 open | Caddy answers on them, and Let's Encrypt checks them. |
| For a project that uses Playwright: Chromium's system libraries (`npx playwright install-deps chromium`, as root) | Playwright downloads its own browser, but not the libraries it needs. |

A server runs one deployment. Its services listen on loopback ports, 3001 and 3002 or 3011 and 3012: each release starts on the pair the live one doesn't use.

## Caddy

The Caddyfile imports the routes each deploy writes. We recommend keeping Caddy's admin API off `localhost:2019`, where any process on the server could change every route; the deploy doesn't use it:

```caddyfile
# /etc/caddy/Caddyfile
{
	admin unix//var/lib/caddy/admin.sock
}

import /etc/caddy/sixb.d/*.caddy
```

Each account writes its routes in a folder of its own: `/etc/caddy/sixb.d/deploy.caddy` holds one line, `import /etc/caddy/sixb.d/deploy/*.caddy`, and the `deploy` account owns `/etc/caddy/sixb.d/deploy/`. One sudoers entry lets it apply new routes, and nothing else:

```text
# /etc/sudoers.d/deploy
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl reload caddy
```

## Example: cloud-init

This prepares a new Ubuntu server for a deployment named `shop`, run by an account named `deploy`. Add your own access: an SSH key for `deploy`, or Tailscale SSH.

```yaml
#cloud-config
package_update: true
packages: [curl, unzip, ca-certificates, gnupg]

users:
  - default
  - name: deploy
    shell: /bin/bash
    lock_passwd: true
    ssh_authorized_keys: ["ssh-ed25519 AAAA… you@laptop"]

write_files:
  - path: /etc/sudoers.d/deploy
    permissions: "0440"
    content: "deploy ALL=(root) NOPASSWD: /usr/bin/systemctl reload caddy\n"
  - path: /etc/caddy/Caddyfile
    defer: true
    content: |
      {
      	admin unix//var/lib/caddy/admin.sock
      }

      import /etc/caddy/sixb.d/*.caddy
  - path: /etc/caddy/sixb.d/deploy.caddy
    defer: true
    content: "import /etc/caddy/sixb.d/deploy/*.caddy\n"

runcmd:
  - curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  - curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  - apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -yq -o Dpkg::Options::=--force-confold caddy
  - install -d -m 0755 -o deploy -g deploy /etc/caddy/sixb.d/deploy
  - loginctl enable-linger deploy
  - install -d -m 0700 -o deploy -g deploy /home/deploy/shop /home/deploy/shop/shared
  - systemctl restart caddy
```

Then put the project's settings on the server: its env token, or its `.env`. In `sixb.deploy.ts`, `new SshTarget({ host, user: "deploy" })` deploys as that account; leave `user` out when your SSH config names it.

## Check a server

```bash
bun sixb deploy check
```

It checks each requirement as the deploy account, changes nothing, and names what is missing. For what a command fixes, such as the Caddy folder, the sudoers line or lingering, it prints the commands to run once on the server as root, filled in for this account and deployment. It also says where each domain points. `sixb deploy` runs the same checks first, and stops before uploading anything when one fails.
