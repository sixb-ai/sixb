import { afterEach, describe, expect, jest, mock, spyOn, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { EnvSourceUnreachableError } from "@sixb/core/env"
import { azureKeyVault } from "../src"

/** Whether DNS answers for Entra ID's host, which tells a missing vault from DNS being down. */
let dnsWorks = true
mock.module("node:dns/promises", () => ({
  lookup: async (host: string) => {
    if (!dnsWorks)
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" })
    return { address: "20.190.0.1", family: 4 }
  },
}))

interface Sent {
  readonly url: URL
  readonly method: string
  readonly authorization: string | null
  readonly body: string | undefined
}

const { PATH } = process.env
const stdinIsTTY = process.stdin.isTTY
const directories: string[] = []

afterEach(async () => {
  jest.useRealTimers()
  mock.restore()
  dnsWorks = true
  process.stdin.isTTY = stdinIsTTY
  process.env.PATH = PATH
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** Answers each request from `respond` and records what was sent. */
function fakeAzure(respond: (request: Sent) => Response | Promise<Response>): Sent[] {
  const sent: Sent[] = []
  spyOn(globalThis, "fetch").mockImplementation((async (input: string, init?: RequestInit) => {
    const request: Sent = {
      url: new URL(input),
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization"),
      body: init?.body === undefined ? undefined : String(init.body),
    }
    sent.push(request)
    return respond(request)
  }) as unknown as typeof fetch)
  return sent
}

const json = (body: unknown, status = 200) => Response.json(body, { status })

const secretId = (vault: string, name: string) => `https://${vault}.vault.azure.net/secrets/${name}`

/** A vault holding these secrets, by their Key Vault names. */
function vault(name: string, secrets: Record<string, string>) {
  return (request: Sent): Response => {
    if (request.url.hostname === "login.microsoftonline.com") {
      return json({ access_token: "server-access-token", token_type: "Bearer" })
    }
    const path = request.url.pathname
    if (path === "/secrets") {
      return json({ value: Object.keys(secrets).map((id) => ({ id: secretId(name, id) })) })
    }
    const secret = decodeURIComponent(path.slice("/secrets/".length))
    if (request.method === "PUT") return json({ id: secretId(name, secret) })
    return secret in secrets
      ? json({ id: secretId(name, secret), value: secrets[secret] })
      : json({ error: { code: "SecretNotFound", message: "Not found" } }, 404)
  }
}

interface FakeCommand {
  readonly stdout?: string
  readonly stderr?: string
  readonly code?: number
}

/**
 * Puts a fake `az` first on the PATH. It answers by the first prefix its arguments start with, and
 * logs every call, one per line, to the file this returns.
 */
async function fakeAz(answers: Record<string, FakeCommand>): Promise<string> {
  const bin = await mkdtemp(join(tmpdir(), "sixb-az-bin-"))
  directories.push(bin)
  const log = join(bin, "calls.log")
  const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`
  const cases = Object.entries(answers).map(
    ([prefix, answer]) =>
      `  ${quote(prefix)}*) printf '%s' ${quote(answer.stdout ?? "")}; printf '%s' ${quote(answer.stderr ?? "")} >&2; exit ${answer.code ?? 0} ;;`
  )
  await writeFile(
    join(bin, "az"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${quote(log)}`,
      'case "$*" in',
      ...cases,
      '  *) echo "ERROR: unexpected az $*" >&2; exit 2 ;;',
      "esac",
      "",
    ].join("\n")
  )
  await chmod(join(bin, "az"), 0o755)
  process.env.PATH = `${bin}${delimiter}${PATH}`
  return log
}

const calls = async (log: string) =>
  (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean)

const signedIn = { "account get-access-token": { stdout: "person-token\n" } }

const serverToken = JSON.stringify({ tenant: "t-1", clientId: "app-1", clientSecret: "s3cret" })

const source = () => azureKeyVault({ vaults: { dev: "shop-dev", prod: "shop-prod" } })

