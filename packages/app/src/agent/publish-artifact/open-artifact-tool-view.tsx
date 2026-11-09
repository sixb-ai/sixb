import { FileText } from "lucide-react"
import { ActivityStatusText } from "../components/activity-status"
import { useAgentMessages } from "../i18n"
import type { NormalizedTool } from "../parts"

/**
 * An `open_artifact` call in the work trace: the Agent opened an artifact to read it, or to revise
 * it. A calm step, as reading a file is; a failure says why, without the harness's prefix.
 */
export function OpenArtifactToolView({ tool }: { tool: NormalizedTool }) {
  const messages = useAgentMessages().artifacts
  const title = openedTitle(tool)
  const running = tool.state === "input-streaming" || tool.state === "input-available"
  const failed = tool.state === "output-error"
  const label = failed
    ? messages.openFailed(title)
    : running
      ? messages.opening(title)
      : messages.opened(title)

  return (
    <div className="min-w-0 space-y-1">
      <div className="flex w-fit max-w-full items-center gap-1.5 text-[13px] leading-normal text-muted-foreground">
        <FileText className="size-3.5 shrink-0" />
        {running ? (
          <ActivityStatusText label={label} className="font-medium shimmer" />
        ) : (
          <span className="min-w-0 truncate font-medium">{label}</span>
        )}
      </div>
      {failed && tool.errorText ? (
        <p className="pl-5 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground/80">
          {tool.errorText.replace(/^\[SixbAgent\] open_artifact refused: /, "")}
        </p>
      ) : null}
    </div>
  )
}

/** The title the artifact has, once opened; until then, nothing the Agent could make up. */
function openedTitle(tool: NormalizedTool): string {
  const output = tool.output
  return typeof output === "object" &&
    output !== null &&
    "title" in output &&
    typeof output.title === "string"
    ? output.title
    : ""
}
