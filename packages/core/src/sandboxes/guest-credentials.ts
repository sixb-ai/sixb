import { createHash } from "node:crypto"
import type { SandboxRequestCredential } from "./sandbox"

// A VM guest adds request credentials the way the host-side providers do, from inside the guest:
// its commands run as an unprivileged user, and a forwarder running as root holds the
// credentials. They reach the guest in the environment of a root process, which only root may
// read, never in arguments, which any process may. What the commands can read holds none of
// them: their own env and files, other processes' arguments, and the root-only state below.

/** The user a guest's commands run as: they cannot read what root holds. */
export const GUEST_COMMAND_UID = 65534

/** Where a guest's forwarder state lives. */
export interface GuestCredentialPaths {
  /** Root-only: the credentials, the forwarder program and its pid. */
  readonly state: string
  /** World-traversable: one socket per credential origin, which commands connect to. */
  readonly sockets: string
}

/** Under /var/lib: a guest may give each exec its own /run and /tmp. */
export const GUEST_CREDENTIAL_PATHS: GuestCredentialPaths = {
  state: "/var/lib/sixb-credentials",
  sockets: "/var/lib/sixb-forward",
}

/** The env entry that carries the credentials: pass it out of the provider's own arguments. */
export const GUEST_CREDENTIALS_ENV = "SIXB_GUEST_CREDENTIALS"

/** The install step's exit status when no forwarder runs yet: run the start step. */
export const GUEST_FORWARDER_NOT_RUNNING = 10

