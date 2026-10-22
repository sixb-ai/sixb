import { relative, sep } from "node:path"

const RESET = "\u001b[0m"
const BOLD = "\u001b[1m"

// Sixb's colors, as in the `sixb` CLI: green for done, blue for what to run, grey for the rest.
const GREEN = color(48, 209, 88, 32)
const BLUE = color(10, 132, 255, 34)
const MUTED = color(139, 145, 154, 90)

export interface CreateSuccessOutput {
  name: string
  targetDir: string
}

export function formatCreateSuccess(result: CreateSuccessOutput, cwd = process.cwd()): string {
  const commands = createNextSteps(result.targetDir, cwd)

  return [
    "",
    `  ${style("✓", GREEN)} ${style(`Created ${result.name}`, BOLD)}`,
    `    ${style(result.targetDir, MUTED)}`,
    "",
    `  ${style("Next steps", BOLD)}`,
    ...commands.map((command) => `  ${style("$", MUTED)} ${style(command, BLUE)}`),
    "",
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

/** A 24-bit color where the terminal says it takes one, the named color otherwise. */
function color(r: number, g: number, b: number, named: number): string {
  const colorterm = process.env.COLORTERM?.toLowerCase()
  return colorterm === "truecolor" || colorterm === "24bit"
    ? `\u001b[38;2;${r};${g};${b}m`
    : `\u001b[${named}m`
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
