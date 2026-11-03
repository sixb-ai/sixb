import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { EnvConfig, EnvName } from "@sixb/core/env"
import { SixbCliError } from "./errors"

export const ENV_CONFIG_FILE = "sixb.env.ts"

const VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const VAR_RULES: ReadonlySet<unknown> = new Set(["required", "prod", "optional"])

/** Loads `sixb.env.ts` from the project directory. A project without one has no declared names. */
export async function loadEnvConfig(cwd = process.cwd()): Promise<EnvConfig | null> {
  const path = resolve(cwd, ENV_CONFIG_FILE)
  if (!(await Bun.file(path).exists())) return null

  const module = (await import(pathToFileURL(path).href)) as { readonly default?: unknown }
  if (module.default === undefined) {
    throw new SixbCliError(`[SixbEnv] ${path} has no default export.`, {
      remediation: "Export the variables: `export default defineEnv({ vars: { ... } })`.",
    })
  }
  return validateEnvConfig(module.default)
}

function validateEnvConfig(value: unknown): EnvConfig {
  const vars = (value as { readonly vars?: unknown } | null)?.vars
  if (typeof vars !== "object" || vars === null || Array.isArray(vars)) {
    throw new SixbCliError(`[SixbEnv] ${ENV_CONFIG_FILE} must set \`vars\`.`, {
      remediation: 'Name each variable with a rule: `vars: { DATABASE_URL: "required" }`.',
    })
  }

  for (const [name, rule] of Object.entries(vars)) {
    if (!VAR_NAME_PATTERN.test(name)) {
      throw new SixbCliError(`[SixbEnv] "${name}" in ${ENV_CONFIG_FILE} is not a variable name.`)
    }
    if (!VAR_RULES.has(rule)) {
      throw new SixbCliError(
        `[SixbEnv] ${name} in ${ENV_CONFIG_FILE} must be "required", "prod", or "optional".`
      )
    }
  }
  return value as EnvConfig
}

/** The names `env` must have a value for and doesn't. An empty value counts as none. */
export function missingEnvVars(
  config: EnvConfig,
  values: Readonly<Record<string, string | undefined>>,
  env: EnvName
): string[] {
  return Object.entries(config.vars)
    .filter(([name, rule]) => {
      const needed = rule === "required" || (rule === "prod" && env === "prod")
      return needed && !values[name]
    })
    .map(([name]) => name)
}

/** The sentence every command uses to name what is missing. */
function missingEnvMessage(names: readonly string[]): string {
  return `[SixbEnv] Missing ${names.join(", ")}, which ${ENV_CONFIG_FILE} requires.`
}

/** Stops a command that is about to run the project without a variable it declares. */
export async function assertDeclaredEnv(cwd: string): Promise<void> {
  const config = await loadEnvConfig(cwd)
  if (!config) return

  const env = process.env.NODE_ENV === "production" ? "prod" : "dev"
  const missing = missingEnvVars(config, process.env, env)
  if (missing.length > 0) {
    throw new SixbCliError(missingEnvMessage(missing), {
      remediation: "Add what's missing to the project's .env.",
    })
  }
}
