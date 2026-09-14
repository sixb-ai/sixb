import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@sixb/ui/components"
import { ArrowUpRight, ChevronRight, Globe } from "lucide-react"
import type { NormalizedTool } from "../parts"
import { coerceWebFetchOutput, webFetchUrl } from "../utils/webFetch"
import { ActivityStatusText } from "./ActivityStatus"
import { SourceFavicon } from "./WebSources"

export function WebFetchToolView({ tool }: { tool: NormalizedTool }) {
  const running = tool.state === "input-streaming" || tool.state === "input-available"
  const failed = tool.state === "output-error"
  const source = coerceWebFetchOutput(tool.output)
  const url = webFetchUrl(tool.input)
  const domain = source?.domain ?? url?.hostname.replace(/^www\./, "") ?? "web page"
  const favicon = source?.faviconUrl ?? (url ? new URL("/favicon.ico", url.origin).href : null)

  return (
    <Collapsible className="min-w-0 space-y-1 text-[13px] text-muted-foreground">
      <CollapsibleTrigger className="group flex w-full min-w-0 items-start gap-2 rounded py-0.5 text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11">
        <span className="mt-0.5 shrink-0">
          {favicon ? (
            <SourceFavicon key={favicon} url={favicon} />
          ) : (
            <Globe className="size-3.5 shrink-0" aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          {running ? (
            <ActivityStatusText
              label={`Reading ${domain}`}
              className="shimmer motion-reduce:animate-none"
            />
          ) : (
            <span className="line-clamp-2 font-medium break-words">
              {failed ? `Could not read ${domain}` : (source?.title ?? `Read ${domain}`)}
            </span>
          )}
          {source && !running && !failed ? (
            <span className="mt-0.5 block truncate text-xs text-muted-foreground/70">{domain}</span>
          ) : null}
        </span>
        <ChevronRight className="mt-0.5 size-3.5 shrink-0 opacity-0 transition-all group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[state=open]:rotate-90 group-data-[state=open]:opacity-100 motion-reduce:transition-none" />
      </CollapsibleTrigger>
      {failed ? (
        <p className="pl-[26px] whitespace-pre-wrap break-words">
          {tool.errorText || "The page could not be read."}
        </p>
      ) : null}
      <CollapsibleContent className="space-y-2 pt-1 pl-[26px]">
        {source ? (
          <>
            <p className="leading-relaxed break-words">
              {source.excerpt || "No page text was returned."}
            </p>
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex w-fit items-center gap-1 rounded text-xs font-medium underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
            >
              Open page
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  )
}
