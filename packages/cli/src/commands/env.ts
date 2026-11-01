import { readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import { pathToFileURL } from "node:url"
import {
  type EnvConfig,
  type EnvName,
  type EnvSource,
  EnvSourceUnreachableError,
  type EnvVarRule,
} from "@sixb/core/env"
import {
  ENV_CONFIG_FILE,
  envVarNeeded,
  loadEnvConfig,
  missingEnvError,
  missingEnvSentence,
  missingEnvVars,
  VAR_NAME_PATTERN,
} from "../lib/env-config"
import { isGeneratedEnvFile, readEnvFile, writeEnvFile } from "../lib/env-file"
import { errorMessage, SixbCliError } from "../lib/errors"
import { promptHidden } from "../lib/hidden-prompt"
import { renderStatic } from "../ui"
import {
  type EnvStatusCell,
  envInitView,
  envKeptView,
  envPulledView,
  envSetView,
  envStatusView,
} from "../ui/env-screens"
import { canRunLive } from "../ui/live/can-run-live"

const ENV_NAMES: readonly EnvName[] = ["dev", "prod"]
const DOPPLER_PACKAGE = "@sixb/env-doppler"

// ─── pull ────────────────────────────────────────────────────────────────────

export async function runEnvPull(options: {
  readonly env?: string
  readonly tokenFile?: string
  readonly force?: boolean
  readonly cwd?: string
}): Promise<void> {
  const cwd = options.cwd ?? process.cwd()
  const env = parseEnvName(options.env ?? "dev")

  // A server has a token file. Refusing everyone else keeps prod values off laptops by default.
  if (env === "prod" && options.tokenFile === undefined) {
    throw new SixbCliError("[SixbEnv] Prod values stay on servers, so they can't be pulled here.", {
      remediation: "Read a value in your source's dashboard, or change one with `sixb env set`.",
    })
  }

  // A server deploying a commit whose `sixb.env.ts` has no source, such as a rollback.
  if (options.tokenFile !== undefined) {
    const deployed = await loadEnvConfig(cwd)
    if (deployed && !deployed.source) {
      await renderStatic(envKeptView({ env, reason: "This commit's sixb.env.ts has no source." }))
      return
    }
  }

  const { config, source } = await requireSource(cwd)
  const token = options.tokenFile === undefined ? undefined : await readToken(options.tokenFile)
  const pulled = await pullEnv({
    cwd,
    config,
    source,
    env,
    ...(token === undefined ? {} : { token }),
    force: options.force === true,
  })

  await renderStatic(
    pulled.kept
      ? envKeptView({ env, reason: pulled.reason })
      : envPulledView({ env, count: Object.keys(pulled.values).length })
  )
}

type PullResult =
  | { readonly kept: false; readonly values: Readonly<Record<string, string>> }
  | { readonly kept: true; readonly reason: string }

async function pullEnv(input: {
  readonly cwd: string
  readonly config: EnvConfig
  readonly source: EnvSource
  readonly env: EnvName
  readonly token?: string
  readonly force?: boolean
}): Promise<PullResult> {
  const { config, source, env, token } = input
  const path = join(input.cwd, ".env")

  let values: Readonly<Record<string, string>>
  try {
    values = await source.read(env, token === undefined ? {} : { token })
  } catch (error) {
    // A server riding out an outage, so it can still take a hotfix. A refusal never reaches this:
    // a revoked token must stop the deploy.
    const riding = token !== undefined && error instanceof EnvSourceUnreachableError
    if (riding && (await isCompleteGeneratedEnv(path, config, env))) {
      return { kept: true, reason: errorMessage(error) }
    }
    throw error
  }

  const missing = missingEnvVars(config, values, env)
  if (missing.length > 0) {
    throw new SixbCliError(`[SixbEnv] ${env} is missing ${missing.join(", ")}.`, {
      remediation: missing.map((name) => `sixb env set ${name} --env ${env}`).join("\n"),
    })
  }

  if (!input.force) await refuseToLoseValues(path, values)
  await writeEnvFile(path, values, env)
  return { kept: false, values }
}

async function isCompleteGeneratedEnv(
  path: string,
  config: EnvConfig,
  env: EnvName
): Promise<boolean> {
  if (!(await isGeneratedEnvFile(path))) return false
  return missingEnvVars(config, await readEnvFile(path), env).length === 0
}

/** A hand-written `.env` may hold the only copy of a value, so it's replaced only on request. */
async function refuseToLoseValues(
  path: string,
  values: Readonly<Record<string, string>>
): Promise<void> {
  if (!(await Bun.file(path).exists()) || (await isGeneratedEnvFile(path))) return

  const current = await readEnvFile(path)
  const different = Object.keys(current)
    .filter((name) => current[name] !== values[name])
    .sort()
  if (different.length > 0) {
    throw new SixbCliError(
      `[SixbEnv] This .env was written by hand, and the source has something else for ${different.join(", ")}.`,
      {
        remediation:
          "Move what you want to keep to the source or .env.local, then delete the file or pass --force.",
      }
    )
  }
}

async function readToken(path: string): Promise<string> {
  const text = await readFile(path, "utf8").catch(() => {
    throw new SixbCliError(`[SixbEnv] Could not read the token file ${path}.`)
  })
  const token = text.trim()
  if (!token) throw new SixbCliError(`[SixbEnv] The token file ${path} is empty.`)
  return token
}

// ─── dev ─────────────────────────────────────────────────────────────────────

/** Before `sixb dev`: stops on a missing variable, offering to pull when there's a source. */
export async function assertDevEnv(cwd: string): Promise<void> {
  const config = await loadEnvConfig(cwd)
  if (!config) return

  const missing = missingEnvVars(config, process.env, "dev")
  if (missing.length === 0) return
  if (!config.source || !canRunLive()) throw missingEnvError(config, missing)

  process.stderr.write(`\n${missingEnvSentence(missing)}\n`)
  const prompt = createInterface({ input: process.stdin, output: process.stderr })
  const answer = await prompt.question("Pull from dev now? (Y/n) ").finally(() => prompt.close())
  if (/^n/i.test(answer.trim())) throw missingEnvError(config, missing)

  await pullIntoThisProcess(cwd, config, config.source)
}

/**
 * Bun read `.env` when this process started, and the processes `sixb dev` starts inherit what it
 * read. So a pull also has to update this process, or they run on the old values. `.env.local`
 * still wins, as it does when Bun loads the files itself. A variable exported in the shell loses
 * here, which only happens on the rare start that pulls.
 */
export async function pullIntoThisProcess(
  cwd: string,
  config: EnvConfig,
  source: EnvSource
): Promise<void> {
  const pulled = await pullEnv({ cwd, config, source, env: "dev" })
  if (pulled.kept) return

  const localPath = join(cwd, ".env.local")
  const local = (await Bun.file(localPath).exists()) ? await readEnvFile(localPath) : {}
  Object.assign(process.env, pulled.values, local)

  await renderStatic(envPulledView({ env: "dev", count: Object.keys(pulled.values).length }))

  const stillMissing = missingEnvVars(config, process.env, "dev")
  if (stillMissing.length > 0) throw missingEnvError(config, stillMissing)
}

// ─── set ─────────────────────────────────────────────────────────────────────

export async function runEnvSet(options: {
  readonly name: string
  readonly env: string | undefined
  readonly cwd?: string
}): Promise<void> {
  const cwd = options.cwd ?? process.cwd()
  const { name } = options
  // Never quoted: `sixb env set KEY=value` is an easy slip, and this may be a CI log.
  if (!VAR_NAME_PATTERN.test(name)) {
    throw new SixbCliError("[SixbEnv] That is not a variable name.", {
      remediation:
        "Name the variable alone, then give the value at the prompt or on standard input.",
    })
  }
  const env = parseEnvName(options.env)
  const { config, source } = await requireSource(cwd)

  // Never an argument: arguments land in shell history and in the process list.
  const value = process.stdin.isTTY
    ? await promptHidden("Value:")
    : (await Bun.stdin.text()).replace(/\r?\n$/, "")
  if (value === "") throw new SixbCliError(`[SixbEnv] ${name} needs a value.`)

  await source.write(env, { [name]: value })
  await renderStatic(envSetView({ name, env, declared: name in config.vars }))
}

// ─── status ──────────────────────────────────────────────────────────────────

export async function runEnvStatus(options: { readonly cwd?: string } = {}): Promise<void> {
  const { config, source } = await requireSource(options.cwd ?? process.cwd())

  const [dev, prod] = await Promise.allSettled(ENV_NAMES.map((env) => source.names(env)))
  // Someone may only have access to dev. With neither, the failure is what to show.
  if (dev?.status === "rejected" && prod?.status === "rejected") throw dev.reason

  const devNames = dev?.status === "fulfilled" ? new Set(dev.value) : null
  const prodNames = prod?.status === "fulfilled" ? new Set(prod.value) : null
  const names = new Set([...Object.keys(config.vars), ...(devNames ?? []), ...(prodNames ?? [])])

  const cell = (env: EnvName, found: ReadonlySet<string> | null, name: string): EnvStatusCell => {
    if (!found) return "unknown"
    if (found.has(name)) return "set"
    return envVarNeeded(config.vars[name] ?? "optional", env) ? "missing" : "unneeded"
  }
  const rows = [...names].sort().map((name) => ({
    name,
    dev: cell("dev", devNames, name),
    prod: cell("prod", prodNames, name),
    declared: name in config.vars,
  }))
  const missing = rows.flatMap((row) => [row.dev, row.prod]).filter((c) => c === "missing").length

  await renderStatic(envStatusView({ rows, missing }))
  if (missing > 0) process.exitCode = 1
}

// ─── init ────────────────────────────────────────────────────────────────────

export async function runEnvInit(options: {
  readonly project: string
  readonly dev?: string
  readonly prod?: string
  readonly cwd?: string
}): Promise<void> {
  const cwd = options.cwd ?? process.cwd()
  const configPath = join(cwd, ENV_CONFIG_FILE)
  if (await Bun.file(configPath).exists()) {
    throw new SixbCliError(`[SixbEnv] ${ENV_CONFIG_FILE} already exists.`)
  }

  const files = [
    ["dev", options.dev],
    ["prod", options.prod],
  ] as const
  const given = files.flatMap(([env, file]) => (file === undefined ? [] : [{ env, file }]))
  if (given.length === 0) {
    throw new SixbCliError("[SixbEnv] Say where the current values are.", {
      remediation: "sixb env init <project> --dev .env --prod .env.prod",
    })
  }

  const source = await loadDopplerSource(cwd, options.project)
  const uploads = await Promise.all(
    given.map(async ({ env, file }) => {
      const path = resolve(cwd, file)
      if (!(await Bun.file(path).exists())) {
        throw new SixbCliError(`[SixbEnv] ${file} does not exist.`)
      }
      return { env, values: uploadableValues(await readEnvFile(path), file) }
    })
  )

  // Check every environment before writing to any, so a conflict changes nothing. Running this
  // again after a failed upload finds the same values, which aren't a conflict.
  for (const { env, values } of uploads) {
    const existing = await source.read(env)
    const conflicts = Object.keys(values).filter(
      (name) => name in existing && existing[name] !== values[name]
    )
    if (conflicts.length > 0) {
      throw new SixbCliError(
        `[SixbEnv] ${options.project} already has other values in ${env} for ${conflicts.sort().join(", ")}.`,
        {
          remediation:
            "Change them in your source's dashboard, or edit the file, and run this again.",
        }
      )
    }
  }
  for (const { env, values } of uploads) await source.write(env, values)

  const vars = declaredVars(uploads)
  await writeFile(configPath, renderEnvConfig(options.project, vars))
  await renderStatic(
    envInitView({
      uploaded: uploads.map(({ env, values }) => ({ env, count: Object.keys(values).length })),
      names: Object.keys(vars).length,
    })
  )
}

/**
 * The first guess at each rule. A name with a value in dev and in prod, when each was given, is
 * `required`; one with a value in prod alone is `prod`. Anything else, such as a name only dev has,
 * would fail a deploy if it were required, so it starts `optional`.
 */
function declaredVars(
  uploads: readonly { readonly env: EnvName; readonly values: Record<string, string> }[]
): Record<string, EnvVarRule> {
  const names = uploads.flatMap(({ values }) => Object.keys(values))
  const dev = uploads.find(({ env }) => env === "dev")?.values
  const prod = uploads.find(({ env }) => env === "prod")?.values

  return Object.fromEntries(
    [...new Set(names)].sort().map((name): [string, EnvVarRule] => {
      if (dev?.[name] && (!prod || prod[name])) return [name, "required"]
      return [name, prod?.[name] ? "prod" : "optional"]
    })
  )
}

/**
 * What a file can upload. A name `sixb.env.ts` couldn't declare stops this before anything is sent.
 * `DOPPLER_*` is how this machine reaches Doppler, not a value of the project.
 */
function uploadableValues(
  values: Readonly<Record<string, string>>,
  file: string
): Record<string, string> {
  const invalid = Object.keys(values).filter((name) => !VAR_NAME_PATTERN.test(name))
  if (invalid.length > 0) {
    throw new SixbCliError(
      `[SixbEnv] ${file} has names that aren't variable names: ${invalid.sort().join(", ")}.`,
      { remediation: "Rename them or remove them, and run this again." }
    )
  }
  return Object.fromEntries(Object.entries(values).filter(([name]) => !name.startsWith("DOPPLER_")))
}

function renderEnvConfig(project: string, vars: Readonly<Record<string, EnvVarRule>>): string {
  const lines = Object.entries(vars).map(([name, rule]) => `    ${name}: "${rule}",`)
  return [
    'import { defineEnv } from "@sixb/core/env"',
    `import { doppler } from "${DOPPLER_PACKAGE}"`,
    "",
    "export default defineEnv({",
    `  source: doppler({ project: ${JSON.stringify(project)} }),`,
    "  vars: {",
    ...lines,
    "  },",
    "})",
    "",
  ].join("\n")
}

/** `sixb.env.ts` doesn't exist yet to load a source from, so this finds the project's own copy. */
async function loadDopplerSource(cwd: string, project: string): Promise<EnvSource> {
  let path: string
  try {
    path = Bun.resolveSync(DOPPLER_PACKAGE, cwd)
  } catch {
    throw new SixbCliError(`[SixbEnv] This project doesn't have ${DOPPLER_PACKAGE} yet.`, {
      remediation: `bun add ${DOPPLER_PACKAGE}`,
    })
  }
  const module = (await import(pathToFileURL(path).href)) as {
    readonly doppler: (options: { readonly project: string }) => EnvSource
  }
  return module.doppler({ project })
}

// ─── shared ──────────────────────────────────────────────────────────────────

function parseEnvName(value: string | undefined): EnvName {
  if (value === "dev" || value === "prod") return value
  throw new SixbCliError("[SixbEnv] Choose an environment: --env dev or --env prod.")
}

async function requireSource(
  cwd: string
): Promise<{ readonly config: EnvConfig; readonly source: EnvSource }> {
  const config = await loadEnvConfig(cwd)
  if (!config) {
    throw new SixbCliError(`[SixbEnv] No ${ENV_CONFIG_FILE} in ${cwd}.`, {
      remediation: "sixb env init <project> --dev .env --prod .env.prod",
    })
  }
  if (!config.source) {
    throw new SixbCliError(`[SixbEnv] ${ENV_CONFIG_FILE} has no \`source\`.`, {
      remediation: `Add one, such as \`source: doppler({ project: "shop" })\` from ${DOPPLER_PACKAGE}.`,
    })
  }
  return { config, source: config.source }
}
