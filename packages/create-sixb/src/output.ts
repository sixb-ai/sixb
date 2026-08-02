import { relative, sep } from "node:path"

const RESET = "\u001b[0m"
const BOLD = "\u001b[1m"
const CYAN = "\u001b[36m"
const GREEN = "\u001b[32m"
const DIM = "\u001b[2m"

export interface CreateSuccessOutput {
  name: string
  targetDir: string
}

export function formatCreateSuccess(result: CreateSuccessOutput, cwd = process.cwd()): string {
  const commands = createNextSteps(result.targetDir, cwd)

  return [
    style("sixb", BOLD, CYAN),
    "",
    `${style("Success!", BOLD, GREEN)} Created ${result.name}`,
    style(result.targetDir, DIM),
    "",
    style("Next steps", BOLD, CYAN),
    ...commands.map((command) => `  ${style(command, CYAN)}`),
  ].join("\n")
}

export function createNextSteps(targetDir: string, cwd = process.cwd()): string[] {
  const target = relative(cwd, targetDir)
  const commands: string[] = []

  if (target) {
    const outsideCwd = target === ".." || target.startsWith(`..${sep}`)
    commands.push(`cd ${quoteShellArgument(outsideCwd ? targetDir : target)}`)
  }

  commands.push("bun install", "bun run dev")
  return commands
}

function quoteShellArgument(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function style(value: string, ...codes: string[]): string {
  if (!shouldUseColor()) return value
  return `${codes.join("")}${value}${RESET}`
}

function shouldUseColor(): boolean {
  if ("NO_COLOR" in process.env) return false

  const forced = process.env.FORCE_COLOR
  if (forced !== undefined) return forced !== "0" && forced !== "false"

  return Boolean(process.stdout.isTTY) && process.env.TERM !== "dumb"
}
