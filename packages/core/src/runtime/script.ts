import { createScriptScope } from "../execution/scopes"
import type { SixbHostView } from "./host"
import type { Sixb } from "./sixb"

/**
 * What `sixb run` passes a script's default export.
 *
 * ```ts
 * import type { ScriptContext } from "@sixb/core"
 *
 * export default async function ({ sixb, args, signal }: ScriptContext) {
 *   // ...
 * }
 * ```
 */
export interface ScriptContext {
  /** The project's SDK, with full access. Its writes are attributed to this script. */
  readonly sixb: Sixb
  /** Everything after the script's path on the command line, untouched. */
  readonly args: readonly string[]
  /**
   * Aborts on Ctrl-C or SIGTERM, so the script can stop between steps; a second one exits at once.
   * A closed SSH connection exits at once.
   */
  readonly signal: AbortSignal
}

/**
 * Binds a new script execution, recorded under `path` (the script's path relative to the project),
 * and returns what calls the script's default export with it. Call it as soon as the host loads:
 * from then on this process leaves the outbox and queues to the project's instance, which matters
 * even when the script never runs, since closing the broker would otherwise publish that
 * instance's events here.
 */
export function bindScript(
  host: SixbHostView,
  path: string
): {
  run(input: {
    readonly main: unknown
    readonly args: readonly string[]
    readonly signal: AbortSignal
  }): Promise<void>
} {
  const sixb = host.withScope(createScriptScope({ projectId: host.id, path })) as Sixb
  return {
    async run({ main, args, signal }) {
      if (typeof main !== "function") {
        throw new Error(
          `[Sixb] ${path} must export a function as its default export: ` +
            "`export default async function ({ sixb, args, signal }: ScriptContext) { ... }`."
        )
      }
      const context: ScriptContext = Object.freeze({
        sixb,
        args: Object.freeze([...args]),
        signal,
      })
      await main(context)
    },
  }
}
