import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  spyOn,
  test,
} from "bun:test"
import { promises as dns, type LookupAddress } from "node:dns"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type GuardedFetchInput,
  type GuardedPage,
  guardedFetch,
  WebFetchError,
  type WebFetchNetwork,
} from "../src/tools/web-fetch/network"

/**
 * The test network: every address answers from this machine's 127.0.0.1, so a test decides what a
 * "public" host serves, and `fetches` keeps what `guardedFetch` asked to connect to. `REFUSING`
 * refuses the connection, as Bun reports it. Bun's own behaviour behind the pin (the URL's address
 * is where it connects, `Host` and `tls.serverName` are what it sends and checks) runs for real.
 */
const PUBLIC = "93.184.215.14"
const REFUSING = "93.184.215.15"

const realFetch = globalThis.fetch

let dir: string
let ca: string
let http: ReturnType<typeof Bun.serve>
let https: ReturnType<typeof Bun.serve>

let requests: { path: string; host: string | null; userAgent: string | null }[]
let fetches: { url: URL; host: string | null; serverName?: string; proxy: unknown }[]
let lookups: string[]
let hangs: ReturnType<typeof Promise.withResolvers<void>>
let releaseHangs: ReturnType<typeof Promise.withResolvers<Response>>

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sixb-web-fetch-"))
  ca = await issueCertificates(dir)

  http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: serve })
  https = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: Bun.file(join(dir, "leaf.pem")), key: Bun.file(join(dir, "leaf.key")) },
    fetch: serve,
  })
})

afterAll(async () => {
  await http?.stop(true)
  await https?.stop(true)
  await rm(dir, { recursive: true, force: true })
})

beforeEach(() => {
  requests = []
  fetches = []
  lookups = []
  hangs = Promise.withResolvers<void>()
  releaseHangs = Promise.withResolvers<Response>()

  spyOn(globalThis, "fetch").mockImplementation((async (
    input: string | URL | Request,
    init?: BunFetchRequestInit
  ) => {
    const url = new URL(input instanceof Request ? input.url : input)
    fetches.push({
      url,
      host: new Headers(init?.headers).get("host"),
      serverName: init?.tls?.serverName,
      proxy: init?.proxy,
    })

    if (url.hostname === REFUSING) {
      throw Object.assign(new TypeError("ECONNREFUSED: Unable to connect."), {
        code: "ECONNREFUSED",
      })
    }

    const local = new URL(url.href)
    local.hostname = "127.0.0.1"
    return realFetch(local, { ...init, tls: { ...init?.tls, ca }, proxy: false })
  }) as typeof fetch)
})

afterEach(() => {
  releaseHangs.resolve(new Response("released"))
  jest.useRealTimers()
  mock.restore()
})

