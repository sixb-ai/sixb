import { type EnvName, type EnvSource, EnvSourceUnreachableError } from "@sixb/core/env"

const API_VERSION = "7.5"
const VAULT_RESOURCE = "https://vault.azure.net"
const LOGIN_ORIGIN = "https://login.microsoftonline.com"
const READER_ROLE = "Key Vault Secrets User"
const REQUEST_TIMEOUT_MS = 15_000
const CLI_TIMEOUT_MS = 60_000
/** `az ad sp create-for-rbac` retries its role assignment until the new principal replicates. */
const CREATE_TIMEOUT_MS = 300_000
const PARALLEL_REQUESTS = 8
const INSTALL_URL = "https://learn.microsoft.com/cli/azure/install-azure-cli"

const VAULT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]{1,22}[A-Za-z0-9]$/
const SECRET_NAME_PATTERN = /^[A-Za-z0-9_]{1,127}$/

export interface AzureKeyVaultOptions {
  /** Each environment's vault, by name: `{ dev: "shop-dev", prod: "shop-prod" }`. */
  readonly vaults: Readonly<Record<EnvName, string>>
  /** The Microsoft Entra tenant the vaults belong to, when it isn't `az`'s default. */
  readonly tenant?: string
}

/** What a server keeps to read its vault: a service principal that can read it and nothing else. */
interface ServerCredential {
  readonly tenant: string
  readonly clientId: string
  readonly clientSecret: string
}

