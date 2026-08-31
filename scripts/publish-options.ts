export type PublishAuthType = "legacy" | "web"

export interface PublishOptions {
  readonly authType?: PublishAuthType
  readonly dryRun: boolean
  readonly planOnly: boolean
  readonly tag: string
  readonly otp?: string
  readonly registry?: string
}

const usage =
  "bun scripts/publish.ts [--plan] [--dry-run] [--tag <tag>] " +
  "[--auth-type <web|legacy>] [--otp <code>] [--registry <url>]"

export function parsePublishOptions(argv: string[]): PublishOptions {
  const values = new Map<string, string>()
  let dryRun = false
  let planOnly = false

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--dry-run") {
      dryRun = true
      continue
    }
    if (arg === "--plan") {
      planOnly = true
      continue
    }
    if (arg === "--auth-type" || arg === "--tag" || arg === "--otp" || arg === "--registry") {
      const value = argv[index + 1]
      if (!value || value.startsWith("--")) {
        throw new Error(`[SixbPublish] ${arg} needs a value.`)
      }
      values.set(arg, value)
      index++
      continue
    }
    throw new Error(`[SixbPublish] Unknown argument ${arg}. Usage: ${usage}`)
  }

  const authType = parseAuthType(values.get("--auth-type"))

  const otp = values.get("--otp")
  if (authType === "web" && otp) {
    throw new Error(
      "[SixbPublish] --auth-type web cannot be combined with --otp. " +
        "Approve the browser challenge with your passkey instead."
    )
  }

  const registry = values.get("--registry")
  return {
    dryRun,
    planOnly,
    tag: values.get("--tag") ?? "latest",
    ...(authType ? { authType } : {}),
    ...(otp ? { otp } : {}),
    ...(registry ? { registry } : {}),
  }
}

function parseAuthType(value: string | undefined): PublishAuthType | undefined {
  if (!value) return undefined
  if (value === "legacy" || value === "web") return value
  throw new Error(`[SixbPublish] --auth-type must be "web" or "legacy" (received "${value}").`)
}