describe("addresses", () => {
  // [address, server, computer]
  const table: [string, Verdict, Verdict][] = [
    ["0.0.0.0", "blocked", "blocked"],
    ["10.1.2.3", "blocked", "blocked"],
    ["100.64.0.1", "blocked", "blocked"],
    ["100.127.255.255", "blocked", "blocked"],
    ["127.0.0.1", "blocked", "allowed"],
    ["127.255.255.254", "blocked", "allowed"],
    ["169.254.169.254", "blocked", "blocked"],
    ["172.16.0.1", "blocked", "blocked"],
    ["172.31.255.255", "blocked", "blocked"],
    ["192.0.0.1", "blocked", "blocked"],
    ["192.0.2.1", "blocked", "blocked"],
    ["192.168.1.1", "blocked", "blocked"],
    ["198.18.0.1", "blocked", "blocked"],
    ["198.19.255.255", "blocked", "blocked"],
    ["198.51.100.1", "blocked", "blocked"],
    ["203.0.113.1", "blocked", "blocked"],
    ["224.0.0.1", "blocked", "blocked"],
    ["240.0.0.1", "blocked", "blocked"],
    ["255.255.255.255", "blocked", "blocked"],
    ["8.8.8.8", "allowed", "allowed"],
    ["100.128.0.1", "allowed", "allowed"],
    ["172.32.0.1", "allowed", "allowed"],
    ["198.20.0.1", "allowed", "allowed"],
    ["::", "blocked", "blocked"],
    ["::1", "blocked", "allowed"],
    ["::a00:1", "blocked", "blocked"],
    ["fc00::1", "blocked", "blocked"],
    ["fd00:ec2::254", "blocked", "blocked"],
    ["fe80::1", "blocked", "blocked"],
    ["fec0::1", "blocked", "blocked"],
    ["64:ff9b:1::a00:1", "blocked", "blocked"],
    ["64:ff9b:1::808:808", "blocked", "blocked"],
    ["ff02::1", "blocked", "blocked"],
    ["2001:db8::1", "blocked", "blocked"],
    ["100::1", "blocked", "blocked"],
    ["2606:4700::1111", "allowed", "allowed"],
    // IPv4 inside IPv6 is judged as IPv4: mapped, NAT64 and 6to4. Only a mapped address is the
    // computer's own loopback; a NAT64 or 6to4 one is a gateway's.
    ["::ffff:127.0.0.1", "blocked", "allowed"],
    ["::ffff:7f00:1", "blocked", "allowed"],
    ["::ffff:10.0.0.1", "blocked", "blocked"],
    ["::ffff:a9fe:a9fe", "blocked", "blocked"],
    ["::ffff:8.8.8.8", "allowed", "allowed"],
    ["64:ff9b::a9fe:a9fe", "blocked", "blocked"],
    ["64:ff9b::7f00:1", "blocked", "blocked"],
    ["64:ff9b::808:808", "allowed", "allowed"],
    ["2002:a00:1::", "blocked", "blocked"],
    ["2002:a9fe:a9fe::1", "blocked", "blocked"],
    ["2002:7f00:1::", "blocked", "blocked"],
    ["2002:808:808::", "allowed", "allowed"],
  ]

  // Each row fails when its range leaves `PRIVATE` or `LOOPBACK` in `network.ts`. The NAT64 and 6to4
  // rows fail when `embeddedIPv4` stops returning the address, and their loopback rows when
  // `isBlocked` judges them on the caller's network; `node:net`'s `BlockList` already judges a
  // mapped `::ffff:` address by the IPv4 ranges.
  test.each(table)("%s: %s on a server, %s on a computer", async (address, server, computer) => {
    const host = address.includes(":") ? `[${address}]` : address
    const url = new URL(`http://${host}:${http.port}/page`)

    expect(await verdict(url, "server")).toBe(server)
    expect(await verdict(url, "computer")).toBe(computer)
  })

  test("refuses a host when any of its addresses is private, before connecting", async () => {
    resolveWith([PUBLIC, "10.0.0.7"])

    // Fails when only the first address is checked.
    const error = await failure(get("http://mixed.test/page", "server"))

    expect(error).toMatchObject({ code: "blocked" })
    expect(error.message).toContain("'mixed.test' is a private address (10.0.0.7)")
    expect(fetches).toEqual([])
  })

  test("localhost is loopback: refused on a server, read on a computer", async () => {
    // The real resolver: `localhost` never leaves this machine.
    const url = `http://localhost:${http.port}/page`

    expect(await failure(get(url, "server"))).toMatchObject({ code: "blocked" })
    expect(await get(url, "computer")).toMatchObject({ status: 200 })
  })

  test.each([
    ["ftp://files.test/a", "unsupported-url"],
    ["file:///etc/passwd", "unsupported-url"],
    ["http://user:secret@site.test/", "unsupported-url"],
    ["http://metadata/computeMetadata/v1/", "blocked"],
    ["http://METADATA.google.internal./computeMetadata/v1/", "blocked"],
  ])("refuses %s", async (url, code) => {
    resolveWith([PUBLIC])

    expect(await failure(get(url, "computer"))).toMatchObject({ code })
    expect(lookups).toEqual([])
    expect(fetches).toEqual([])
  })
})

