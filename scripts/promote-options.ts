export interface PromoteOptions {
  readonly sourceTag: string
  readonly targetTag: string
  readonly planOnly: boolean
  readonly registry?: string
  readonly otp?: string
}

const usage =
  "bun scripts/promote.ts [--plan] [--from <tag>] [--to <tag>] " +
  "[--otp <code>] [--registry <url>]"

export function parsePromoteOptions(argv: string[]): PromoteOptions {
  const values = new Map<string, string>()
  let planOnly = false

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--plan") {
      planOnly = true
      continue
    }
    if (arg === "--from" || arg === "--to" || arg === "--otp" || arg === "--registry") {
      const value = argv[index + 1]
      if (!value || value.startsWith("--")) {
        throw new Error(`[SixbPromote] ${arg} needs a value.`)
      }
      values.set(arg, value)
      index++
      continue
    }
    throw new Error(`[SixbPromote] Unknown argument ${arg}. Usage: ${usage}`)
  }

  return {
    sourceTag: values.get("--from") ?? "next",
    targetTag: values.get("--to") ?? "latest",
    planOnly,
    ...(values.get("--registry") ? { registry: values.get("--registry") } : {}),
    ...(values.get("--otp") ? { otp: values.get("--otp") } : {}),
  }
}