/** A command a provider runs in the guest as root. */
export interface GuestCommand {
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/**
 * How a provider installs credentials in a guest, all as root:
 * 1. `install` writes the credentials and the forwarder, and has a running forwarder reload. It
 *    exits {@link GUEST_FORWARDER_NOT_RUNNING} when none runs, 3 without Bun or Node.
 * 2. `start`, only then, runs the forwarder detached, so it outlives the exec that started it.
 * 3. `ready` waits until every credential origin's socket exists (exit 4 after five seconds).
 */
export interface GuestCredentialsCommands {
  readonly install: GuestCommand
  readonly start: GuestCommand
  readonly ready: GuestCommand
}

/**
 * Run a guest command as {@link GUEST_COMMAND_UID}, with no way back to root: no groups, no
 * capabilities, and no new privileges from a setuid program.
 */
export function unprivilegedGuestArgv(command: string, args: readonly string[]): string[] {
  return [
    "setpriv",
    `--reuid=${GUEST_COMMAND_UID}`,
    `--regid=${GUEST_COMMAND_UID}`,
    "--clear-groups",
    "--no-new-privs",
    "--bounding-set=-all",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    "--",
    command,
    ...args,
  ]
}

/** The guest socket that reaches `url`'s origin with the credential that matches a request. */
export function guestCredentialedUrl(
  url: string,
  paths: GuestCredentialPaths = GUEST_CREDENTIAL_PATHS
): string {
  return `unix:${guestSocketPath(new URL(url).origin, paths)}`
}

/** The commands that install `credentials` in a guest; see {@link GuestCredentialsCommands}. */
export function guestCredentialsCommands(
  credentials: readonly SandboxRequestCredential[],
  paths: GuestCredentialPaths = GUEST_CREDENTIAL_PATHS
): GuestCredentialsCommands {
  const program = `(${guestForwarder.toString()})(${JSON.stringify(paths)})\n`
  const sockets = [...new Set(credentials.map((credential) => credential.origin))].map((origin) =>
    guestSocketPath(origin, paths)
  )
  const where = { SIXB_GUEST_STATE: paths.state, SIXB_GUEST_SOCKETS: paths.sockets }
  return {
    install: {
      argv: ["sh", "-c", INSTALL_SCRIPT],
      env: {
        ...where,
        [GUEST_CREDENTIALS_ENV]: JSON.stringify(credentials),
        SIXB_GUEST_FORWARDER: Buffer.from(program).toString("base64"),
      },
    },
    start: {
      argv: [
        "sh",
        "-c",
        'exec "$(command -v bun || command -v node)" "$1"',
        "sh",
        `${paths.state}/forwarder.mjs`,
      ],
      env: {},
    },
    ready: {
      argv: ["sh", "-c", READY_SCRIPT],
      env: { SIXB_GUEST_EXPECTED_SOCKETS: sockets.join(" ") },
    },
  }
}

function guestSocketPath(origin: string, paths: GuestCredentialPaths): string {
  return `${paths.sockets}/${createHash("sha256").update(origin).digest("hex").slice(0, 16)}.sock`
}

const INSTALL_SCRIPT = `set -eu
umask 077
state="$SIXB_GUEST_STATE"
mkdir -p "$state" "$SIXB_GUEST_SOCKETS"
chmod 700 "$state"
chmod 755 "$SIXB_GUEST_SOCKETS"
printf '%s' "$${GUEST_CREDENTIALS_ENV}" > "$state/credentials.json.next"
mv "$state/credentials.json.next" "$state/credentials.json"
printf '%s' "$SIXB_GUEST_FORWARDER" | base64 -d > "$state/forwarder.mjs"
pid=$(cat "$state/forwarder.pid" 2>/dev/null || true)
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
  kill -HUP "$pid"
  exit 0
fi
command -v bun >/dev/null 2>&1 || command -v node >/dev/null 2>&1 || exit 3
exit ${GUEST_FORWARDER_NOT_RUNNING}`

const READY_SCRIPT = `set -eu
for socket in $SIXB_GUEST_EXPECTED_SOCKETS; do
  tries=0
  while [ ! -S "$socket" ]; do
    tries=$((tries + 1))
    [ "$tries" -le 100 ] || exit 4
    sleep 0.05
  done
done`

/**
 * The guest's forwarder, run as root by Bun or Node from its own source: everything it uses is
 * inside it. It opens a socket for each credential's origin, and forwards what a command sends
 * there to that origin alone, with the credential the request matches. It reads the credentials
 * on every request, so a new list applies at once; SIGHUP opens sockets for new origins.
 */
export async function guestForwarder(paths: GuestCredentialPaths): Promise<void> {
  const { createServer } = await import("node:http")
  const { chmodSync, readFileSync, rmSync, writeFileSync } = await import("node:fs")
  const { createHash } = await import("node:crypto")
  const { Readable } = await import("node:stream")

  type Credential = {
    readonly origin: string
    readonly path: string | { readonly prefix: string }
    readonly method: string | readonly string[]
    readonly headers: { readonly Authorization: string }
  }
  const load = (): readonly Credential[] =>
    JSON.parse(readFileSync(`${paths.state}/credentials.json`, "utf8"))
  const socketFor = (origin: string) =>
    `${paths.sockets}/${createHash("sha256").update(origin).digest("hex").slice(0, 16)}.sock`
  const matches = (credential: Credential, method: string, target: URL) => {
    const methods = typeof credential.method === "string" ? [credential.method] : credential.method
    if (target.origin !== credential.origin || !methods.includes(method)) return false
    return typeof credential.path === "string"
      ? target.pathname === credential.path
      : target.pathname.startsWith(credential.path.prefix)
  }
  // Not forwarded either way: the connection's own, and what fetch has already decoded.
  const skipped = new Set([
    "connection",
    "keep-alive",
    "transfer-encoding",
    "content-length",
    "content-encoding",
    "host",
  ])

  const servers = new Map<string, ReturnType<typeof createServer>>()
  const open = () => {
    for (const { origin } of load()) {
      if (servers.has(origin)) continue
      const socket = socketFor(origin)
      rmSync(socket, { force: true })
      const server = createServer(async (request, response) => {
        try {
          const target = new URL(request.url ?? "/", origin)
          const method = (request.method ?? "GET").toUpperCase()
          const headers = new Headers()
          for (const [name, value] of Object.entries(request.headers)) {
            if (value === undefined || skipped.has(name)) continue
            headers.set(name, Array.isArray(value) ? value.join(", ") : value)
          }
          const credential = load().find((candidate) => matches(candidate, method, target))
          if (credential) headers.set("authorization", credential.headers.Authorization)
          const upstream = await fetch(target, {
            method,
            headers,
            redirect: "manual",
            ...(method === "GET" || method === "HEAD"
              ? {}
              : { body: Readable.toWeb(request) as unknown as BodyInit, duplex: "half" }),
          } as RequestInit)
          const out: Record<string, string> = {}
          upstream.headers.forEach((value, name) => {
            if (!skipped.has(name)) out[name] = value
          })
          response.writeHead(upstream.status, out)
          if (upstream.body) for await (const chunk of upstream.body) response.write(chunk)
          response.end()
        } catch {
          if (!response.headersSent) response.writeHead(502)
          response.end()
        }
      })
      server.listen(socket, () => chmodSync(socket, 0o666))
      servers.set(origin, server)
    }
  }
  process.on("SIGHUP", open)
  open()
  // Root-only, like the rest of the state: the install step signals this process to reload.
  writeFileSync(`${paths.state}/forwarder.pid`, String(process.pid), { mode: 0o600 })
}
