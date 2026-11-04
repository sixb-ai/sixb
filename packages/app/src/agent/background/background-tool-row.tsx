import { Terminal } from "lucide-react"
import { ActivityStatusText } from "../components/activity-status"
import { useAgentMessages } from "../i18n"
import type { NormalizedTool } from "../parts"
import { toolResultValue } from "../parts"
import { useBackgroundCards } from "./context"
import { backgroundRowLabel } from "./interpret"

/**
 * A call that starts, reads or stops a background command, as one quiet line of the work: the
 * card under the work is where the command stands, so the line only says what the agent did.
 */
export function BackgroundToolRow({ tool }: { readonly tool: NormalizedTool }) {
  const messages = useAgentMessages()
  const context = useBackgroundCards()
  const running = tool.state === "input-streaming" || tool.state === "input-available"
  const label = backgroundRowLabel(tool, messages)
  const detail = commandNamed(tool, context?.thread.commands)

  return (
    <div className="flex w-fit max-w-full items-center gap-1.5 text-[13px] leading-normal text-muted-foreground">
      <Terminal className="size-3.5 shrink-0" />
      {running ? (
        <ActivityStatusText label={label} className="font-medium shimmer" />
      ) : (
        <span className="min-w-0 truncate font-medium">{label}</span>
      )}
      {detail ? (
        // A phone keeps the line for what the agent did.
        <span className="hidden min-w-0 shrink truncate font-mono text-xs text-muted-foreground/60 sm:inline">
          {detail}
        </span>
      ) : null}
    </div>
  )
}

/** The command a call names: its own input, what it returned, or the start of that id. */
function commandNamed(
  tool: NormalizedTool,
  commands: ReadonlyMap<string, { readonly id: string; readonly command: string }> | undefined
): string {
  const input = isRecord(tool.input) ? tool.input : {}
  const output = toolResultValue(tool.output)
  const named =
    typeof input.command === "string"
      ? input.command
      : isRecord(output) && typeof output.command === "string"
        ? output.command
        : [...(commands?.values() ?? [])].reverse().find((command) => command.id === input.id)
            ?.command
  const line = named?.trim().split("\n")[0] ?? ""
  return line || (typeof input.id === "string" ? input.id : "")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