describe("pinning", () => {
  test("connects to the address it checked, without asking DNS again", async () => {
    // A rebinding resolver: public the first time, private ever after.
    resolveWith([PUBLIC], ["10.0.0.7"])

    const page = await get(`http://pinned.test:${http.port}/page`, "server")

    expect(page).toMatchObject({ status: 200, url: `http://pinned.test:${http.port}/page` })
    expect(lookups).toEqual(["pinned.test"])

    // Fails when `fetchPinned` fetches `url` instead of `pinnedUrl(url, address)`.
    expect(fetches.map((call) => call.url.host)).toEqual([`${PUBLIC}:${http.port}`])
    expect(fetches[0]).toMatchObject({ host: `pinned.test:${http.port}`, proxy: false })
    expect(requests).toEqual([
      {
        path: "/page",
        host: `pinned.test:${http.port}`,
        userAgent: "Sixb-Agent/1 (+https://sixb.ai)",
      },
    ])
  })

  test("checks the certificate against the host while connecting to its address", async () => {
    resolveWith(["127.0.0.1"])

    const page = await get(`https://pinned.test:${https.port}/page`, "computer")

    // The certificate names only `pinned.test`, not 127.0.0.1: this fails with
    // ERR_TLS_CERT_ALTNAME_INVALID when the `tls: { serverName }` option is removed.
    expect(page).toMatchObject({ status: 200, url: `https://pinned.test:${https.port}/page` })
    expect(fetches[0]?.url.hostname).toBe("127.0.0.1")
    expect(fetches[0]?.serverName).toBe("pinned.test")
    expect(requests[0]?.host).toBe(`pinned.test:${https.port}`)
  })

  test("refuses a certificate that does not name the host", async () => {
    resolveWith(["127.0.0.1"])

    const error = await failure(get(`https://impostor.test:${https.port}/page`, "computer"))

    expect(error).toMatchObject({ code: "unreachable" })
    expect(error.message).toContain("ERR_TLS_CERT_ALTNAME_INVALID")
  })

  test("tries the next checked address when one refuses the connection", async () => {
    resolveWith([REFUSING, PUBLIC])

    // Fails when only the first address is tried.
    expect(await get(`http://two.test:${http.port}/page`, "server")).toMatchObject({ status: 200 })
    expect(fetches.map((call) => call.url.hostname)).toEqual([REFUSING, PUBLIC])
  })
})

describe("redirects", () => {
  test("follows a same-host redirect, resolving and checking the host again", async () => {
    // Fails when `resolvePublic` reuses a host's first answer.
    resolveWith([PUBLIC], [PUBLIC])

    const page = await get(`http://site.test:${http.port}/same`, "server")

    expect(page).toMatchObject({ status: 200, url: `http://site.test:${http.port}/page` })
    expect(lookups).toEqual(["site.test", "site.test"])
    expect(requests.map((request) => request.path)).toEqual(["/same", "/page"])
  })

  test("a same-host hop to loopback is refused on a server and read on a computer", async () => {
    // Fails on the server when one resolution serves every hop, or when loopback is open there.
    resolveWith([PUBLIC], ["127.0.0.1"])
    const error = await failure(get(`http://site.test:${http.port}/same`, "server"))

    expect(error).toMatchObject({ code: "blocked" })
    expect(requests.map((request) => request.path)).toEqual(["/same"])

    resolveWith([PUBLIC], ["127.0.0.1"])
    const page = await get(`http://site.test:${http.port}/same`, "computer")

    expect(page).toMatchObject({ status: 200, url: `http://site.test:${http.port}/page` })
  })

  test("follows an upgrade from http to https on the same host", async () => {
    resolveWith(["127.0.0.1"], ["127.0.0.1"])

    const page = await get(`http://pinned.test:${http.port}/upgrade`, "computer")

    expect(page).toMatchObject({ status: 200, url: `https://pinned.test:${https.port}/page` })
    expect(new TextDecoder().decode((page as GuardedPage).body)).toBe("secure")
  })

  test.each([
    ["another host", "/cross", "http://other.test/page"],
    ["a downgrade to http", "/downgrade", "http://site.test/page"],
  ])("returns a redirect to %s without following it", async (_, path, target) => {
    for (const network of ["server", "computer"] as const) {
      fetches = []
      resolveWith([PUBLIC])

      const response = await get(`https://site.test:${https.port}${path}`, network)

      // Fails when `isSameHost` accepts every host.
      expect(response).toEqual({
        url: `https://site.test:${https.port}${path}`,
        redirect: { url: target, status: 302 },
      })
      expect(lookups).toEqual(["site.test"])
      expect(fetches).toHaveLength(1)
      lookups = []
    }
  })

  // Regression proof: drop the `refusalBeforeDns` check on a redirect in guardedFetch; each of
  // these is then returned for the agent to fetch, as if it could.
  test("refuses a redirect to an address the network does not reach, and says why", async () => {
    const refused = async (path: string, network: WebFetchNetwork) => {
      resolveWith([PUBLIC])
      const error = await failure(get(`http://site.test:${http.port}${path}`, network))
      expect(error.code).toBe("blocked")
      return error.message
    }
    const from = `http://site.test:${http.port}`

    expect(await refused("/to-metadata", "computer")).toBe(
      `[SixbAgent] Blocked: ${from}/to-metadata redirects to http://169.254.169.254/latest/meta-data, which cannot be read: '169.254.169.254' is a private address (169.254.169.254). Only public addresses and this computer's loopback can be fetched.`
    )
    expect(await refused("/to-metadata-name", "computer")).toBe(
      `[SixbAgent] Blocked: ${from}/to-metadata-name redirects to http://metadata.google.internal/computeMetadata/v1, which cannot be read: 'metadata.google.internal' is a cloud metadata service.`
    )
    expect(await refused("/to-loopback", "server")).toContain(
      "redirects to http://127.0.0.1/page, which cannot be read: '127.0.0.1' is a private address"
    )
    expect(await refused("/to-file", "computer")).toBe(
      `[SixbAgent] Blocked: ${from}/to-file redirects to file:///etc/passwd, which cannot be read: Only http and https URLs can be fetched, not file:.`
    )
    expect(fetches).toHaveLength(4)

    // A computer reads its own loopback: the agent may follow that one.
    resolveWith([PUBLIC])
    expect(await get(`${from}/to-loopback`, "computer")).toEqual({
      url: `${from}/to-loopback`,
      redirect: { url: "http://127.0.0.1/page", status: 302 },
    })
  })

  test("stops after five redirects", async () => {
    resolveWith(...Array.from({ length: 6 }, () => [PUBLIC]))

    const error = await failure(get(`http://site.test:${http.port}/loop`, "server"))

    expect(error).toMatchObject({ code: "too-many-redirects" })
    expect(fetches).toHaveLength(6)
  })
})

