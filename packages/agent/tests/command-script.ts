import type { RunCommandOptions } from "@sixb/core"
import { SCRIPT_VARIABLE } from "../src/login-shell"

/** The script a test sandbox's `bash` command runs: in its environment, else its last argument. */
export function commandScript(
  args: readonly string[],
  options: RunCommandOptions = {}
): string | undefined {
  return options.env?.[SCRIPT_VARIABLE] ?? args.at(-1)
}

/** All a test sandbox's command was given: its arguments, and the script in its environment. */
export function commandText(args: readonly string[], options: RunCommandOptions = {}): string {
  return [...args, options.env?.[SCRIPT_VARIABLE] ?? ""].join("\n")
}
