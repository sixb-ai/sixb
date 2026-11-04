import { promises as dns } from "node:dns"
import { BlockList, isIP } from "node:net"
import { AgentToolPublicError } from "@sixb/core"
import { waitForAbort } from "../../abort"

/**
 * Where a fetch leaves from: Sixb's servers, or the user's computer through the `sixb` CLI. Both
 * reach only public addresses; a computer may also read its own loopback, so a developer can point
 * the agent at their dev server.
 */
export type WebFetchNetwork = "server" | "computer"

export interface GuardedFetchInput {
  readonly network: WebFetchNetwork
  readonly signal: AbortSignal
  /** The body is read up to this many bytes, then cut (`truncated`). */
  readonly maxBytes: number
  /** For the whole fetch: every redirect hop and the body. */
  readonly timeoutMs: number
  /** Throws to refuse a URL before it is requested: the first, and each redirect followed. */
  readonly admit?: (url: URL) => void
}

export interface GuardedPage {
  /** The final URL, after the same-host redirects that were followed. */
  readonly url: string
  readonly status: number
  /** The media type, lowercased and without parameters. */
  readonly contentType?: string
  readonly charset?: string
  readonly body: Uint8Array
  readonly truncated: boolean
}

/** A redirect to another host. It is not followed: the agent decides whether to fetch it. */
export interface GuardedRedirect {
  /** The URL that answered with the redirect. */
  readonly url: string
  readonly redirect: { readonly url: string; readonly status: number }
}

export type GuardedResponse = GuardedPage | GuardedRedirect

export type WebFetchErrorCode =
  | "unsupported-url"
  | "blocked"
  | "unresolved"
  | "unreachable"
  | "too-many-redirects"
  | "timeout"

/** Why a page could not be fetched, worded for the model. */
export class WebFetchError extends AgentToolPublicError {
  override readonly name = "WebFetchError"

  constructor(
    readonly code: WebFetchErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(`[SixbAgent] ${message}`, options)
  }
}

const MAX_REDIRECTS = 5

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

// A fetch-protocol version, not the package's: `tsconfig.build.json` keeps `package.json` outside
// the program, and nothing else in the framework reads its own version.
const USER_AGENT = "Sixb-Agent/1 (+https://sixb.ai)"

const ACCEPT = "text/markdown, text/html;q=0.9, */*;q=0.8"

// Cloud metadata services also answer on these names, wherever DNS sends them.
const METADATA_HOSTNAMES = new Set(["metadata", "metadata.google.internal"])

/**
 * Never reachable: "this network", private and shared networks, link-local (cloud metadata at
 * 169.254.169.254, and fd00:ec2::254 inside fc00::/7), documentation, benchmarking, multicast and
 * reserved ranges. `::/96` is `::` and the deprecated IPv4-compatible block; `::1` is loopback.
 * `64:ff9b:1::/48` is NAT64 for a local network, and `fec0::/10` the deprecated site-local block.
 */
const PRIVATE = blockList([
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::/96",
  "fc00::/7",
  "fe80::/10",
  "fec0::/10",
  "64:ff9b:1::/48",
  "ff00::/8",
  "2001:db8::/32",
  "100::/64",
])

/** Reachable from a computer only, written as such or mapped (`::ffff:127.0.0.1`). */
const LOOPBACK = blockList(["127.0.0.0/8", "::1/128"])

/**
 * Fetch a page for the agent without letting it reach anything but the public web.
 *
 * Every address DNS returns for the host must be public, and the connection goes to the one that
 * was checked: the URL carries the address, `Host` and the TLS server name carry the host, so DNS
 * is never asked again and cannot answer differently in between. Same-host redirects are followed,
 * each hop resolved and checked again; a redirect to another host is returned, unless its target
 * is refused before DNS is even asked.
 */
