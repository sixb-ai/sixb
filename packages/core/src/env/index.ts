/** The environments a project keeps values for. */
export type EnvName = "dev" | "prod"

/**
 * When a variable must have a value. `required`: in every environment. `prod`: in `prod` only.
 * `optional`: never, though the name is still known.
 */
export type EnvVarRule = "required" | "prod" | "optional"

/** The variables a project needs, in `sixb.env.ts`. Holds names only, never values. */
export interface EnvConfig {
  readonly vars: Readonly<Record<string, EnvVarRule>>
}

/** Declares a project's variables in `sixb.env.ts`. The CLI validates it when it loads the file. */
export function defineEnv<const TConfig extends EnvConfig>(config: TConfig): TConfig {
  return config
}
