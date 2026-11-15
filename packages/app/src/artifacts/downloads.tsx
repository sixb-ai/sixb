import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { ArrowDownToLine, LoaderCircle } from "lucide-react"
import { Fragment, useState } from "react"
import { FileTypeIcon, type FileTypeName } from "./file-type-icon"
import { useArtifactMessages } from "./messages"

/** One file an artifact downloads as: a file to fetch, or one built when chosen. */
export interface DownloadOption {
  readonly key: string
  readonly type: FileTypeName
  readonly title: string
  /** A quieter line under the title: the file's name, or what it holds. */
  readonly detail?: string
  /** The heading of the group it starts or belongs to, in the menu. */
  readonly section?: string
  readonly href?: string
  /** The name it saves as, for a file fetched by `href`. */
  readonly fileName?: string
  /** Builds and saves the file, for a download made in the browser. */
  readonly run?: () => Promise<void>
}

/**
 * The header's Download: a menu of the files an artifact downloads as, each with its type's icon,
 * its name, and what it holds. A file built in the browser shows its progress on the button, and
 * says so beside it when it fails.
 */
export function DownloadMenu({
  options,
  className,
}: {
  readonly options: readonly DownloadOption[]
  readonly className?: string
}) {
  const messages = useArtifactMessages().viewer
  const [state, setState] = useState<"idle" | "working" | "failed">("idle")
  if (options.length === 0) return null

  const choose = async (option: DownloadOption) => {
    if (!option.run) return
    setState("working")
    try {
      await option.run()
      setState("idle")
    } catch (error) {
      console.warn(`[SixbApp] Could not build ${option.title}:`, error)
      setState("failed")
    }
  }

  return (
    <span className={cn("flex shrink-0 items-center gap-2", className)}>
      {state === "failed" ? (
        <span role="status" className="hidden text-xs text-destructive @lg:inline">
          {messages.downloadFailed}
        </span>
      ) : null}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          aria-label={messages.downloadLabel}
          title={messages.downloadLabel}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted data-[state=open]:text-foreground [&_svg]:size-[17px] [&_svg]:stroke-[1.75]"
        >
          {state === "working" ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : (
            <ArrowDownToLine aria-hidden="true" />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={6}
          className="max-h-[min(28rem,70vh)] w-72 p-1.5"
        >
          {options.map((option, index) => {
            const startsSection = option.section && option.section !== options[index - 1]?.section
            const content = (
              <>
                <FileTypeIcon type={option.type} />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[13px] font-medium text-foreground">
                    {option.title}
                  </span>
                  {option.detail ? (
                    <span className="truncate text-xs text-muted-foreground">{option.detail}</span>
                  ) : null}
                </span>
              </>
            )
            return (
              <Fragment key={option.key}>
                {startsSection ? (
                  <>
                    {index > 0 ? <DropdownMenuSeparator /> : null}
                    <DropdownMenuLabel className="px-2 pt-1.5 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                      {option.section}
                    </DropdownMenuLabel>
                  </>
                ) : null}
                {option.href ? (
                  <DropdownMenuItem asChild className="gap-3 rounded-md px-2 py-1.5">
                    <a href={option.href} download={option.fileName}>
                      {content}
                    </a>
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    className="gap-3 rounded-md px-2 py-1.5"
                    disabled={state === "working"}
                    onSelect={() => void choose(option)}
                  >
                    {content}
                  </DropdownMenuItem>
                )}
              </Fragment>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}