export async function guardedFetch(url: URL, input: GuardedFetchInput): Promise<GuardedResponse> {
  input.signal.throwIfAborted()

  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), input.timeoutMs)
  const signal = AbortSignal.any([input.signal, deadline.signal])

  try {
    let current = url

    for (let hop = 0; ; hop += 1) {
      input.admit?.(current)
      const response = await fetchPinned(current, input.network, signal)

      const location = redirectLocation(response, current)
      if (!location) return await readPage(current, response, input.maxBytes)

      await response.body?.cancel()

      if (!isSameHost(current, location)) {
        // The agent may fetch it next: a target refused before DNS is said now, with why.
        const refused = refusalBeforeDns(location, input.network)
        if (refused) {
          throw new WebFetchError(
            "blocked",
            `Blocked: ${current.href} redirects to ${location.href}, which cannot be read: ${refused.reason}`
          )
        }

        return { url: current.href, redirect: { url: location.href, status: response.status } }
      }

      if (hop === MAX_REDIRECTS) {
        throw new WebFetchError(
          "too-many-redirects",
          `Stopped after ${MAX_REDIRECTS} redirects at ${current.href}.`
        )
      }

      current = location
    }
  } catch (error) {
    if (input.signal.aborted) throw input.signal.reason

    if (deadline.signal.aborted) {
      throw new WebFetchError(
        "timeout",
        `Timed out after ${input.timeoutMs / 1000} s fetching ${url.href}.`
      )
    }

    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function fetchPinned(
  url: URL,
  network: WebFetchNetwork,
  signal: AbortSignal
): Promise<Response> {
  const host = checkUrl(url, network)
  const addresses = await resolvePublic(host, network, signal)

  // A name often has several addresses, and a server listens on only some of them: `localhost`
  // resolves to `::1` first, where a dev server bound to 127.0.0.1 refuses. All were checked.
  let refused: unknown
  for (const address of addresses) {
    try {
      return await fetch(pinnedUrl(url, address), {
        method: "GET",
        redirect: "manual",
        signal,
        headers: { host: url.host, "user-agent": USER_AGENT, accept: ACCEPT },
        ...(url.protocol === "https:" && !isIP(host) ? { tls: { serverName: host } } : {}),

        // A proxy from the environment is the computer's own way out; on a server it would be a
        // path the checks above do not see. Loopback is this machine, never the proxy's.
        ...(network === "server" || LOOPBACK.check(address, family(address))
          ? { proxy: false }
          : {}),
      })
    } catch (error) {
      if (signal.aborted || !isRefused(error)) throw unreachable(url, error)
      refused = error
    }
  }

  throw unreachable(url, refused)
}

/** Refuse what is not a plain web URL; return its host, without the brackets of an IPv6 literal. */
function checkUrl(url: URL, network: WebFetchNetwork): string {
  const refused = refusalBeforeDns(url, network)
  if (refused) {
    const blocked = refused.code === "blocked" ? "Blocked: " : ""
    throw new WebFetchError(refused.code, `${blocked}${refused.reason}`)
  }

  return hostOf(url)
}

/**
 * Why a URL is refused before DNS is asked, if it is: its scheme, its credentials, a cloud
 * metadata name, or an address written in it that the network does not reach.
 */
function refusalBeforeDns(
  url: URL,
  network: WebFetchNetwork
): { readonly code: WebFetchErrorCode; readonly reason: string } | undefined {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      code: "unsupported-url",
      reason: `Only http and https URLs can be fetched, not ${url.protocol}.`,
    }
  }

  if (url.username || url.password) {
    return {
      code: "unsupported-url",
      reason: "URLs with a username or password are not fetched; remove the credentials.",
    }
  }

  const host = hostOf(url)

  if (METADATA_HOSTNAMES.has(host.replace(/\.$/, ""))) {
    return { code: "blocked", reason: `'${host}' is a cloud metadata service.` }
  }

  if (isIP(host) && isBlocked(host, network)) {
    return { code: "blocked", reason: privateAddress(host, host, network) }
  }

  return undefined
}

function hostOf(url: URL): string {
  return url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname
}

function privateAddress(host: string, address: string, network: WebFetchNetwork): string {
  const reach =
    network === "computer" ? "public addresses and this computer's loopback" : "public addresses"
  return `'${host}' is a private address (${address}). Only ${reach} can be fetched.`
}

async function resolvePublic(
  host: string,
  network: WebFetchNetwork,
  signal: AbortSignal
): Promise<string[]> {
  const addresses = isIP(host) ? [host] : await lookup(host, signal)

  const blocked = addresses.find((address) => isBlocked(address, network))
  if (blocked !== undefined) {
    throw new WebFetchError("blocked", `Blocked: ${privateAddress(host, blocked, network)}`)
  }

  return addresses
}

async function lookup(host: string, signal: AbortSignal): Promise<string[]> {
  try {
    // `dns.lookup` cannot be cancelled; stop waiting for it instead.
    const answers = await waitForAbort(dns.lookup(host, { all: true, verbatim: true }), signal)
    if (answers.length > 0) return answers.map((answer) => answer.address)
  } catch (error) {
    if (signal.aborted) throw error
    throw new WebFetchError("unresolved", `Could not resolve '${host}' (${errorCode(error)}).`, {
      cause: error,
    })
  }

  throw new WebFetchError("unresolved", `Could not resolve '${host}': no address.`)
}