describe("body", () => {
  test("returns the media type, the charset and the whole body under the cap", async () => {
    const page = await get(`http://127.0.0.1:${http.port}/latin`, "computer", { maxBytes: 5 })

    expect(page).toMatchObject({
      contentType: "text/html",
      charset: "iso-8859-1",
      truncated: false,
    })
    expect((page as GuardedPage).body).toEqual(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x21]))
  })

  test("stops reading at the cap, even when the page never ends", async () => {
    // Fails (the test times out) when the body is read to its end before being cut.
    const page = await get(`http://127.0.0.1:${http.port}/endless`, "computer", { maxBytes: 4096 })

    expect(page).toMatchObject({ status: 200, truncated: true })
    expect((page as GuardedPage).body.byteLength).toBe(4096)
  })
})

describe("deadline", () => {
  test("times out after the deadline, wherever the fetch is", async () => {
    jest.useFakeTimers()
    const pending = failure(get(`http://127.0.0.1:${http.port}/hang`, "computer"))
    await hangs.promise

    // Fails (the test times out) without the timer in `guardedFetch`.
    jest.advanceTimersByTime(30_000)
    const error = await pending

    expect(error).toMatchObject({ code: "timeout" })
    expect(error.message).toBe(
      `[SixbAgent] Timed out after 30 s fetching http://127.0.0.1:${http.port}/hang.`
    )
  })

  test("a cancelled call rejects with the caller's reason", async () => {
    const controller = new AbortController()
    const pending = guardedFetch(new URL(`http://127.0.0.1:${http.port}/hang`), {
      ...limits("computer"),
      signal: controller.signal,
    }).catch((error: unknown) => error)
    await hangs.promise

    const reason = new Error("the turn was stopped")
    controller.abort(reason)

    expect(await pending).toBe(reason)
  })
})

type Verdict = "blocked" | "allowed"