describe("azureKeyVault", () => {
  test("needs both vaults, by name", () => {
    const expected = "Set `vaults`"
    expect(() => azureKeyVault({ vaults: { dev: "shop-dev" } } as never)).toThrow(expected)
    expect(() =>
      azureKeyVault({ vaults: { dev: "https://shop.vault.azure.net", prod: "shop-prod" } })
    ).toThrow(expected)
  })

  test("touches nothing until a command needs it", async () => {
    const log = await fakeAz(signedIn)
    const sent = fakeAzure(() => json({}))

    source()

    expect(sent).toEqual([])
    expect(await calls(log)).toEqual([])
  })

  describe("names", () => {
    test("lists every page, turning - into _ and skipping disabled and managed secrets", async () => {
      await fakeAz(signedIn)
      const sent = fakeAzure((request) =>
        request.url.searchParams.has("$skiptoken")
          ? json({ value: [{ id: secretId("shop-dev", "C") }] })
          : json({
              value: [
                { id: secretId("shop-dev", "DATABASE-URL") },
                { id: secretId("shop-dev", "OFF"), attributes: { enabled: false } },
                { id: secretId("shop-dev", "cert"), managed: true },
              ],
              nextLink: "https://shop-dev.vault.azure.net/secrets?api-version=7.5&$skiptoken=x",
            })
      )

      expect(await source().names("dev")).toEqual(["DATABASE_URL", "C"])

      expect(sent.map((request) => request.url.origin)).toEqual([
        "https://shop-dev.vault.azure.net",
        "https://shop-dev.vault.azure.net",
      ])
      expect(sent[0]?.url.pathname).toBe("/secrets")
      expect(sent[0]?.authorization).toBe("Bearer person-token")
    })

    // Reproduce: follow nextLink without comparing origins. The bearer token then leaves the vault.
    test("never follows a next page outside the vault", async () => {
      await fakeAz(signedIn)
      const sent = fakeAzure((request) =>
        request.url.hostname === "attacker.example"
          ? json({ value: [] })
          : json({ value: [], nextLink: "https://attacker.example/secrets?$skiptoken=x" })
      )

      const error = await source()
        .names("dev")
        .catch((e) => e)

      expect(String(error)).toContain("pointed outside itself")
      expect(sent).toHaveLength(1)
    })
  })

  describe("read", () => {
    test("reads each secret from the environment's vault", async () => {
      await fakeAz(signedIn)
      const sent = fakeAzure(vault("shop-prod", { "DATABASE-URL": "postgres://x", B: "two" }))

      expect(await source().read("prod")).toEqual({ DATABASE_URL: "postgres://x", B: "two" })

      expect(new Set(sent.map((request) => request.url.hostname))).toEqual(
        new Set(["shop-prod.vault.azure.net"])
      )
      expect(sent.map((request) => request.url.pathname).sort()).toEqual([
        "/secrets",
        "/secrets/B",
        "/secrets/DATABASE-URL",
      ])
    })

    test("signs in with a server's credential instead of az", async () => {
      const log = await fakeAz(signedIn)
      const sent = fakeAzure(vault("shop-prod", { A: "1" }))

      expect(await source().read("prod", { token: serverToken })).toEqual({ A: "1" })

      expect(await calls(log)).toEqual([])
      const login = sent[0]
      expect(login?.url.toString()).toBe("https://login.microsoftonline.com/t-1/oauth2/v2.0/token")
      expect(Object.fromEntries(new URLSearchParams(login?.body))).toEqual({
        grant_type: "client_credentials",
        client_id: "app-1",
        client_secret: "s3cret",
        scope: "https://vault.azure.net/.default",
      })
      expect(sent.slice(1).map((request) => request.authorization)).toEqual([
        "Bearer server-access-token",
        "Bearer server-access-token",
      ])
    })

    test("refuses a token that isn't a Key Vault credential, without repeating it", async () => {
      const sent = fakeAzure(() => json({}))

      const error = await source()
        .read("prod", { token: "dp.st.prd.doppler-token" })
        .catch((e) => e)

      expect(error).not.toBeInstanceOf(EnvSourceUnreachableError)
      expect(String(error)).toContain("isn't a Key Vault credential")
      expect(String(error)).not.toContain("doppler-token")
      expect(sent).toEqual([])
    })
  })

  describe("write", () => {
    test("sets each value under its Key Vault name", async () => {
      await fakeAz(signedIn)
      const sent = fakeAzure(vault("shop-dev", {}))

      await source().write("dev", { DATABASE_URL: "postgres://x", A: "1" })

      expect(
        sent.map((request) => [
          request.method,
          request.url.pathname,
          JSON.parse(request.body ?? ""),
        ])
      ).toEqual([
        ["PUT", "/secrets/DATABASE-URL", { value: "postgres://x" }],
        ["PUT", "/secrets/A", { value: "1" }],
      ])
    })

    // Reproduce: drop the recovery in setSecret. Setting a name deleted in the portal then fails
    // until the vault purges it, days later.
    test("writes over a deleted secret by recovering it first", async () => {
      await fakeAz(signedIn)
      let deleted = true
      const sent = fakeAzure((request) => {
        const path = request.url.pathname
        if (request.method === "PUT" && deleted) {
          return json(
            {
              error: {
                code: "Conflict",
                message: "Secret STRIPE-KEY is currently in a deleted but recoverable state.",
                innererror: { code: "ObjectIsDeletedButRecoverable" },
              },
            },
            409
          )
        }
        if (request.method === "POST" && path === "/deletedsecrets/STRIPE-KEY/recover") {
          deleted = false
        }
        return json({ id: secretId("shop-dev", "STRIPE-KEY"), value: "old" })
      })

      await source().write("dev", { STRIPE_KEY: "new" })

      expect(sent.map((request) => `${request.method} ${request.url.pathname}`)).toEqual([
        "PUT /secrets/STRIPE-KEY",
        "POST /deletedsecrets/STRIPE-KEY/recover",
        "GET /secrets/STRIPE-KEY",
        "PUT /secrets/STRIPE-KEY",
      ])
      expect(JSON.parse(sent[3]?.body ?? "")).toEqual({ value: "new" })
    })

    test("waits out the moment after a delete when the name can't be used at all", async () => {
      await fakeAz(signedIn)
      const states = ["ObjectIsBeingDeleted", "ObjectIsDeletedButRecoverable"]
      const sent = fakeAzure((request) => {
        if (request.url.pathname === "/secrets") return json({ value: [] })
        const state = request.method === "PUT" ? states.shift() : undefined
        return state
          ? json({ error: { code: "Conflict", message: state, innererror: { code: state } } }, 409)
          : json({ id: secretId("shop-dev", "A"), value: "old" })
      })
      // Signs in through the fake az while real time still runs.
      const client = source()
      await client.names("dev")
      sent.length = 0
      jest.useFakeTimers()

      let settled = false
      const written = client.write("dev", { A: "new" }).finally(() => {
        settled = true
      })
      for (let turn = 0; !settled && turn < 100; turn++) {
        await new Promise((resolve) => setImmediate(resolve))
        jest.advanceTimersByTime(2_000)
      }
      await written

      expect(sent.map((request) => `${request.method} ${request.url.pathname}`)).toEqual([
        "PUT /secrets/A",
        "PUT /secrets/A",
        "POST /deletedsecrets/A/recover",
        "GET /secrets/A",
        "PUT /secrets/A",
      ])
    })

    test("any other conflict is a refusal, with Key Vault's reason", async () => {
      await fakeAz(signedIn)
      fakeAzure(() => json({ error: { code: "Conflict", message: "Being purged." } }, 409))

      const error = await source()
        .write("dev", { A: "1" })
        .catch((e) => e)

      expect(error).not.toBeInstanceOf(EnvSourceUnreachableError)
      expect(String(error)).toContain("shop-dev: Being purged. (HTTP 409)")
    })

    test("sends nothing for no values", async () => {
      const sent = fakeAzure(() => json({}))

      await source().write("dev", {})

      expect(sent).toEqual([])
    })

    test("refuses names Key Vault would merge, before sending anything", async () => {
      await fakeAz(signedIn)
      const sent = fakeAzure(() => json({}))

      const error = await source()
        .write("dev", { api_key: "1", API_KEY: "2" })
        .catch((e) => e)

      expect(String(error)).toContain("api_key and API_KEY are one secret")
      expect(sent).toEqual([])
    })
  })

  describe("createServerToken", () => {
    const vaultId =
      "/subscriptions/s/resourceGroups/g/providers/Microsoft.KeyVault/vaults/shop-prod"
    const createdApp = { stdout: JSON.stringify({ appId: "app-1", password: "pw", tenant: "t-1" }) }

    test("on Azure RBAC, gives a new service principal the reader role on that vault alone", async () => {
      const log = await fakeAz({
        "keyvault show": { stdout: JSON.stringify({ id: vaultId, rbac: true }) },
        "ad sp create-for-rbac": createdApp,
      })

      const token = await source().createServerToken("prod", "sixb-shop")

      expect(JSON.parse(token)).toEqual({ tenant: "t-1", clientId: "app-1", clientSecret: "pw" })
      const made = await calls(log)
      expect(made[0]).toStartWith("keyvault show --name shop-prod ")
      expect(made[1]).toBe(
        `ad sp create-for-rbac --name sixb-shop --role Key Vault Secrets User --scopes ${vaultId} --output json`
      )
      expect(made).toHaveLength(2)
    })

    test("on access policies, lets the new service principal get and list secrets", async () => {
      const log = await fakeAz({
        "keyvault show": { stdout: JSON.stringify({ id: vaultId, rbac: false }) },
        "ad sp create-for-rbac": createdApp,
        "ad sp show": { stdout: "object-1\n" },
        "keyvault set-policy": { stdout: "{}" },
      })

      await source().createServerToken("prod", "sixb-shop")

      const made = await calls(log)
      expect(made[1]).toBe("ad sp create-for-rbac --name sixb-shop --output json")
      expect(made[3]).toBe(
        "keyvault set-policy --name shop-prod --object-id object-1 --secret-permissions get list"
      )
    })

    // Reproduce: drop the cleanup. A failed setup then leaves a live credential in the tenant.
    test("deletes the service principal when it can't be given access", async () => {
      const log = await fakeAz({
        "keyvault show": { stdout: JSON.stringify({ id: vaultId, rbac: true }) },
        "ad sp create-for-rbac": {
          stdout: createdApp.stdout,
          stderr: "ERROR: AuthorizationFailed: no permission to write role assignments\n",
          code: 1,
        },
        "ad app list": { stdout: "app-1\n" },
        "ad app delete": {},
      })

      const error = await source()
        .createServerToken("prod", "sixb-shop")
        .catch((e) => e)

      expect(String(error)).toContain(
        "AuthorizationFailed: no permission to write role assignments"
      )
      expect(String(error)).not.toContain("pw")
      expect((await calls(log)).slice(2)).toEqual([
        "ad app list --display-name sixb-shop --query [].appId --output tsv",
        "ad app delete --id app-1",
      ])
    })

    test("says where to look when az can't find the vault", async () => {
      await fakeAz({
        "keyvault show": {
          stderr: "ERROR: The Vault 'shop-prod' not found within subscription.\n",
          code: 3,
        },
      })

      const error = await source()
        .createServerToken("prod", "sixb-shop")
        .catch((e) => e)

      expect(String(error)).toContain("az account set --subscription")
      expect(String(error)).toContain("not found within subscription")
    })
  })

  describe("failures", () => {
    const read = () =>
      source()
        .read("prod", { token: serverToken })
        .catch((error) => error)

    const afterLogin = (respond: () => Response) => (request: Sent) =>
      request.url.hostname === "login.microsoftonline.com"
        ? json({ access_token: "server-access-token" })
        : respond()

    // Reproduce: throw a plain Error for these. A deploy then can't ride out an Azure outage.
    test.each([
      ["a 5xx", () => json({ error: { message: "Down" } }, 503)],
      ["a 429", () => json({ error: { message: "Throttled" } }, 429)],
      [
        "no connection",
        () => {
          throw new TypeError("connection refused")
        },
      ],
    ])("%s from the vault means it's unreachable", async (_case, respond) => {
      fakeAzure(afterLogin(respond))

      expect(await read()).toBeInstanceOf(EnvSourceUnreachableError)
    })

    const notFound = () => {
      throw Object.assign(new TypeError("getaddrinfo ENOTFOUND shop-prod.vault.azure.net"), {
        code: "ENOTFOUND",
      })
    }

    // Reproduce: drop isMissingVault. A misspelled vault then rides out every deploy as an outage.
    test("a vault name that doesn't resolve is a refusal: there's no such vault", async () => {
      fakeAzure(afterLogin(notFound))

      const error = await read()

      expect(error).not.toBeInstanceOf(EnvSourceUnreachableError)
      expect(String(error)).toContain("There is no vault named shop-prod")
    })

    test("when nothing resolves, DNS is down, which is an outage", async () => {
      fakeAzure(afterLogin(notFound))
      dnsWorks = false

      expect(await read()).toBeInstanceOf(EnvSourceUnreachableError)
    })

    test("Entra ID down means it's unreachable", async () => {
      fakeAzure(() => json({ error: "temporarily_unavailable" }, 503))

      expect(await read()).toBeInstanceOf(EnvSourceUnreachableError)
    })

    // Reproduce: treat 401 as unreachable. A revoked credential then deploys on stale values.
    test.each([
      401, 403, 404,
    ])("a %i from the vault is a refusal, with its reason", async (status) => {
      const message = "Denied.\nCaller: appid=app-1;oid=o-1\nAction: 'getSecret'"
      fakeAzure(afterLogin(() => json({ error: { code: "Forbidden", message } }, status)))

      const error = await read()

      expect(error).not.toBeInstanceOf(EnvSourceUnreachableError)
      expect(String(error)).toContain(`shop-prod: Denied. (HTTP ${status})`)
    })

    test("an expired secret is a refusal, naming Entra's error and not the secret", async () => {
      fakeAzure(() =>
        json(
          {
            error: "invalid_client",
            error_description:
              "AADSTS7000222: The provided client secret keys for app 'app-1' are expired.\r\nTrace ID: abc",
          },
          401
        )
      )

      const error = await read()

      expect(error).not.toBeInstanceOf(EnvSourceUnreachableError)
      expect(String(error)).toContain("AADSTS7000222")
      expect(String(error)).not.toContain("Trace ID")
      expect(String(error)).not.toContain("s3cret")
    })
  })

  describe("where the token comes from", () => {
    test("a person's token comes from az, asked once, for the given tenant", async () => {
      const log = await fakeAz(signedIn)
      const sent = fakeAzure(() => json({ value: [] }))
      const client = azureKeyVault({
        vaults: { dev: "shop-dev", prod: "shop-prod" },
        tenant: "contoso.onmicrosoft.com",
      })

      await client.names("dev")
      await client.names("prod")

      expect(sent.map((request) => request.authorization)).toEqual([
        "Bearer person-token",
        "Bearer person-token",
      ])
      expect(await calls(log)).toEqual([
        "account get-access-token --resource https://vault.azure.net --tenant contoso.onmicrosoft.com --query accessToken --output tsv",
      ])
    })

    test("without a terminal, someone signed out is told what to do", async () => {
      await fakeAz({
        "account get-access-token": { stderr: "ERROR: Please run 'az login'.\n", code: 1 },
      })
      fakeAzure(() => json({}))
      // Under `bun test` in a terminal, this would otherwise run the fake `az login`.
      process.stdin.isTTY = false

      expect(
        String(
          await source()
            .read("dev")
            .catch((e) => e)
        )
      ).toContain("Run `az login`")
    })

    test("without the CLI, it says where to get it", async () => {
      process.env.PATH = "/nonexistent"
      fakeAzure(() => json({}))

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
