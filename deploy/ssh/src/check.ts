import { resolve4, resolve6 } from "node:dns/promises"
import { isIP } from "node:net"
import { posix } from "node:path"
import type { DeployCheck, DeployRelease } from "@sixb/core/deploy"
import { shellQuote } from "./shell"
import type { RemoteShell } from "./transport"

export const CHECK_MARKER = "__SIXB_CHECK__"

/** The tools a deploy runs on the server. */
const TOOLS = ["git", "curl", "unzip", "tar", "flock", "sha256sum", "caddy"]

type Status = DeployCheck["status"]

/**
 * Checks the server as the deploy user, changing nothing. Each check prints one
 * `__SIXB_CHECK__ id status detail` line; labels and remedies are added on this side.
 */
export function renderCheckScript(input: {
  readonly name: string
  readonly projectPath: string
  readonly ports: readonly { readonly service: string; readonly port: number }[]
}): string {
  const project = posix.join(input.name, "code", input.projectPath)
  return [
    `emit() { printf '${CHECK_MARKER}\\t%s\\t%s\\t%s\\n' "$1" "$2" "$(printf '%s' "$3" | tr '\\t\\n' '  ')"; }`,
    `project="$HOME"/${shellQuote(project)}`,
    `manifest="$HOME"/${shellQuote(input.name)}/deploy/processes.json`,
    'routes_dir="/etc/caddy/sixb.d/$USER"',
    `snippet="$routes_dir"/${shellQuote(`${input.name}.caddy`)}`,
    "",
    "if command -v apt-get > /dev/null && command -v systemctl > /dev/null; then",
    '  emit server.os ok "$(. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME")"',
    "else",
    '  emit server.os manual "$(uname -s) without apt and systemd"',
    "fi",
    "",
    'missing=""',
    `for tool in ${TOOLS.join(" ")}; do command -v "$tool" > /dev/null || missing="$missing $tool"; done`,
    'if [ -n "$missing" ]; then emit server.tools fixable "missing:$missing"',
    'else emit server.tools ok "Caddy $(caddy version 2>/dev/null | cut -d" " -f1), git, curl, unzip"; fi',
    "",
    'if [ -e "/var/lib/systemd/linger/$USER" ]; then emit server.linger ok "on for $USER"',
    'else emit server.linger fixable "off for $USER: services would stop when you log out"; fi',
    "",
    "if sudo -n -l /usr/bin/systemctl reload caddy > /dev/null 2>&1; then",
    '  emit server.reload ok "$USER may reload Caddy"',
    "else",
    '  emit server.reload fixable "$USER may not run sudo systemctl reload caddy"',
    "fi",
    "",
    'problems=""',
    '[ -d "$routes_dir" ] && [ -w "$routes_dir" ] || problems="$problems; $routes_dir is missing or not writable"',
    'grep -qsF "import $routes_dir/*.caddy" "/etc/caddy/sixb.d/$USER.caddy" || problems="$problems; /etc/caddy/sixb.d/$USER.caddy does not import it"',
    "grep -qsF 'import /etc/caddy/sixb.d/*.caddy' /etc/caddy/Caddyfile || problems=\"$problems; /etc/caddy/Caddyfile does not import /etc/caddy/sixb.d/*.caddy\"",
    'if [ -z "$problems" ]; then emit server.routes ok "$routes_dir"',
    "else emit server.routes fixable \"$(printf '%s' \"$problems\" | sed 's/^; //')\"; fi",
    "",
    "if ss -ltnH 2> /dev/null | grep -qE '(127\\.0\\.0\\.1|\\[::1\\]):2019 '; then",
    '  emit server.admin-api warning "Caddy\'s admin API listens on localhost:2019, where any process on the server can change every route"',
    "else",
    '  emit server.admin-api ok "not on localhost:2019"',
    "fi",
    "",
    'if [ ! -f "$project/.env" ]; then emit project.env manual "$project/.env does not exist"',
    'elif [ "$(stat -c %a "$project/.env")" != 600 ]; then emit project.env fixable "$project/.env is readable by others (mode $(stat -c %a "$project/.env"))"',
    'else emit project.env ok "$project/.env"; fi',
    "",
    ...input.ports.flatMap(({ service, port }) => [
      `if ss -ltnH "sport = :${port}" 2> /dev/null | grep -q .; then`,
      `  if grep -qs '"--port",' "$manifest" && grep -A1 -s '"--port",' "$manifest" | grep -q '"${port}"'; then`,
      `    emit project.port.${service} ok "${port}, used by this deployment"`,
      "  else",
      `    emit project.port.${service} manual "${port} is in use by another program"`,
      "  fi",
      `elif grep -ls '127.0.0.1:${port}\\b' /etc/caddy/sixb.d/*/*.caddy 2> /dev/null | grep -qv "^$snippet$"; then`,
      `  emit project.port.${service} manual "${port} is routed to another deployment"`,
      "else",
      `  emit project.port.${service} ok "${port}"`,
      "fi",
    ]),
    "",
    'free_kb="$(df -Pk "$HOME" | awk \'NR == 2 { print $4 + 0 }\')"',
    'if [ "$free_kb" -lt 2097152 ]; then emit server.disk warning "$((free_kb / 1024)) MB free"',
    'else emit server.disk ok "$((free_kb / 1048576)) GB free"; fi',
  ].join("\n")
}

