# Host requirements

`sixb deploy` ships releases to a server that already has what they need. It never runs as root and never installs anything: whatever prepares your servers, such as cloud-init, Terraform, Ansible or a person, provides these once.

| Requirement | Why |
| --- | --- |
| Ubuntu or Debian with systemd, on x64 or arm64, with `curl`, `unzip`, `tar`, `flock`, `setsid`, `sha256sum`, `ss` and GNU `stat` | Bun runs there, and the deploy uses those tools. |
| An account named `sixb` that you can reach over SSH, with lingering on (`loginctl enable-linger sixb`) | Every deployment runs as `sixb`, and lingering starts its services at boot. |
| [Caddy](https://caddyserver.com) 2.7 or later, as described below | Caddy routes each domain to its service and gets its HTTPS certificate. |
| The project's settings: an [env token](environment-variables.md#deploy) at `~/<name>/env-token`, or a `.env` at `~/<name>/shared/.env`, readable only by `sixb` (mode 600) | A deploy pulls `.env` with the token, or links the `.env` you keep on the server. `<name>` is the deployment's `name`. |
| Outbound HTTPS to GitHub, the npm registry and your env source | A deploy downloads Bun and the dependencies. |
| Ports 80 and 443 open | Caddy answers on them, and Let's Encrypt checks them. |
| For a project that uses Playwright: Chromium's system libraries (`npx playwright install-deps chromium`, as root) | Playwright downloads its own browser, but not the libraries it needs. |

A server runs one deployment. Its services listen on loopback ports, 3001 and 3002 or 3011 and 3012: each release starts on the pair the live one doesn't use.

## Caddy

The Caddyfile imports the routes each deploy writes, and keeps Caddy's admin API off `localhost:2019`, where any process on the server could change every route:

```caddyfile
# /etc/caddy/Caddyfile
{
	admin unix//var/lib/caddy/admin.sock
}

import /etc/caddy/sixb.d/*.caddy
```

`/etc/caddy/sixb.d/sixb.caddy` holds one line, `import /etc/caddy/sixb.d/sixb/*.caddy`, and the `sixb` account owns `/etc/caddy/sixb.d/sixb/`. One sudoers entry lets it apply new routes, and nothing else:

```text
# /etc/sudoers.d/sixb
sixb ALL=(root) NOPASSWD: /usr/bin/systemctl reload caddy
```

## Example: cloud-init

This prepares a new Ubuntu server for a deployment named `shop`. Add your own access: an SSH key for `sixb`, or Tailscale SSH.

```yaml
#cloud-config
package_update: true
packages: [curl, unzip, ca-certificates, gnupg]

users:
  - default
  - name: sixb
    shell: /bin/bash
    lock_passwd: true
    ssh_authorized_keys: ["ssh-ed25519 AAAA… you@laptop"]

write_files:
  - path: /etc/sudoers.d/sixb
    permissions: "0440"
    content: "sixb ALL=(root) NOPASSWD: /usr/bin/systemctl reload caddy\n"
  - path: /etc/caddy/Caddyfile
    defer: true
    content: |
      {
      	admin unix//var/lib/caddy/admin.sock
      }

      import /etc/caddy/sixb.d/*.caddy
  - path: /etc/caddy/sixb.d/sixb.caddy
    defer: true
    content: "import /etc/caddy/sixb.d/sixb/*.caddy\n"

runcmd:
  - curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  - curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  - apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -yq -o Dpkg::Options::=--force-confold caddy
  - install -d -m 0755 -o sixb -g sixb /etc/caddy/sixb.d/sixb
  - loginctl enable-linger sixb
  - install -d -m 0700 -o sixb -g sixb /home/sixb/shop /home/sixb/shop/shared
  - systemctl restart caddy
```

Then put the project's settings on the server: its env token, or its `.env`.

## Check a server

```bash
bun sixb deploy check
```

It checks each requirement as `sixb`, changes nothing, and names what is missing. It also says where each domain points. `sixb deploy` runs the same checks first, and stops before uploading anything when one fails.
