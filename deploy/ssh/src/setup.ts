import { access } from "node:fs/promises"
import { shellQuote } from "./shell"

/** The first line of the Caddyfile the Debian and Ubuntu packages install. */
const PACKAGED_CADDYFILE = "The Caddyfile is an easy way to configure your Caddy web server."

/**
 * Everything that needs root, run once per server and once per deploy user, safe to run again.
 * Afterwards the deploy user needs no sudo but reloading Caddy.
 *
 * Caddy's configuration is taken over only when it is still the one the package installed. A
 * server that already serves other sites keeps its configuration and gains one import line (the
 * old file is kept beside it), and its admin API stays where that configuration puts it.
 */
export function renderAdminScript(input: {
  readonly user: string
  readonly publicKey: string
  readonly admin: string
}): string {
  const user = shellQuote(input.user)
  return [
    "set -euo pipefail",
    `deploy_user=${user}`,
    `public_key=${shellQuote(input.publicKey)}`,
    `admin_login=${shellQuote(input.admin)}`,
    'step() { printf "\\n== %s\\n" "$1"; }',
    // Shows a command's output only when it fails, so a first setup is not pages of apt.
    'quiet() { log="$(mktemp)"; if "$@" > "$log" 2>&1; then rm -f "$log"; else status=$?; tail -n 20 "$log" >&2; rm -f "$log"; return "$status"; fi; }',
    "",
    'step "Server"',
    "if ! command -v apt-get > /dev/null || ! command -v systemctl > /dev/null; then",
    '  echo "sixb deploy needs an Ubuntu or Debian server with systemd." >&2',
    "  exit 1",
    "fi",
    '. /etc/os-release && echo "$PRETTY_NAME"',
    "",
    'step "Packages"',
    "export DEBIAN_FRONTEND=noninteractive",
    'missing=""',
    "for package in git curl unzip ca-certificates gnupg; do",
    // `ii` is installed; `dpkg -s` also succeeds for a removed package whose config it keeps.
    '  dpkg -l "$package" 2> /dev/null | grep -q "^ii" || missing="$missing $package"',
    "done",
    'if [ -n "$missing" ]; then',
    '  echo "Installing$missing"',
    "  quiet apt-get update",
    "  quiet apt-get install -y $missing",
    "fi",
    "if ! command -v caddy > /dev/null; then",
    '  echo "Installing caddy"',
    "  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key |",
    "    gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg",
    "  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list",
    "  quiet apt-get update",
    "  quiet apt-get install -y caddy",
    "fi",
    "echo \"git, curl, unzip, caddy $(caddy version | cut -d' ' -f1)\"",
    "",
    'step "Deploy user $deploy_user"',
    'id "$deploy_user" > /dev/null 2>&1 || useradd --create-home --shell /bin/bash --user-group "$deploy_user"',
    'home="$(getent passwd "$deploy_user" | cut -d: -f6)"',
    'chmod 750 "$home"',
    'install -d -m 0700 -o "$deploy_user" -g "$deploy_user" "$home/.ssh"',
    'touch "$home/.ssh/authorized_keys"',
    'grep -qxF "$public_key" "$home/.ssh/authorized_keys" || echo "$public_key" >> "$home/.ssh/authorized_keys"',
    'chown "$deploy_user:$deploy_user" "$home/.ssh/authorized_keys"',
    'chmod 0600 "$home/.ssh/authorized_keys"',
    'loginctl enable-linger "$deploy_user"',
    'grep -qs XDG_RUNTIME_DIR "$home/.profile" ||',
    '  echo \'export XDG_RUNTIME_DIR="/run/user/$(id -u)"\' >> "$home/.profile"',
    'chown "$deploy_user:$deploy_user" "$home/.profile"',
    // The admin reads every project under this user without sudo; `.env` stays 0600.
    'if [ "$admin_login" != root ]; then usermod -aG "$deploy_user" "$admin_login"; fi',
    'echo "$home, key-only, services start at boot"',
    "",
    'step "Caddy reload"',
    "groupadd -f sixb-deploy",
    'usermod -aG sixb-deploy "$deploy_user"',
    'sudoers="$(mktemp)"',
    "echo '%sixb-deploy ALL=(root) NOPASSWD: /usr/bin/systemctl reload caddy' > \"$sudoers\"",
    'visudo -cf "$sudoers" > /dev/null',
    'install -m 0440 "$sudoers" /etc/sudoers.d/sixb',
    'rm -f "$sudoers"',
    'echo "$deploy_user may run sudo systemctl reload caddy, and nothing else"',
    "",
    'step "Caddy routes"',
    "caddyfile=/etc/caddy/Caddyfile",
    "backup=/etc/caddy/Caddyfile.before-sixb-deploy",
    "install -d -m 0755 /etc/caddy/sixb.d",
    'install -d -m 0755 -o "$deploy_user" -g "$deploy_user" "/etc/caddy/sixb.d/$deploy_user"',
    // Caddy allows one `*` per import pattern, so each deploy user's folder has an index file.
    'printf \'import /etc/caddy/sixb.d/%s/*.caddy\\n\' "$deploy_user" > "/etc/caddy/sixb.d/$deploy_user.caddy"',
    "restart_caddy=0",
    `if [ ! -s "$caddyfile" ] || grep -qF ${shellQuote(PACKAGED_CADDYFILE)} "$caddyfile"; then`,
    '  if [ -f "$caddyfile" ]; then cp "$caddyfile" "$backup"; fi',
    "  cat > \"$caddyfile\" <<'__SIXB_CADDYFILE__'",
    "# Managed by sixb deploy. Each deploy user's routes live in /etc/caddy/sixb.d/<user>/.",
    "{",
    "\t# Only root and Caddy may change the running configuration.",
    "\tadmin unix//var/lib/caddy/admin.sock",
    "}",
    "",
    "import /etc/caddy/sixb.d/*.caddy",
    "__SIXB_CADDYFILE__",
    // A restart, not a reload: the admin address itself moves.
    "  restart_caddy=1",
    "elif ! grep -qF 'import /etc/caddy/sixb.d/*.caddy' \"$caddyfile\"; then",
    '  cp "$caddyfile" "$backup"',
    "  printf '\\n# Routes written by sixb deploy, one folder per deploy user.\\nimport /etc/caddy/sixb.d/*.caddy\\n' >> \"$caddyfile\"",
    '  echo "Kept this server\'s Caddyfile and added one import; the previous one is $backup."',
    "fi",
    'if ! caddy validate --config "$caddyfile" --adapter caddyfile > /tmp/sixb-caddy-validate.log 2>&1; then',
    "  tail -n 5 /tmp/sixb-caddy-validate.log >&2",
    '  if [ -f "$backup" ]; then cp "$backup" "$caddyfile"; fi',
    '  echo "Caddy rejected the configuration; the previous one is back in place." >&2',
    "  exit 1",
    "fi",
    'if [ "$restart_caddy" = 1 ]; then systemctl restart caddy; else systemctl reload caddy; fi',
    'echo "/etc/caddy/sixb.d/$deploy_user"',
    "",
    'step "Checks"',
    // Reported, not changed: editing sshd or the firewall is how people lock themselves out.
    "sshd -T 2> /dev/null | grep -qx 'passwordauthentication yes' &&",
    '  echo "Warning: SSH accepts passwords. Set PasswordAuthentication no in /etc/ssh/sshd_config." || true',
    "sshd -T 2> /dev/null | grep -qx 'permitrootlogin yes' &&",
    '  echo "Warning: root can log in with a password. Set PermitRootLogin prohibit-password." || true',
    "if command -v ufw > /dev/null && ufw status 2> /dev/null | grep -q '^Status: active'; then",
    "  for port in 80 443; do",
    '    ufw status | grep -qE "^$port(/tcp)?\\s+ALLOW" ||',
    '      echo "Warning: the firewall blocks port $port, which Caddy needs. Run: sudo ufw allow $port/tcp"',
    "  done",
    "fi",
    'echo "Done."',
  ].join("\n")
}

/**
 * The public key to authorize for deploys: the one given, else the first key SSH would offer to
 * the server that has a `.pub` beside it, else the first key in the SSH agent.
 */
export async function pickPublicKey(input: {
  readonly key?: string
  readonly identityFiles: readonly string[]
}): Promise<{ readonly text: string; readonly source: string }> {
  if (input.key) {
    const path = input.key.endsWith(".pub") ? input.key : `${input.key}.pub`
    return { text: (await Bun.file(path).text()).trim(), source: path }
  }
  for (const identity of input.identityFiles) {
    const path = `${identity}.pub`
    if (
      await access(path).then(
        () => true,
        () => false
      )
    ) {
      return { text: (await Bun.file(path).text()).trim(), source: path }
    }
  }
  const agent = Bun.spawn(["ssh-add", "-L"], { stdout: "pipe", stderr: "ignore" })
  const first = (await new Response(agent.stdout).text()).split("\n").find((line) => line.trim())
  if ((await agent.exited) === 0 && first) return { text: first.trim(), source: "your SSH agent" }
  throw new Error(
    "[SshTarget] No public key to authorize. Pass one with `--key ~/.ssh/id_ed25519.pub`."
  )
}
