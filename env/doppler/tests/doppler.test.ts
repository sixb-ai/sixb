import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { EnvSourceUnreachableError } from "@sixb/core/env"
import { doppler } from "../src"

interface Sent {
  readonly url: URL
  readonly method: string
  readonly authorization: string | null
  readonly body: unknown
}

const { PATH, DOPPLER_TOKEN } = process.env
const stdinIsTTY = process.stdin.isTTY
const directories: string[] = []

afterEach(async () => {
  mock.restore()
  process.stdin.isTTY = stdinIsTTY
  process.env.PATH = PATH
  if (DOPPLER_TOKEN === undefined) delete process.env.DOPPLER_TOKEN
  else process.env.DOPPLER_TOKEN = DOPPLER_TOKEN
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** Answers every request with this response and records what was sent. */
function fakeDoppler(respond: () => Response | Promise<Response>): Sent[] {
  const sent: Sent[] = []
  spyOn(globalThis, "fetch").mockImplementation((async (input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    sent.push({
      url: new URL(input),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    return respond()
  }) as unknown as typeof fetch)
  return sent
}

const json = (body: unknown, status = 200) => Response.json(body, { status })

const source = () => doppler({ project: "client-a" })

describe("doppler", () => {
  test("needs a project", () => {
    expect(() => doppler({ project: " " })).toThrow("Set `project`")
  })

  test("touches nothing until a command needs it", () => {
    const sent = fakeDoppler(() => json({}))

    source()

    expect(sent).toEqual([])
  })

  describe("names", () => {
    test("asks for names only, without Doppler's own", async () => {
      process.env.DOPPLER_TOKEN = "ci-token"
      const sent = fakeDoppler(() => json({ names: ["A", "B"] }))

      expect(await source().names("dev")).toEqual(["A", "B"])

      expect(sent[0]?.url.pathname).toBe("/v3/configs/config/secrets/names")
      expect(sent[0]?.url.searchParams.get("project")).toBe("client-a")
      expect(sent[0]?.url.searchParams.get("config")).toBe("dev")
      expect(sent[0]?.url.searchParams.get("include_managed_secrets")).toBe("false")
    })

    test("rejects an answer it can't read", async () => {
      process.env.DOPPLER_TOKEN = "ci-token"
      fakeDoppler(() => json({ names: "A" }))

      expect(
        String(
          await source()
            .names("dev")
            .catch((e) => e)
        )
      ).toContain("Unexpected names")
    })
  })

  describe("read", () => {
    test("downloads values, mapping prod to prd and dropping DOPPLER_*", async () => {
      const sent = fakeDoppler(() =>
        json({ A: "1", DOPPLER_PROJECT: "client-a", DOPPLER_CONFIG: "prd", B: "two" })
      )

      const values = await source().read("prod", { token: "server-token" })

      expect(values).toEqual({ A: "1", B: "two" })
      expect(sent[0]?.url.pathname).toBe("/v3/configs/config/secrets/download")
      expect(sent[0]?.url.searchParams.get("config")).toBe("prd")
      expect(sent[0]?.url.searchParams.get("format")).toBe("json")
      expect(sent[0]?.authorization).toBe("Bearer server-token")
    })

    test("rejects a value that isn't a string, naming only the variable", async () => {
      fakeDoppler(() => json({ A: { computed: "secret-value" } }))

      const error = await source()
        .read("dev", { token: "t" })
        .catch((e) => e)

      expect(String(error)).toContain("A in client-a / dev is not a string")
      expect(String(error)).not.toContain("secret-value")
    })
  })

  describe("write", () => {
    test("sends only the given values", async () => {
      process.env.DOPPLER_TOKEN = "ci-token"
      const sent = fakeDoppler(() => json({ secrets: {} }))

      await source().write("prod", { A: "1" })

      expect(sent[0]?.method).toBe("POST")
      expect(sent[0]?.url.pathname).toBe("/v3/configs/config/secrets")
      expect(sent[0]?.body).toEqual({ project: "client-a", config: "prd", secrets: { A: "1" } })
    })

    test("sends nothing for no values", async () => {
      const sent = fakeDoppler(() => json({}))

      await source().write("dev", {})

      expect(sent).toEqual([])
    })
  })

  describe("failures", () => {
    const read = () =>
      source()
        .read("prod", { token: "secret-token" })
        .catch((error) => error)

    // Reproduce: throw a plain Error for these. A deploy then can't ride out a Doppler outage.
    test.each([
      ["a 5xx", () => json({ messages: ["Down"] }, 503)],
      ["a 429", () => json({ messages: ["Slow down"] }, 429)],
      [
        "no connection",
        () => {
          throw new TypeError("connection refused")
        },
      ],
    ])("%s means Doppler is unreachable", async (_case, respond) => {
      fakeDoppler(respond)

      expect(await read()).toBeInstanceOf(EnvSourceUnreachableError)
    })

    // Reproduce: treat 401 as unreachable. A revoked token then deploys on stale values.
    test.each([401, 403, 404])("a %i is a refusal, with Doppler's reason", async (status) => {
      fakeDoppler(() => json({ messages: ["Invalid Service token"], success: false }, status))

      const error = await read()

      expect(error).not.toBeInstanceOf(EnvSourceUnreachableError)
      expect(String(error)).toContain("client-a / prd: Invalid Service token")
      expect(String(error)).toContain(`HTTP ${status}`)
    })

    test("an answer that can't be read means Doppler is unreachable", async () => {
      fakeDoppler(() => new Response("<html>Bad gateway</html>", { status: 200 }))

      expect(await read()).toBeInstanceOf(EnvSourceUnreachableError)
    })

    test("a failure with no readable body still says what happened", async () => {
      fakeDoppler(() => new Response("<html>", { status: 400, statusText: "Bad Request" }))

      expect(String(await read())).toContain("Bad Request (HTTP 400)")
    })

    test("never includes the token", async () => {
      fakeDoppler(() => json({ messages: ["No"] }, 401))

      expect(String(await read())).not.toContain("secret-token")
    })
  })

  describe("where the token comes from", () => {
    /** Puts a fake `doppler` first on the PATH, printing this as the signed-in token. */
    async function signedInAs(token: string): Promise<void> {
      const bin = await mkdtemp(join(tmpdir(), "sixb-doppler-bin-"))
      directories.push(bin)
      const script = join(bin, "doppler")
      await writeFile(script, `#!/bin/sh\nprintf '%s\\n' '${token}'\n`)
      await chmod(script, 0o755)
      process.env.PATH = `${bin}${delimiter}${PATH}`
      delete process.env.DOPPLER_TOKEN
    }

    test("a caller's token beats DOPPLER_TOKEN", async () => {
      process.env.DOPPLER_TOKEN = "ci-token"
      const sent = fakeDoppler(() => json({}))

      await source().read("dev", { token: "server-token" })

      expect(sent[0]?.authorization).toBe("Bearer server-token")
    })

    test("DOPPLER_TOKEN beats the signed-in person", async () => {
      await signedInAs("person-token")
      process.env.DOPPLER_TOKEN = "ci-token"
      const sent = fakeDoppler(() => json({}))

      await source().read("dev")

      expect(sent[0]?.authorization).toBe("Bearer ci-token")
    })

    test("a person's token comes from the Doppler CLI, asked once", async () => {
      await signedInAs("person-token")
      const sent = fakeDoppler(() => json({ names: [] }))
      const client = source()

      await client.names("dev")
      await client.names("prod")

      expect(sent.map((request) => request.authorization)).toEqual([
        "Bearer person-token",
        "Bearer person-token",
      ])
    })

    test("without a terminal, someone signed out is told what to do", async () => {
      await signedInAs("")
      fakeDoppler(() => json({}))
      // Under `bun test` in a terminal, this would otherwise run the fake `doppler login`.
      process.stdin.isTTY = false

      expect(
        String(
          await source()
            .read("dev")
            .catch((e) => e)
        )
      ).toContain("Run `doppler login`")
    })

    test("without the CLI, it says where to get it", async () => {
      process.env.PATH = "/nonexistent"
      delete process.env.DOPPLER_TOKEN
      fakeDoppler(() => json({}))

      expect(
        String(
          await source()
            .read("dev")
            .catch((e) => e)
        )
      ).toContain("isn't installed")
    })
  })
})