/** Keeps a project's values in Azure Key Vault. Nothing reaches the network until a command needs it. */
export function azureKeyVault(options: AzureKeyVaultOptions): EnvSource {
  const { vaults, tenant } = options
  if (
    typeof vaults?.dev !== "string" ||
    typeof vaults.prod !== "string" ||
    !VAULT_NAME_PATTERN.test(vaults.dev) ||
    !VAULT_NAME_PATTERN.test(vaults.prod)
  ) {
    throw new Error(
      '[AzureKeyVault] Set `vaults` to each environment\'s vault name: azureKeyVault({ vaults: { dev: "shop-dev", prod: "shop-prod" } }).'
    )
  }
  if (tenant !== undefined && (typeof tenant !== "string" || tenant.trim() === "")) {
    throw new Error("[AzureKeyVault] Set `tenant` to a tenant ID or domain, or leave it out.")
  }
  const tenantArgs = tenant === undefined ? [] : ["--tenant", tenant]

  let signedIn: Promise<string> | undefined
  const signedInToken = () => {
    signedIn ??= signIn()
    return signedIn
  }

  /**
   * The token of whoever `az` is signed in as: a person after `az login`, or a CI job after
   * `azure/login`. Never `AZURE_CLIENT_ID` and the rest: a project's own `.env` often has those
   * for its app, and Bun loads that file into this process.
   */
  async function signIn(): Promise<string> {
    const getToken = [
      "account",
      "get-access-token",
      "--resource",
      VAULT_RESOURCE,
      ...tenantArgs,
      "--query",
      "accessToken",
      "--output",
      "tsv",
    ]
    const signedIn = await az(getToken)
    if (signedIn.code === 0 && signedIn.stdout.trim()) return signedIn.stdout.trim()

    const login = ["az", "login", ...tenantArgs].join(" ")
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(`[AzureKeyVault] Not signed in to Azure. Run \`${login}\`.`)
    }
    const child = Bun.spawn(["az", "login", ...tenantArgs], {
      stdio: ["inherit", "inherit", "inherit"],
      env: process.env,
    })
    if ((await child.exited) !== 0) throw new Error(`[AzureKeyVault] \`${login}\` did not finish.`)

    const afterLogin = await az(getToken)
    const token = afterLogin.code === 0 ? afterLogin.stdout.trim() : ""
    if (!token) throw new Error(`[AzureKeyVault] \`${login}\` did not leave a token.`)
    return token
  }

  async function accessToken(serverToken: string | undefined): Promise<string> {
    return serverToken === undefined
      ? signedInToken()
      : clientToken(parseServerCredential(serverToken))
  }

  async function call(
    env: EnvName,
    token: string,
    url: string,
    init: { readonly method?: "GET" | "PUT"; readonly body?: unknown } = {}
  ): Promise<unknown> {
    const vault = vaults[env]
    let response: Response
    try {
      response = await fetch(url, {
        method: init.method ?? "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      throw new EnvSourceUnreachableError(`[AzureKeyVault] Could not reach the vault ${vault}.`, {
        cause: error,
      })
    }

    if (response.ok) {
      try {
        return await response.json()
      } catch (error) {
        throw new EnvSourceUnreachableError(
          `[AzureKeyVault] Could not read the answer from the vault ${vault}.`,
          { cause: error }
        )
      }
    }

    const body = (await response.json().catch(() => null)) as {
      readonly error?: { readonly message?: unknown }
    } | null
    const message = typeof body?.error?.message === "string" ? body.error.message : ""
    const reason = `${message || response.statusText} (HTTP ${response.status})`
    if (response.status === 429 || response.status >= 500) {
      throw new EnvSourceUnreachableError(`[AzureKeyVault] ${vault}: ${reason}`)
    }
    throw new Error(`[AzureKeyVault] ${vault}: ${reason}`)
  }

  /**
   * The vault's enabled secrets, by their Key Vault names. A disabled secret can't be read, and
   * a managed one backs a certificate, so neither is a value of the project.
   */
  async function secretNames(env: EnvName, token: string): Promise<string[]> {
    const origin = vaultOrigin(vaults[env])
    const names: string[] = []
    let next: string | undefined = `${origin}/secrets?api-version=${API_VERSION}&maxresults=25`

    while (next) {
      const page = (await call(env, token, next)) as {
        readonly value?: unknown
        readonly nextLink?: unknown
      }
      if (!Array.isArray(page.value)) {
        throw new Error(`[AzureKeyVault] Unexpected secret list from the vault ${vaults[env]}.`)
      }
      for (const item of page.value as readonly SecretItem[]) {
        if (item.managed === true || item.attributes?.enabled === false) continue
        const name = typeof item.id === "string" ? secretNameOf(item.id) : undefined
        if (!name) {
          throw new Error(`[AzureKeyVault] Unexpected secret list from the vault ${vaults[env]}.`)
        }
        names.push(name)
      }

      next = typeof page.nextLink === "string" && page.nextLink ? page.nextLink : undefined
      // The next page gets the same bearer token, so it must come from the same vault.
      if (next && new URL(next).origin !== origin) {
        throw new Error(`[AzureKeyVault] The vault ${vaults[env]} pointed outside itself.`)
      }
    }
    return names
  }

  return {
    async names(env) {
      const names = await secretNames(env, await accessToken(undefined))
      return names.map(variableName)
    },

    async read(env, readOptions) {
      const token = await accessToken(readOptions?.token)
      const origin = vaultOrigin(vaults[env])
      const names = await secretNames(env, token)

      const values = await mapInParallel(names, async (name) => {
        const url = `${origin}/secrets/${encodeURIComponent(name)}?api-version=${API_VERSION}`
        const secret = (await call(env, token, url)) as { readonly value?: unknown }
        if (typeof secret.value !== "string") {
          throw new Error(
            `[AzureKeyVault] ${variableName(name)} in the vault ${vaults[env]} has no value.`
          )
        }
        return [variableName(name), secret.value] as const
      })
      return Object.fromEntries(values)
    },

    async write(env, values) {
      const names = Object.keys(values)
      if (names.length === 0) return

      const invalid = names.filter((name) => !SECRET_NAME_PATTERN.test(name))
      if (invalid.length > 0) {
        throw new Error(
          `[AzureKeyVault] Key Vault can't hold ${invalid.sort().join(", ")}: a name may have letters, digits and underscores, up to 127.`
        )
      }
      // Key Vault ignores case in names, so these would overwrite each other.
      const seen = new Map<string, string>()
      for (const name of names) {
        const other = seen.get(name.toLowerCase())
        if (other) {
          throw new Error(
            `[AzureKeyVault] ${other} and ${name} are one secret to Key Vault, which ignores case.`
          )
        }
        seen.set(name.toLowerCase(), name)
      }

      const token = await accessToken(undefined)
      const origin = vaultOrigin(vaults[env])
      // Key Vault sets one secret per request. A failure part way leaves the others written,
      // and writing them again is harmless.
      await mapInParallel(names, (name) =>
        call(
          env,
          token,
          `${origin}/secrets/${encodeURIComponent(secretName(name))}?api-version=${API_VERSION}`,
          { method: "PUT", body: { value: values[name] } }
        )
      )
    },

    async createServerToken(env, label) {
      const vault = vaults[env]
      const shown = await azJson<{ readonly id?: unknown; readonly rbac?: unknown }>(
        [
          "keyvault",
          "show",
          "--name",
          vault,
          "--query",
          "{id:id, rbac:properties.enableRbacAuthorization}",
          "--output",
          "json",
        ],
        `Could not find the vault ${vault} in az's current subscription (change it with \`az account set --subscription <id>\`)`
      )
      if (typeof shown.id !== "string" || shown.id === "") {
        throw new Error(`[AzureKeyVault] az did not return the vault ${vault}'s ID.`)
      }

      // A vault on Azure RBAC takes a role on the vault alone. One on access policies takes a
      // policy that can get and list secrets, which is what that role grants.
      const rbac = shown.rbac === true
      const created = await createServicePrincipal(
        label,
        rbac ? ["--role", READER_ROLE, "--scopes", shown.id] : []
      )
      if (!rbac) {
        try {
          const objectId = await servicePrincipalObjectId(created.clientId)
          await azText(
            [
              "keyvault",
              "set-policy",
              "--name",
              vault,
              "--object-id",
              objectId,
              "--secret-permissions",
              "get",
              "list",
            ],
            `Could not let ${label} read the vault ${vault}`
          )
        } catch (error) {
          await deleteApps(label)
          throw error
        }
      }

      return JSON.stringify({
        tenant: created.tenant,
        clientId: created.clientId,
        clientSecret: created.clientSecret,
      } satisfies ServerCredential)
    },
  }
}

