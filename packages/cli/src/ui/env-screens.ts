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

export function envInitView(input: {
  readonly uploaded: readonly { readonly env: EnvName; readonly count: number }[]
  readonly names: number
}): string {
  const uploaded = input.uploaded.map(({ env, count }) => `${plural(count, "variable")} to ${env}`)
  return screen(
    stack(
      headline("ok", `Uploaded ${uploaded.join(" and ")}`),
      headline("ok", `Wrote sixb.env.ts with ${plural(input.names, "name")}`)
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
