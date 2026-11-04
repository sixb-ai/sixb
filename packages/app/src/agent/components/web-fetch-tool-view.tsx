import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Markdown,
  type MarkdownProps,
} from "@sixb/ui/components"
import { useLocale } from "@sixb/ui/lib/i18n"
import { ArrowUpRight, ChevronRight, Globe } from "lucide-react"
import { formatFileSize } from "../../artifacts/file-size"
import { useAgentMessages } from "../i18n"
import type { NormalizedTool } from "../parts"
import {
  coerceWebFetchOutput,
  type WebFetchPage,
  webFetchQuestion,
  webFetchUrl,
} from "../utils/web-fetch"
import { displayDomain } from "../utils/web-search"
import { ActivityStatusText } from "./activity-status"
import { SourceFavicon } from "./web-sources"

// A page's images, or those its answer quotes, would load from their sites as soon as the row
// opens: the text is enough.
const PAGE_COMPONENTS: MarkdownProps["components"] = { img: () => null }

export function WebFetchToolView({ tool }: { tool: NormalizedTool }) {
  const messages = useAgentMessages().web
  const running = tool.state === "input-streaming" || tool.state === "input-available"
  const failed = tool.state === "output-error"
  const page = coerceWebFetchOutput(tool.output)
  const url = webFetchUrl(tool.input)
  const question = page?.question ?? webFetchQuestion(tool.input)

  const domain = page?.source.domain ?? (url ? displayDomain(url) : messages.webPage)
  const favicon = page?.source.faviconUrl ?? (url ? new URL("/favicon.ico", url.origin).href : null)
  const label = running
    ? question
      ? messages.asking(domain)
      : messages.reading(domain)
    : failed
      ? messages.readFailed(domain)
      : (page?.source.title ?? messages.read(domain))

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
            <ActivityStatusText label={label} className="shimmer motion-reduce:animate-none" />
          ) : (
            <span className="line-clamp-2 font-medium break-words">{label}</span>
          )}
          {page && !running && !failed ? (
            <span className="mt-0.5 block truncate text-xs text-muted-foreground/70">
              {page.redirect ? messages.redirectedTo(page.redirect.domain) : domain}
            </span>
          ) : null}
        </span>
        <ChevronRight className="mt-0.5 size-3.5 shrink-0 opacity-0 transition-all group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[state=open]:rotate-90 group-data-[state=open]:opacity-100 motion-reduce:transition-none" />
      </CollapsibleTrigger>
      {failed ? (
        <p className="pl-[26px] whitespace-pre-wrap break-words">
          {tool.errorText || messages.pageError}
        </p>
      ) : null}
      <CollapsibleContent className="space-y-2 pt-1 pl-[26px]">
        {question ? <p className="font-medium break-words text-foreground/80">{question}</p> : null}
        {page ? <PageContent page={page} /> : null}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** The answer when the agent asked one, else the start of the page; then what the server sent. */
function PageContent({ page }: { page: WebFetchPage }) {
  const messages = useAgentMessages()
  const locale = useLocale()

  const served = [
    page.status,
    page.contentType?.split(";")[0],
    page.bytes !== undefined ? formatFileSize(page.bytes, locale, messages.files) : undefined,
    page.truncated ? messages.web.truncated : undefined,
  ].filter((value) => value !== undefined)

  return (
    <>
      {page.answer ? (
        <>
          <Markdown className="sixb-web-fetch text-foreground" components={PAGE_COMPONENTS}>
            {page.answer}
          </Markdown>
          {page.answerTruncated ? (
            <p className="text-xs text-muted-foreground/70">{messages.web.answerTruncated}</p>
          ) : null}
        </>
      ) : page.preview ? (
        <>
          {page.answerFailed ? <p>{messages.web.answerFailed}</p> : null}
          <div className="scrollbar-thin max-h-60 overflow-y-auto overscroll-contain rounded bg-muted/50 p-2">
            <Markdown className="sixb-web-fetch sixb-web-fetch-page" components={PAGE_COMPONENTS}>
              {page.preview}
            </Markdown>
          </div>
        </>
      ) : page.redirect ? null : (
        <p>{messages.web.noPageText}</p>
      )}
      {served.length > 0 ? (
        <p className="truncate font-mono text-[10px] text-muted-foreground/60">
          {served.join(" · ")}
        </p>
      ) : null}
      <a
        href={page.redirect?.url ?? page.source.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex w-fit items-center gap-1 rounded text-xs font-medium underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
      >
        {messages.web.openPage}
        <ArrowUpRight className="size-3.5" aria-hidden="true" />
        <span className="sr-only">{messages.web.newTab}</span>
      </a>
    </>
  )
}
