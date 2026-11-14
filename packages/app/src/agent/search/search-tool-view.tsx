import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@sixb/ui/components"
import {
  Bookmark,
  BookOpen,
  Boxes,
  ChevronRight,
  FolderSearch,
  type LucideIcon,
  TextSearch,
} from "lucide-react"
import type { ReactNode } from "react"
import { ActivityStatusText } from "../components/activity-status"
import { useAgentMessages } from "../i18n"
import type { NormalizedTool } from "../parts"
import {
  describeGlob,
  describeGrep,
  type GrepGroup,
  highlightLine,
  type SearchDescription,
  type SearchPlace,
  splitPath,
} from "./interpret"

/** Files the agent found by name: `Found 12 files`, opening to the list. */
export function GlobToolView({ tool }: { tool: NormalizedTool }) {
  const messages = useAgentMessages()
  const description = describeGlob(tool, messages)
  return (
    <SearchRow
      tool={tool}
      description={description}
      icon={placeIcon(description.place, FolderSearch)}
    >
      {description.files.length > 0 ? (
        <ResultBlock>
          {description.files.map((path) => (
            <div key={path} className="min-w-max px-2.5">
              <PathText path={path} />
            </div>
          ))}
        </ResultBlock>
      ) : (
        <p className="text-muted-foreground/60">{messages.search.noFiles}</p>
      )}
    </SearchRow>
  )
}

/** Text the agent searched for: `Searched for “retries” · 8 matches in 3 files`, opening to them. */
export function GrepToolView({ tool }: { tool: NormalizedTool }) {
  const messages = useAgentMessages()
  const description = describeGrep(tool, messages)
  return (
    <SearchRow
      tool={tool}
      description={description}
      icon={placeIcon(description.place, TextSearch)}
    >
      {description.groups.length > 0 ? (
        <ResultBlock>
          {description.groups.map((group) => (
            <MatchGroup
              key={group.path}
              group={group}
              highlight={description.highlight}
              more={messages.search.moreInFile(group.more)}
            />
          ))}
        </ResultBlock>
      ) : (
        <p className="text-muted-foreground/60">{messages.search.noLines}</p>
      )}
    </SearchRow>
  )
}

function placeIcon(place: SearchPlace, files: LucideIcon): LucideIcon {
  switch (place.kind) {
    case "memory":
      return Bookmark
    case "guide":
      return BookOpen
    case "ontology":
      return Boxes
    default:
      return files
  }
}

/**
 * The step as one quiet line, as `read` shows; open, what the search was, then what it found, and
 * what that leaves out.
 */
function SearchRow({
  tool,
  description,
  icon: Icon,
  children,
}: {
  tool: NormalizedTool
  description: SearchDescription
  icon: LucideIcon
  children: ReactNode
}) {
  const messages = useAgentMessages()
  const running = tool.state === "input-streaming" || tool.state === "input-available"
  const error = tool.state === "output-error"

  if (running) {
    return (
      <div className="flex w-fit max-w-full items-center gap-1.5 text-[13px] leading-normal text-muted-foreground">
        <Icon className="size-3.5 shrink-0" />
        <ActivityStatusText label={description.runningTitle} className="font-medium shimmer" />
      </div>
    )
  }

  const label = error ? description.failedTitle : description.title
  const query = [
    description.pattern,
    description.include,
    description.path ? messages.search.in(description.path) : undefined,
  ].filter(Boolean)

  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-fit max-w-full items-center gap-1.5 text-[13px] leading-normal text-muted-foreground transition-colors hover:text-foreground">
        <Icon className="size-3.5 shrink-0" />
        {/* On a narrow screen the detail gives way first, so the step keeps its name: the name
            shrinks only past the room the icon and the chevron leave. */}
        <span className="max-w-[calc(100%-2.5rem)] shrink-0 truncate font-medium">{label}</span>
        {description.detail && !error ? (
          <span className="min-w-0 shrink truncate text-muted-foreground/60">
            {description.detail}
          </span>
        ) : null}
        <ChevronRight className="size-3.5 shrink-0 opacity-0 transition-all group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[state=open]:rotate-90 group-data-[state=open]:opacity-100" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-3 min-w-0 space-y-2 text-xs">
          {query.length > 0 ? (
            <p className="truncate font-mono text-[10px] text-muted-foreground/60">
              {query.join(" · ")}
            </p>
          ) : null}
          {error ? (
            <pre className="scrollbar-thin max-h-60 overflow-auto rounded bg-muted/50 p-2 text-[11px] leading-relaxed whitespace-pre-wrap text-foreground">
              {tool.errorText?.trim() || messages.search.error}
            </pre>
          ) : (
            children
          )}
          {error
            ? null
            : description.notes.map((note) => (
                <p key={note} className="text-muted-foreground/60">
                  {note}
                </p>
              ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ResultBlock({ children }: { children: ReactNode }) {
  return (
    <div className="scrollbar-thin max-h-60 overflow-auto rounded bg-muted/50 py-1.5 font-mono text-[11px] leading-relaxed">
      {children}
    </div>
  )
}

/** A path with its folder quiet, so the file's name is what the eye finds. */
function PathText({ path }: { path: string }) {
  const { folder, name } = splitPath(path)
  return (
    <>
      {folder ? <span className="text-muted-foreground/70">{folder}</span> : null}
      <span className="text-foreground">{name}</span>
    </>
  )
}

function MatchGroup({
  group,
  highlight,
  more,
}: {
  group: GrepGroup
  highlight: RegExp | undefined
  more: string
}) {
  // Every number of the file takes the width of the longest, so the lines start in one column.
  const width = `${String(Math.max(...group.matches.map((match) => match.line))).length}ch`
  return (
    <div className="pb-1.5 last:pb-0">
      <div className="min-w-max px-2.5 font-medium">
        <PathText path={group.path} />
      </div>
      {group.matches.map((match) => (
        <div key={match.line} className="flex min-w-max gap-3 px-2.5">
          <span
            className="shrink-0 select-none text-right text-muted-foreground/50 tabular-nums"
            style={{ width }}
          >
            {match.line}
          </span>
          <span className="whitespace-pre text-foreground/80">
            {highlightLine(match.text, highlight).map((segment, index) =>
              segment.match ? (
                // Runs of one line never reorder: the index is their identity.
                <mark
                  key={index}
                  className="rounded-[3px] bg-amber-400/30 text-foreground dark:bg-amber-300/25"
                >
                  {segment.text}
                </mark>
              ) : (
                <span key={index}>{segment.text}</span>
              )
            )}
          </span>
        </div>
      ))}
      {group.more > 0 ? (
        <div className="min-w-max px-2.5 text-muted-foreground/60 italic">
          <span className="inline-block select-none" style={{ width, marginRight: "0.75rem" }} />
          {more}
        </div>
      ) : null}
    </div>
  )
}
