import type { EnvName } from "@sixb/core/env"
import { header, headline, plural, screen, stack, table } from "./layout"
import { tone } from "./theme"

export function envPulledView(input: { readonly count: number; readonly env: EnvName }): string {
  return screen(headline("ok", `Wrote ${plural(input.count, "variable")} to .env`, input.env))
}

/** What a pull says when it leaves `.env` as it was. A deploy watches its output for this. */
export const ENV_KEPT_MESSAGE = "Kept the current .env"

/** A deploy kept the server's `.env`, because the source was down or the commit has none. */
export function envKeptView(input: { readonly env: EnvName; readonly reason: string }): string {
  return screen(stack(headline("warn", ENV_KEPT_MESSAGE, input.env), tone.muted(input.reason)))
}

export function envSetView(input: {
  readonly name: string
  readonly env: EnvName
  readonly declared: boolean
}): string {
  return screen(
    stack(
      headline("ok", `Set ${input.name}`, input.env),
      input.declared ? null : tone.warn(`Add ${input.name} to sixb.env.ts so it's checked.`)
    )
  )
}

/** What `init` did with `sixb.env.ts`: wrote names into it, left it to the author, or had none to add. */
export type EnvInitConfig =
  | { readonly kind: "written"; readonly names: number }
  | { readonly kind: "paste"; readonly names: number; readonly lines: readonly string[] }
  | { readonly kind: "unchanged" }

export function envInitView(input: {
  /** Per environment: how many values were sent, and how many it had already. */
  readonly uploaded: readonly {
    readonly env: EnvName
    readonly count: number
    readonly already: number
  }[]
  readonly config: EnvInitConfig
}): string {
  const sent = input.uploaded.filter(({ count }) => count > 0)
  const had = input.uploaded.filter(({ already }) => already > 0)
  const { config } = input
  return screen(
    stack(
      sent.length > 0
        ? headline(
            "ok",
            `Uploaded ${sent.map(({ env, count }) => `${plural(count, "variable")} to ${env}`).join(" and ")}`
          )
        : headline("ok", "Nothing to upload"),
      had.length > 0
        ? tone.muted(
            `Already there: ${had.map(({ env, already }) => `${already} in ${env}`).join(", ")}`
          )
        : null,
      config.kind === "written"
        ? headline("ok", `Wrote sixb.env.ts with ${plural(config.names, "name")}`)
        : null,
      config.kind === "paste"
        ? stack(
            headline("warn", `Add ${plural(config.names, "name")} to \`vars\` in sixb.env.ts`),
            tone.muted(
              "It isn't an empty `vars: {}`, so it was left alone. A first guess at each:"
            ),
            config.lines.join("\n")
          )
        : null
    )
  )
}

export interface EnvStatusRow {
  readonly name: string
  readonly dev: EnvStatusCell
  readonly prod: EnvStatusCell
  readonly declared: boolean
}

/** `set` has a value; `missing` must have one; `unneeded` needs none; `unknown` can't be read. */
export type EnvStatusCell = "set" | "missing" | "unneeded" | "unknown"

const CELLS: Readonly<Record<EnvStatusCell, () => string>> = {
  set: () => tone.ok("✓"),
  missing: () => tone.fail("✗ missing"),
  unneeded: () => tone.faint("–"),
  unknown: () => tone.faint("no access"),
}

export function envStatusView(input: {
  readonly rows: readonly EnvStatusRow[]
  readonly missing: number
}): string {
  return screen(
    header("env status"),
    table(
      ["", "dev", "prod", ""],
      input.rows.map((row) => [
        row.name,
        CELLS[row.dev](),
        CELLS[row.prod](),
        row.declared ? "" : tone.muted("not in sixb.env.ts"),
      ])
    ),
    input.missing > 0
      ? headline("warn", `${plural(input.missing, "value")} missing`)
      : input.rows.some((row) => row.dev === "unknown" || row.prod === "unknown")
        ? headline("ok", "Everything sixb.env.ts requires is set where you have access")
        : headline("ok", "Everything sixb.env.ts requires is set")
  )
}
