import { Search } from "lucide-react"
import type { NormalizedTool } from "../parts"
import { coerceWebSearchOutput, webSearchQuery } from "../utils/webSearch"
import { ActivityStatusText } from "./ActivityStatus"

export function WebSearchToolView({ tool }: { tool: NormalizedTool }) {
  const running = tool.state === "input-streaming" || tool.state === "input-available"
  const failed = tool.state === "output-error"
  const sources = coerceWebSearchOutput(tool.output)
  const query = webSearchQuery(tool.input)
  return (
    <div className="min-w-0 space-y-1 text-[13px] text-muted-foreground">
      <div className="flex items-center gap-1.5">
        <Search className="size-3.5 shrink-0" aria-hidden="true" />
        {running ? (
          <ActivityStatusText
            label="Searching the web"
            className="shimmer motion-reduce:animate-none"
          />
        ) : (
          <span>{failed ? "Web search failed" : "Searched the web"}</span>
        )}
        {!running && !failed && sources ? (
          <span className="text-xs">
            · {sources.length} {sources.length === 1 ? "result" : "results"}
          </span>
        ) : null}
      </div>
      {query ? <p className="pl-5 break-words">{query}</p> : null}
      {failed ? (
        <p className="pl-5 whitespace-pre-wrap break-words">
          {tool.errorText || "The search could not be completed."}
        </p>
      ) : null}
    </div>
  )
}