/** Reads the check script's output into checks, with labels and remedies. */
export function parseCheckOutput(
  lines: readonly string[],
  context: { readonly location: string; readonly name: string }
): DeployCheck[] {
  return lines.flatMap((line) => {
    const [marker, id, status, detail] = line.split("\t")
    if (marker !== CHECK_MARKER || !id || !isStatus(status)) return []
    return [describe(id, status, detail ?? "", context)]
  })
}

/** Where each HTTP domain resolves, against where the target is. */
export async function checkDns(release: DeployRelease, hostname: string): Promise<DeployCheck[]> {
  const expected = isIP(hostname) ? [hostname] : await lookup(hostname)
  return Promise.all(
    release.services.flatMap((service) => {
      const http = service.http
      if (!http) return []
      return [
        (async (): Promise<DeployCheck> => {
          const found = await lookup(http.domain)
          const id = `dns.${service.name}`
          const label = `${service.name} DNS`
          if (expected.length > 0 && found.some((address) => expected.includes(address))) {
            return { id, label, status: "ok", detail: `${http.domain} → ${found.join(", ")}` }
          }
          const target = expected[0] ?? hostname
          return {
            id,
            label,
            status: "warning",
            detail:
              found.length > 0
                ? `${http.domain} → ${found.join(", ")}`
                : `${http.domain} does not resolve`,
            remedy: `Point ${http.domain} at ${target} with an ${isIP(target) === 6 ? "AAAA" : "A"} record. Until then, Caddy cannot get it a certificate.`,
          }
        })(),
      ]
    })
  )
}

/** The checks that stop a deploy. */
export function blocksDeploy(check: DeployCheck): boolean {
  return check.status === "fixable" || check.status === "manual"
}

export async function runChecks(
  shell: RemoteShell,
  input: Parameters<typeof renderCheckScript>[0] & { readonly location: string }
): Promise<DeployCheck[]> {
  const lines: string[] = []
  await shell.run(renderCheckScript(input), {
    onLine: (line, stream) => {
      if (stream === "stdout") lines.push(line)
    },
  })
  return parseCheckOutput(lines, input)
}

const LABELS: Readonly<Record<string, string>> = {
  "server.os": "Server",
  "server.tools": "Server tools",
  "server.linger": "Services at boot",
  "server.reload": "Caddy reload",
  "server.routes": "Caddy routes",
  "server.admin-api": "Caddy admin API",
  "server.disk": "Disk space",
  "project.env": ".env",
}

function describe(
  id: string,
  status: Status,
  detail: string,
  context: { readonly location: string; readonly name: string }
): DeployCheck {
  const label = LABELS[id] ?? (id.startsWith("project.port.") ? `${id.slice(13)} port` : id)
  const check = { id, label, status, detail }
  if (status === "ok") return check
  if (status === "fixable") return { ...check, remedy: "Run `sixb deploy setup`." }
  if (id === "server.os") return { ...check, remedy: "Deploy to an Ubuntu or Debian server." }
  if (id === "project.env") {
    const path = detail.replace(/ does not exist$/, "")
    return {
      ...check,
      remedy: `Create it with the project's settings: \`ssh ${context.location} 'install -m 600 /dev/null ${path}'\`, then edit it.`,
    }
  }
  if (id.startsWith("project.port.")) {
    return { ...check, remedy: "Give this service another port in the target's `ports`." }
  }
  if (id === "server.admin-api") {
    return {
      ...check,
      remedy:
        "Set `admin unix//var/lib/caddy/admin.sock` in the global options of /etc/caddy/Caddyfile.",
    }
  }
  return check
}

function isStatus(value: string | undefined): value is Status {
  return value === "ok" || value === "fixable" || value === "manual" || value === "warning"
}

async function lookup(hostname: string): Promise<string[]> {
  const [v4, v6] = await Promise.all([settle(resolve4(hostname)), settle(resolve6(hostname))])
  return [...v4, ...v6]
}

/** A lookup's answers, or none once it fails or takes over four seconds. */
async function settle(query: Promise<string[]>): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      query.catch(() => []),
      new Promise<string[]>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout([]), 4_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