function isBlocked(address: string, network: WebFetchNetwork): boolean {
  // A NAT64 or 6to4 address goes through a gateway: its loopback is never the computer's own.
  const embedded = embeddedIPv4(address)
  if (embedded) return isBlocked(embedded.address, embedded.mapped ? network : "server")

  const type = family(address)
  if (LOOPBACK.check(address, type)) return network === "server"

  return PRIVATE.check(address, type)
}

/**
 * The IPv4 address an IPv6 one stands for: mapped (`::ffff:0:0/96`), NAT64 (`64:ff9b::/96`) or
 * 6to4 (`2002::/16`). Each reaches that IPv4 host, so it is judged as one.
 */
function embeddedIPv4(
  address: string
): { readonly address: string; readonly mapped: boolean } | undefined {
  if (isIP(address) !== 6) return undefined

  const words = ipv6Words(address)
  const zero = (from: number, to: number) => words.slice(from, to).every((word) => word === 0)

  if (zero(0, 5) && words[5] === 0xffff) {
    return { address: ipv4(words[6], words[7]), mapped: true }
  }
  if (words[0] === 0x64 && words[1] === 0xff9b && zero(2, 6)) {
    return { address: ipv4(words[6], words[7]), mapped: false }
  }
  if (words[0] === 0x2002) return { address: ipv4(words[1], words[2]), mapped: false }

  return undefined
}

/** The eight 16-bit words of a valid IPv6 address. */
function ipv6Words(address: string): number[] {
  let text = address.split("%")[0] ?? ""

  // A dotted IPv4 tail (`::ffff:10.0.0.1`) is the last two words.
  const tail = text.slice(text.lastIndexOf(":") + 1)
  if (tail.includes(".")) {
    const [a = 0, b = 0, c = 0, d = 0] = tail.split(".").map(Number)
    text = `${text.slice(0, -tail.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }

  const [head = "", rest] = text.split("::")
  const parse = (part: string) =>
    part ? part.split(":").map((word) => Number.parseInt(word, 16)) : []
  const left = parse(head)
  const right = parse(rest ?? "")

  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right]
}

function ipv4(high = 0, low = 0): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".")
}

function pinnedUrl(url: URL, address: string): URL {
  const pinned = new URL(url.href)
  pinned.hostname = family(address) === "ipv6" ? `[${address}]` : address
  return pinned
}

function redirectLocation(response: Response, base: URL): URL | undefined {
  const location = response.headers.get("location")
  if (!REDIRECT_STATUSES.has(response.status) || !location) return undefined

  return URL.canParse(location, base) ? new URL(location, base) : undefined
}

/** The same host name, on the same scheme or upgraded from http to https. */
function isSameHost(from: URL, to: URL): boolean {
  if (to.hostname !== from.hostname) return false
  return to.protocol === from.protocol || (from.protocol === "http:" && to.protocol === "https:")
}

async function readPage(url: URL, response: Response, maxBytes: number): Promise<GuardedPage> {
  const contentType = response.headers.get("content-type") ?? ""
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase()
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1]?.toLowerCase()

  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false

  // Read one chunk past the cap at most: a page exactly `maxBytes` long is not truncated.
  const reader = response.body?.getReader()
  while (reader && size <= maxBytes) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.byteLength
  }

  if (reader && size > maxBytes) {
    truncated = true
    await reader.cancel()
  }

  return {
    url: url.href,
    status: response.status,
    ...(mediaType ? { contentType: mediaType } : {}),
    ...(charset ? { charset } : {}),
    body: concat(chunks, Math.min(size, maxBytes)),
    truncated,
  }
}

function concat(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const body = new Uint8Array(length)
  let offset = 0

  for (const chunk of chunks) {
    if (offset >= length) break
    const part = chunk.subarray(0, length - offset)
    body.set(part, offset)
    offset += part.byteLength
  }

  return body
}

function unreachable(url: URL, error: unknown): WebFetchError {
  return new WebFetchError("unreachable", `Could not fetch ${url.href} (${errorCode(error)}).`, {
    cause: error,
  })
}

function isRefused(error: unknown): boolean {
  return ["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL"].includes(errorCode(error))
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    if (typeof error.code === "string") return error.code
  }
  return error instanceof Error ? error.message : String(error)
}

function family(address: string): "ipv4" | "ipv6" {
  return isIP(address) === 6 ? "ipv6" : "ipv4"
}

function blockList(ranges: readonly string[]): BlockList {
  const list = new BlockList()

  for (const range of ranges) {
    const [address = "", bits = ""] = range.split("/")
    list.addSubnet(address, Number(bits), family(address))
  }

  return list
}