interface SecretItem {
  readonly id?: unknown
  readonly managed?: unknown
  readonly attributes?: { readonly enabled?: unknown }
}

function vaultOrigin(vault: string): string {
  return `https://${vault.toLowerCase()}.vault.azure.net`
}

/** Key Vault names allow letters, digits and hyphens, so `_` in a variable's name becomes `-`. */
function secretName(variable: string): string {
  return variable.replaceAll("_", "-")
}

function variableName(secret: string): string {
  return secret.replaceAll("-", "_")
}

/** `https://<vault>.vault.azure.net/secrets/<name>` → `<name>`. */
function secretNameOf(id: string): string | undefined {
  let pathname: string
  try {
    pathname = new URL(id).pathname
  } catch {
    return undefined
  }
  return /^\/secrets\/([A-Za-z0-9-]+)\/?$/.exec(pathname)?.[1]
}

async function mapInParallel<T, R>(
  items: readonly T[],
  map: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await map(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL_REQUESTS, items.length) }, worker))
  return results
}

function parseServerCredential(token: string): ServerCredential {
  let parsed: Partial<Record<keyof ServerCredential, unknown>> | null = null
  try {
    parsed = JSON.parse(token)
  } catch {
    // Reported below, without the token.
  }
  const { tenant, clientId, clientSecret } = parsed ?? {}
  if (
    typeof tenant !== "string" ||
    typeof clientId !== "string" ||
    typeof clientSecret !== "string"
  ) {
    throw new Error(
      "[AzureKeyVault] This token isn't a Key Vault credential. Delete it and run `sixb deploy setup` again."
    )
  }
  return { tenant, clientId, clientSecret }
}

/** Trades a service principal's secret for a Key Vault access token. */
async function clientToken(credential: ServerCredential): Promise<string> {
  const where = `the service principal ${credential.clientId}`
  let response: Response
  try {
    response = await fetch(
      `${LOGIN_ORIGIN}/${encodeURIComponent(credential.tenant)}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: credential.clientId,
          client_secret: credential.clientSecret,
          scope: `${VAULT_RESOURCE}/.default`,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    )
  } catch (error) {
    throw new EnvSourceUnreachableError(
      `[AzureKeyVault] Could not reach Microsoft Entra ID for ${where}.`,
      { cause: error }
    )
  }

  const body = (await response.json().catch(() => null)) as {
    readonly access_token?: unknown
    readonly error_description?: unknown
  } | null
  if (response.ok && typeof body?.access_token === "string" && body.access_token) {
    return body.access_token
  }
  if (response.ok) {
    throw new EnvSourceUnreachableError(
      `[AzureKeyVault] Could not read Microsoft Entra ID's answer for ${where}.`
    )
  }

  // The first line names the error, such as AADSTS7000222 for an expired secret. The rest is
  // trace and correlation IDs.
  const description =
    typeof body?.error_description === "string" ? body.error_description.split(/\r?\n/)[0] : ""
  const reason = `${description || response.statusText} (HTTP ${response.status})`
  if (response.status === 429 || response.status >= 500) {
    throw new EnvSourceUnreachableError(`[AzureKeyVault] ${where}: ${reason}`)
  }
  throw new Error(`[AzureKeyVault] ${where}: ${reason}`)
}

