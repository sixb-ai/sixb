/** The environments a project keeps values for. */
export type EnvName = "dev" | "prod"

/**
 * When a variable must have a value. `required`: in every environment. `prod`: in `prod` only.
 * `optional`: never, though the name is still known.
 */
export type EnvVarRule = "required" | "prod" | "optional"

/**
 * Where a project's values live, such as `doppler({ project })` from `@sixb/env-doppler`.
 * Third-party sources are not supported in 0.1.x: this contract still grows with `sixb env`.
 */
export interface EnvSource {
  /** The names `env` has values for, without reading the values. */
  names(env: EnvName): Promise<readonly string[]>
  /** Every value `env` has. `token` overrides how the source would otherwise authenticate. */
  read(
    env: EnvName,
    options?: { readonly token?: string }
  ): Promise<Readonly<Record<string, string>>>
  /** Creates or updates these values, and leaves the rest alone. */
  write(env: EnvName, values: Readonly<Record<string, string>>): Promise<void>
}

/** The source could not answer: an outage, not a refusal. A retry may succeed unchanged. */
export class EnvSourceUnreachableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "EnvSourceUnreachableError"
  }
}

/** The variables a project needs, in `sixb.env.ts`. Holds names only, never values. */
export interface EnvConfig {
  /** Where the values live. Without one, the project keeps its own `.env`. */
  readonly source?: EnvSource
  readonly vars: Readonly<Record<string, EnvVarRule>>
}

/** Declares a project's variables in `sixb.env.ts`. The CLI validates it when it loads the file. */
export function defineEnv<const TConfig extends EnvConfig>(config: TConfig): TConfig {
  return config
}
