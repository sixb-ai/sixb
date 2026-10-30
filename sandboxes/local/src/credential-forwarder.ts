import { mkdtemp, realpath, rm } from "node:fs/promises"
import { join } from "node:path"
import type { SandboxRequestCredential, SandboxRequestMethod } from "@sixb/core"
import { SandboxError } from "@sixb/core"

/**
 * Adds a sandbox's request credentials outside its commands. Each target URL gets its own Unix
 * socket, in a directory only this user can open, served by this process: a command connects to
 * the socket, and the request goes on to that URL alone, with the credential that matches it. The
 * credentials live only in this process's memory, never in the commands' env or files.
 */
export class CredentialForwarder {
  private credentials: readonly SandboxRequestCredential[] = []
  /** By target URL: the socket that forwards to it, and its server. */
  private readonly targets = new Map<
    string,
    { readonly socket: string; readonly server: ReturnType<typeof Bun.serve> }
  >()

  private constructor(readonly directory: string) {}

  static async start(): Promise<CredentialForwarder> {
    // mkdtemp creates the directory with mode 0700. Under /tmp, not $TMPDIR: a Unix socket's path
    // must fit in about 100 bytes, and $TMPDIR can be long. Real, as an OS sandbox matches it.
    return new CredentialForwarder(await realpath(await mkdtemp("/tmp/sixb-credentials-")))
  }

  /** Replace every credential, as `Sandbox.setRequestCredentials` does. */
  setCredentials(credentials: readonly SandboxRequestCredential[]): void {
    for (const credential of credentials) validateCredential(credential)
    assertNoOverlap(credentials)
    this.credentials = credentials
  }

  /** The `unix:` address that forwards to `url`, created on first use. */
  urlFor(url: string): string {
    const target = new URL(url)
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new SandboxError("[Sandbox] local credentials forward only http:// and https:// URLs.")
    }
    const key = target.href.replace(/\/+$/, "")
    let forwarding = this.targets.get(key)
    if (!forwarding) {
      const socket = join(this.directory, `${this.targets.size}.sock`)
      const server = Bun.serve({ unix: socket, fetch: (request) => this.forward(request, key) })
      forwarding = { socket, server }
      this.targets.set(key, forwarding)
    }
    return `unix:${forwarding.socket}`
  }

  async stop(): Promise<void> {
    for (const { server } of this.targets.values()) server.stop(true)
    this.targets.clear()
    this.credentials = []
    await rm(this.directory, { recursive: true, force: true })
  }

  private async forward(request: Request, base: string): Promise<Response> {
    const incoming = new URL(request.url)
    const target = new URL(`${base}${incoming.pathname}${incoming.search}`)
    const headers = new Headers(request.headers)
    headers.delete("host")
    const credential = this.credentials.find((candidate) => matches(candidate, request, target))
    if (credential) headers.set("authorization", credential.headers.Authorization)

    return fetch(target, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
      // @ts-expect-error Bun streams a request body with duplex "half", as fetch requires.
      duplex: "half",
    })
  }
}

function matches(credential: SandboxRequestCredential, request: Request, target: URL): boolean {
  if (target.origin !== credential.origin) return false
  const methods = typeof credential.method === "string" ? [credential.method] : credential.method
  if (!methods.includes(request.method.toUpperCase() as SandboxRequestMethod)) return false
  return typeof credential.path === "string"
    ? target.pathname === credential.path
    : target.pathname.startsWith(credential.path.prefix)
}

function validateCredential(credential: SandboxRequestCredential): void {
  let origin: URL
  try {
    origin = new URL(credential.origin)
  } catch {
    throw invalid("its origin is not a URL")
  }
  if (
    (origin.protocol !== "http:" && origin.protocol !== "https:") ||
    origin.origin !== credential.origin
  ) {
    throw invalid("its origin must be exactly one http:// or https:// origin")
  }
  const path = typeof credential.path === "string" ? credential.path : credential.path.prefix
  if (!/^\/[\x21-\x7e]*$/.test(path) || /[?#%\\]/.test(path) || /\/\.\.?(\/|$)/.test(path)) {
    throw invalid("its path must be a plain absolute path")
  }
  if (typeof credential.path !== "string" && !path.endsWith("/")) {
    throw invalid("a path prefix must end with /")
  }
  if (
    typeof credential.headers?.Authorization !== "string" ||
    /[\r\n]/.test(credential.headers.Authorization)
  ) {
    throw invalid("it must set exactly one Authorization header")
  }
}

/** One credential per request: two that could match the same request are ambiguous. */
function assertNoOverlap(credentials: readonly SandboxRequestCredential[]): void {
  credentials.forEach((credential, index) => {
    for (const other of credentials.slice(index + 1)) {
      if (credential.origin !== other.origin) continue
      const methods = (value: SandboxRequestCredential) =>
        typeof value.method === "string" ? [value.method] : value.method
      if (!methods(credential).some((method) => methods(other).includes(method))) continue
      const a = typeof credential.path === "string" ? credential.path : credential.path.prefix
      const b = typeof other.path === "string" ? other.path : other.path.prefix
      const aPrefix = typeof credential.path !== "string"
      const bPrefix = typeof other.path !== "string"
      const overlap =
        (aPrefix && b.startsWith(a)) ||
        (bPrefix && a.startsWith(b)) ||
        (!aPrefix && !bPrefix && a === b)
      if (overlap) throw invalid(`it overlaps another credential on ${credential.origin}`)
    }
  })
}

function invalid(reason: string): SandboxError {
  return new SandboxError(`[Sandbox] local cannot add a request credential: ${reason}.`)
}