/** Creates the service principal a server reads with, and its secret. */
async function createServicePrincipal(
  label: string,
  roleArgs: readonly string[]
): Promise<ServerCredential> {
  let created: { readonly appId?: unknown; readonly password?: unknown; readonly tenant?: unknown }
  try {
    created = await azJson(
      ["ad", "sp", "create-for-rbac", "--name", label, ...roleArgs, "--output", "json"],
      `Could not create the service principal ${label}`,
      CREATE_TIMEOUT_MS
    )
  } catch (error) {
    // It may have been created before its role assignment failed.
    await deleteApps(label)
    throw error
  }

  const { appId, password, tenant } = created
  if (typeof appId !== "string" || typeof password !== "string" || typeof tenant !== "string") {
    await deleteApps(label)
    throw new Error(`[AzureKeyVault] az did not return a credential for ${label}.`)
  }
  return { tenant, clientId: appId, clientSecret: password }
}

/** A new service principal can take a few seconds to appear, so this asks until it does. */
async function servicePrincipalObjectId(appId: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const shown = await az(["ad", "sp", "show", "--id", appId, "--query", "id", "--output", "tsv"])
    const objectId = shown.stdout.trim()
    if (shown.code === 0 && objectId) return objectId
    if (attempt === 12) {
      throw new Error(
        `[AzureKeyVault] Could not find the new service principal ${appId}: ${azReason(shown.stderr)}`
      )
    }
    await Bun.sleep(5_000)
  }
}

/** Removes the app registrations named `label`, so a failed setup leaves no credential behind. */
async function deleteApps(label: string): Promise<void> {
  const listed = await az([
    "ad",
    "app",
    "list",
    "--display-name",
    label,
    "--query",
    "[].appId",
    "--output",
    "tsv",
  ])
  const appIds = listed.code === 0 ? listed.stdout.split(/\s+/).filter(Boolean) : []
  for (const appId of appIds) {
    const deleted = await az(["ad", "app", "delete", "--id", appId])
    if (deleted.code !== 0) {
      console.warn(
        `[AzureKeyVault] Could not delete the app registration ${appId} (${label}). Delete it in the Azure portal.`
      )
    }
  }
}

interface AzResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

async function az(args: readonly string[], timeout = CLI_TIMEOUT_MS): Promise<AzResult> {
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">
  try {
    child = Bun.spawn(["az", ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
      timeout,
    })
  } catch (error) {
    throw new Error(`[AzureKeyVault] The Azure CLI isn't installed. Install it: ${INSTALL_URL}`, {
      cause: error,
    })
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout, stderr }
}

async function azText(args: readonly string[], failure: string, timeout?: number): Promise<string> {
  const result = await az(args, timeout)
  if (result.code !== 0) throw new Error(`[AzureKeyVault] ${failure}: ${azReason(result.stderr)}`)
  return result.stdout
}

async function azJson<T>(args: readonly string[], failure: string, timeout?: number): Promise<T> {
  const text = await azText(args, failure, timeout)
  try {
    return JSON.parse(text) as T
  } catch (error) {
    throw new Error(`[AzureKeyVault] ${failure}: az's answer wasn't JSON.`, { cause: error })
  }
}

/** The first line `az` printed as an error, which names the problem. */
function azReason(stderr: string): string {
  const line =
    stderr
      .split(/\r?\n/)
      .map((text) => text.trim())
      .find((text) => text.startsWith("ERROR:")) ??
    stderr.trim().split(/\r?\n/)[0] ??
    ""
  return line.replace(/^ERROR:\s*/, "") || "az failed without saying why."
}
