import { type EnvName, type EnvSource, EnvSourceUnreachableError } from "@sixb/core/env"

const API_ORIGIN = "https://api.doppler.com"
const CONFIGS: Readonly<Record<EnvName, string>> = { dev: "dev", prod: "prd" }
const REQUEST_TIMEOUT_MS = 15_000
const CLI_TIMEOUT_MS = 10_000
const INSTALL_URL = "https://docs.doppler.com/docs/install-cli"

export interface DopplerOptions {
  /** The Doppler project's name, such as `client-a`. */
  readonly project: string
}

/** Keeps a project's values in Doppler. Nothing reaches the network until a command needs it. */
export function doppler(options: DopplerOptions): EnvSource {
  const { project } = options
  if (typeof project !== "string" || project.trim() === "") {
    throw new Error(
      '[Doppler] Set `project` to the Doppler project\'s name: doppler({ project: "shop" }).'
    )
  }

  let signedIn: Promise<string> | undefined
  const signedInToken = () => {
    signedIn ??= signIn()
    return signedIn
  }

  async function call(
    env: EnvName,
    path: string,
    request: { readonly token?: string; readonly query?: string; readonly body?: unknown } = {}
  ): Promise<unknown> {
    const token = request.token ?? process.env.DOPPLER_TOKEN ?? (await signedInToken())
    const config = CONFIGS[env]
    const query = new URLSearchParams({ project, config })
    const where = `${project} / ${config}`

    let response: Response
    try {
      response = await fetch(`${API_ORIGIN}${path}?${query}${request.query ?? ""}`, {
        method: request.body === undefined ? "GET" : "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(request.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      throw new EnvSourceUnreachableError(`[Doppler] Could not reach Doppler for ${where}.`, {
        cause: error,
      })
    }

    if (response.ok) {
      try {
        return await response.json()
      } catch (error) {
        throw new EnvSourceUnreachableError(
          `[Doppler] Could not read Doppler's answer for ${where}.`,
          {
            cause: error,
          }
        )
      }
    }

    const reason = `${await failureMessage(response)} (HTTP ${response.status})`
    if (response.status === 429 || response.status >= 500) {
      throw new EnvSourceUnreachableError(`[Doppler] ${where}: ${reason}`)
    }
    throw new Error(`[Doppler] ${where}: ${reason}`)
  }

  return {
    async names(env) {
      const body = (await call(env, "/v3/configs/config/secrets/names", {
        query: "&include_managed_secrets=false",
      })) as { readonly names?: unknown }

      if (!Array.isArray(body.names) || body.names.some((name) => typeof name !== "string")) {
        throw new Error(`[Doppler] Unexpected names for ${project} / ${CONFIGS[env]}.`)
      }
      return body.names
    },

    async read(env, options) {
      const body = await call(env, "/v3/configs/config/secrets/download", {
        ...(options?.token === undefined ? {} : { token: options.token }),
        query: "&format=json",
      })

      if (typeof body !== "object" || body === null) {
        throw new Error(`[Doppler] Unexpected values for ${project} / ${CONFIGS[env]}.`)
      }
      const values: Record<string, string> = {}
      for (const [name, value] of Object.entries(body)) {
        if (name.startsWith("DOPPLER_")) continue
        if (typeof value !== "string") {
          throw new Error(`[Doppler] ${name} in ${project} / ${CONFIGS[env]} is not a string.`)
        }
        values[name] = value
      }
      return values
    },

    async write(env, values) {
      if (Object.keys(values).length === 0) return
      await call(env, "/v3/configs/config/secrets", {
        body: { project, config: CONFIGS[env], secrets: values },
      })
    },
  }
}

async function failureMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { readonly messages?: unknown } | null
  return Array.isArray(body?.messages) && body.messages.length > 0
    ? body.messages.join(" ")
    : response.statusText
}

/** The token of a person signed in with Doppler's CLI, signing them in first when they can. */
async function signIn(): Promise<string> {
  const token = await configuredToken()
  if (token) return token

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("[Doppler] Not signed in. Run `doppler login`, or set DOPPLER_TOKEN.")
  }
  const login = Bun.spawn(["doppler", "login"], {
    stdio: ["inherit", "inherit", "inherit"],
    env: process.env,
  })
  if ((await login.exited) !== 0) throw new Error("[Doppler] `doppler login` did not finish.")

  const afterLogin = await configuredToken()
  if (!afterLogin) throw new Error("[Doppler] `doppler login` did not leave a token.")
  return afterLogin
}

async function configuredToken(): Promise<string> {
  let child: Bun.Subprocess<"ignore", "pipe", "ignore">
  try {
    child = Bun.spawn(["doppler", "configure", "get", "token", "--plain"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: process.env,
      timeout: CLI_TIMEOUT_MS,
    })
  } catch (error) {
    throw new Error(`[Doppler] The Doppler CLI isn't installed. Install it: ${INSTALL_URL}`, {
      cause: error,
    })
  }
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  return code === 0 ? output.trim() : ""
}