async function serve(request: Request): Promise<Response> {
  const url = new URL(request.url)
  requests.push({
    path: url.pathname,
    host: request.headers.get("host"),
    userAgent: request.headers.get("user-agent"),
  })

  switch (url.pathname) {
    case "/page":
      return new Response(url.protocol === "https:" ? "secure" : "page", {
        headers: { "content-type": "text/plain" },
      })
    case "/same":
      return redirect("/page")
    case "/upgrade":
      return redirect(`https://pinned.test:${https.port}/page`, 301)
    case "/cross":
      return redirect("http://other.test/page")
    case "/to-loopback":
      return redirect("http://127.0.0.1/page")
    case "/to-metadata":
      return redirect("http://169.254.169.254/latest/meta-data")
    case "/to-metadata-name":
      return redirect("http://metadata.google.internal/computeMetadata/v1")
    case "/to-file":
      return redirect("file:///etc/passwd")
    case "/downgrade":
      return redirect("http://site.test/page")
    case "/loop":
      return redirect("/loop")
    case "/latin":
      return new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x21]), {
        headers: { "content-type": 'Text/HTML; Charset="ISO-8859-1"' },
      })
    case "/endless":
      return new Response(
        new ReadableStream({
          pull: (controller) => controller.enqueue(new Uint8Array(1024).fill(0x61)),
        })
      )
    case "/hang":
      hangs.resolve()
      return releaseHangs.promise
    default:
      return new Response("not found", { status: 404 })
  }
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } })
}

function limits(network: WebFetchNetwork): GuardedFetchInput {
  return { network, signal: new AbortController().signal, maxBytes: 1024 * 1024, timeoutMs: 30_000 }
}

function get(
  url: string,
  network: WebFetchNetwork,
  overrides: Partial<GuardedFetchInput> = {}
): ReturnType<typeof guardedFetch> {
  return guardedFetch(new URL(url), { ...limits(network), ...overrides })
}

async function failure(promise: Promise<unknown>): Promise<WebFetchError> {
  const error = await promise.then(
    () => undefined,
    (error: unknown) => error
  )
  if (!(error instanceof WebFetchError)) throw new Error(`Expected a WebFetchError, got ${error}`)
  return error
}

async function verdict(url: URL, network: WebFetchNetwork): Promise<Verdict> {
  const response = await guardedFetch(url, limits(network)).catch((error: unknown) => error)
  if (response instanceof WebFetchError && response.code === "blocked") return "blocked"
  if (response instanceof Error) throw response
  return "allowed"
}

/** Answer each lookup with the next list of addresses; the last list answers every later one. */
function resolveWith(...answers: string[][]): void {
  let call = 0
  const lookup = async (host: string): Promise<LookupAddress[]> => {
    lookups.push(host)
    const addresses = answers[Math.min(call++, answers.length - 1)] ?? []
    return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))
  }

  // `guardedFetch` always asks for `{ all: true }`, the overload that returns a list.
  spyOn(dns, "lookup").mockImplementation(lookup as unknown as typeof dns.lookup)
}

/** A throwaway CA and a certificate it signs for `pinned.test` and `site.test` only. */
async function issueCertificates(cwd: string): Promise<string> {
  const key =
    "-newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -pkeyopt ec_param_enc:named_curve -nodes"
  const ca = "-addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign"

  await openssl(
    cwd,
    `req -x509 ${key} -keyout ca.key -out ca.pem -days 2 -subj /CN=sixb-test-ca ${ca}`
  )
  await openssl(cwd, `req ${key} -keyout leaf.key -out leaf.csr -subj /CN=pinned.test`)

  await Bun.write(join(cwd, "leaf.ext"), "subjectAltName=DNS:pinned.test,DNS:site.test\n")
  await openssl(
    cwd,
    "x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key -set_serial 1 -days 2 -extfile leaf.ext -out leaf.pem"
  )

  return Bun.file(join(cwd, "ca.pem")).text()
}

async function openssl(cwd: string, command: string): Promise<void> {
  const args = command.split(" ")
  const child = Bun.spawn(["openssl", ...args], { cwd, stdout: "ignore", stderr: "pipe" })
  const timer = setTimeout(() => child.kill(), 10_000)
  const code = await child.exited
  clearTimeout(timer)

  if (code !== 0) {
    throw new Error(`openssl ${args[0]} failed: ${await new Response(child.stderr).text()}`)
  }
}
