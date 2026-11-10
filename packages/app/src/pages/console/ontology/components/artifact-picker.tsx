/**
 * Picks an artifact for a `ref.artifact()` value. The value stays the artifact's id, so the forms
 * that parse it work as they do for a member's id.
 *
 * It lists the artifacts the reader can open, as the gallery does: their own and those a
 * conversation they read shares, most recently updated first. A link to an artifact pasted in the
 * search offers that one, so an artifact found elsewhere is one paste away. A property takes only
 * an artifact its writer can change: one the reader can only read is shown, and why, not offered.
 */
import type { GetArtifactResponse, ListArtifactsResponse } from "@sixb/client"
import { getArtifactOptions, listArtifactsInfiniteOptions } from "@sixb/client/hooks"
import {
  Button,
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@sixb/ui/components"
import { useIsMobile } from "@sixb/ui/hooks"
import { cn } from "@sixb/ui/lib/utils"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { Check, ChevronsUpDown, FileX, Layers, Lock, TriangleAlert, X } from "lucide-react"
import { type ReactNode, type UIEvent, useEffect, useMemo, useRef, useState } from "react"
import { type HeldArtifactProblem, heldArtifactProblem } from "../../../../artifacts/held-artifact"
import { ArtifactKindIcon } from "../../../../artifacts/kind-icon"
import { useArtifactMessages } from "../../../../artifacts/messages"
import { useFormat } from "../../../section-ui"

type ArtifactSummary = ListArtifactsResponse["artifacts"][number] | GetArtifactResponse["artifact"]

const PAGE_SIZE = 50

/** A search reads at most this many pages of the list, so it ends on a project with many. */
const SEARCH_PAGES = 10

/** How near the end of the list a scroll loads more. */
const LOAD_MORE_THRESHOLD_PX = 80

// An artifact's page, a conversation with it open beside, or its id alone.
const ARTIFACT_IN_TEXT = /(?:^|\/artifacts\/|[?&]artifact=)(art_[0-9a-z]{10})(?=$|[/?#&\s])/

/** The artifact a pasted link or id names, such as `https://…/artifacts/art_k3m9q2x7tp?v=2`. */
export function artifactIdIn(text: string): string | null {
  return ARTIFACT_IN_TEXT.exec(text.trim())?.[1] ?? null
}

/** Whether a title holds every word of a search, ignoring case and accents. */
export function titleMatches(title: string, search: string): boolean {
  const folded = fold(title)
  return fold(search)
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => folded.includes(word))
}

function fold(text: string): string {
  return text
    .toLocaleLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
}

export function ArtifactPicker({
  id,
  value,
  onChange,
  disabled,
  required,
  "aria-describedby": ariaDescribedBy,
}: {
  readonly id: string
  /** The chosen artifact's id, or "" for none. */
  readonly value: string
  readonly onChange: (artifactId: string) => void
  readonly disabled?: boolean
  readonly required?: boolean
  readonly "aria-describedby"?: string
}) {
  const messages = useArtifactMessages().picker
  const mobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  // A value set before the list loaded, or one it does not hold, is named by its own lookup.
  const chosenId = value.trim()
  const chosen = useQuery({
    ...getArtifactOptions({ path: { artifactId: chosenId } }),
    enabled: chosenId !== "",
    retry: false,
  })

  const choose = (artifactId: string) => {
    onChange(artifactId)
    setOpen(false)
  }

  const clearable = chosenId !== "" && !disabled

  const trigger = (
    <Button
      type="button"
      variant="outline"
      id={id}
      ref={triggerRef}
      role="combobox"
      aria-expanded={open}
      aria-describedby={ariaDescribedBy}
      aria-required={required || undefined}
      disabled={disabled}
      onClick={mobile ? () => setOpen(true) : undefined}
      className={cn(
        "w-full justify-between gap-2 bg-background font-normal",
        clearable ? "pr-[3.25rem]" : "pr-3"
      )}
    >
      <ChosenLabel
        artifact={chosen.data?.artifact}
        loading={chosen.isLoading}
        problem={chosenId !== "" && chosen.isError ? heldArtifactProblem(chosen.error) : null}
      />
      <ChevronsUpDown className="size-4 shrink-0 opacity-50" aria-hidden="true" />
    </Button>
  )

  // Clearing sits over the trigger rather than in it: a button cannot hold another.
  const clear = clearable ? (
    <button
      type="button"
      onClick={() => {
        onChange("")
        triggerRef.current?.focus()
      }}
      aria-label={messages.clear}
      title={messages.clear}
      className="absolute top-1/2 right-8 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <X className="size-3.5" aria-hidden="true" />
    </button>
  ) : null

  const list = (
    <ArtifactPickerList chosenId={chosenId} chosen={chosen.data?.artifact} onChoose={choose} />
  )

  if (mobile) {
    return (
      <div className="relative">
        {trigger}
        {clear}
        <Drawer open={open} onOpenChange={setOpen}>
          <DrawerContent className="max-h-[85dvh]">
            <DrawerTitle className="px-4 pt-3 pb-2 text-[15px] font-semibold">
              {messages.title}
            </DrawerTitle>
            <DrawerDescription className="sr-only">{messages.search}</DrawerDescription>
            <div className="flex min-h-0 flex-1 flex-col px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              {open ? list : null}
            </div>
          </DrawerContent>
        </Drawer>
      </div>
    )
  }

  // Inside a dialog, the list renders there, so the dialog keeps the focus and the clicks.
  const container = triggerRef.current?.closest<HTMLElement>("[data-slot='dialog-content']")

  return (
    <div className="relative">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent
          container={container}
          align="start"
          collisionPadding={12}
          aria-label={messages.title}
          className="w-[max(var(--radix-popover-trigger-width),22rem)] max-w-[calc(100vw-1.5rem)] overflow-hidden p-0"
        >
          {list}
        </PopoverContent>
      </Popover>
      {clear}
    </div>
  )
}

/** What the trigger says: the chosen artifact, why it cannot be named, or what to do. */
function ChosenLabel({
  artifact,
  loading,
  problem,
}: {
  readonly artifact: ArtifactSummary | undefined
  readonly loading: boolean
  readonly problem: HeldArtifactProblem | null
}) {
  const messages = useArtifactMessages()

  if (artifact) {
    return (
      <span className="flex min-w-0 items-center gap-2">
        <ArtifactKindIcon kind={artifact.kind} className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{artifact.title}</span>
      </span>
    )
  }

  if (loading) {
    return <span className="h-3 w-32 animate-pulse rounded bg-muted motion-reduce:animate-none" />
  }

  if (problem) {
    const Icon = problem === "notShared" ? Lock : FileX
    return (
      <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        <span className="truncate">
          {problem === "gone"
            ? messages.held.gone
            : problem === "notShared"
              ? messages.held.notShared
              : messages.held.loadFailed}
        </span>
      </span>
    )
  }

  return <span className="truncate text-muted-foreground">{messages.picker.choose}</span>
}

/**
 * The search and the artifacts under it: the chosen one first, then the others most recently
 * updated first, or the one a pasted link names. More load as the list scrolls to its end, and a
 * search reads further until it has found what the list holds.
 */
export function ArtifactPickerList({
  chosenId,
  chosen,
  onChoose,
}: {
  readonly chosenId: string
  readonly chosen: ArtifactSummary | undefined
  readonly onChoose: (artifactId: string) => void
}) {
  const messages = useArtifactMessages().picker
  const [search, setSearch] = useState("")
  const linkedId = artifactIdIn(search)
  const searching = search.trim() !== "" && linkedId === null

  const list = useInfiniteQuery({
    ...listArtifactsInfiniteOptions({ query: { limit: String(PAGE_SIZE) } }),
    // The next page's offset, as the query carries it.
    initialPageParam: "0",
    getNextPageParam: (last: ListArtifactsResponse, pages: readonly ListArtifactsResponse[]) =>
      last.hasMore ? String(pages.length * PAGE_SIZE) : undefined,
    retry: false,
  })
  const linked = useQuery({
    ...getArtifactOptions({ path: { artifactId: linkedId ?? "" } }),
    enabled: linkedId !== null,
    retry: false,
  })

  // An artifact updated while the list is read moves up, and can be on two pages: it shows once.
  const artifacts = useMemo(() => {
    const byId = new Map<string, ArtifactSummary>()
    for (const artifact of list.data?.pages.flatMap((page) => page.artifacts) ?? []) {
      if (!byId.has(artifact.id)) byId.set(artifact.id, artifact)
    }
    return [...byId.values()]
  }, [list.data])

  const shown = searching
    ? artifacts.filter((artifact) => titleMatches(artifact.title, search))
    : artifacts.filter((artifact) => artifact.id !== chosenId)

  const pages = list.data?.pages.length ?? 0
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list
  const readFurther = searching && hasNextPage && !isFetchingNextPage && pages < SEARCH_PAGES
  useEffect(() => {
    if (readFurther) void fetchNextPage()
  }, [readFurther, fetchNextPage])

  const loadMoreNearEnd = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    const nearEnd =
      element.scrollHeight - element.scrollTop - element.clientHeight <= LOAD_MORE_THRESHOLD_PX
    if (nearEnd && !searching && hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }

  const body = (): ReactNode => {
    if (linkedId !== null) {
      return (
        <CommandGroup heading={messages.fromLink}>
          {linked.data?.access === "read" ? (
            <ReadOnlyRow artifact={linked.data.artifact} />
          ) : linked.data ? (
            <ArtifactRow
              artifact={linked.data.artifact}
              chosen={linked.data.artifact.id === chosenId}
              onChoose={onChoose}
            />
          ) : linked.isLoading ? (
            <RowSkeletons count={1} />
          ) : (
            <Notice icon={FileX} title={messages.linkUnavailable} />
          )}
        </CommandGroup>
      )
    }

    if (list.isPending) return <RowSkeletons count={4} />

    if (list.isError) {
      return (
        <Notice
          icon={TriangleAlert}
          title={messages.loadFailed}
          action={{ label: messages.retry, onClick: () => void list.refetch() }}
        />
      )
    }

    if (artifacts.length === 0) {
      return <Notice icon={Layers} title={messages.none} description={messages.noneDescription} />
    }

    const chosenRow =
      !searching && chosen ? (
        <CommandGroup heading={messages.chosen}>
          <ArtifactRow artifact={chosen} chosen onChoose={onChoose} />
        </CommandGroup>
      ) : null

    if (shown.length === 0) {
      return (
        <>
          {chosenRow}
          {searching ? (
            readFurther || isFetchingNextPage ? (
              <RowSkeletons count={2} />
            ) : (
              <Notice icon={Layers} title={messages.noMatch} />
            )
          ) : null}
        </>
      )
    }

    return (
      <>
        {chosenRow}
        <CommandGroup heading={searching ? undefined : messages.recent}>
          {shown.map((artifact) => (
            <ArtifactRow
              key={artifact.id}
              artifact={artifact}
              chosen={artifact.id === chosenId}
              onChoose={onChoose}
            />
          ))}
        </CommandGroup>
        {isFetchingNextPage ? <RowSkeletons count={2} /> : null}
      </>
    )
  }

  return (
    // The list is searched here, by title, and a pasted link is never a title to filter by.
    <Command shouldFilter={false} loop className="bg-transparent">
      <CommandInput value={search} onValueChange={setSearch} placeholder={messages.search} />
      <CommandList
        onScroll={loadMoreNearEnd}
        // About six rows beside a field; a phone's sheet gives it more.
        className="max-h-[min(22rem,60dvh)] overscroll-contain p-1 md:max-h-[min(19.5rem,45dvh)]"
      >
        {body()}
      </CommandList>
    </Command>
  )
}

/** One artifact to choose: its kind, its title, and when it last changed. */
function ArtifactRow({
  artifact,
  chosen,
  onChoose,
}: {
  readonly artifact: ArtifactSummary
  readonly chosen: boolean
  readonly onChoose: (artifactId: string) => void
}) {
  const messages = useArtifactMessages()
  const format = useFormat()

  return (
    <CommandItem
      value={artifact.id}
      onSelect={() => onChoose(artifact.id)}
      className="gap-3 rounded-lg px-2 py-1.5"
    >
      <KindTile kind={artifact.kind} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13.5px] leading-snug font-medium text-foreground">
          {artifact.title}
        </span>
        <span className="truncate text-xs leading-snug text-muted-foreground">
          {messages.kinds[artifact.kind]} ·{" "}
          {messages.picker.updated(format.relative(artifact.updatedAt))}
        </span>
      </span>
      <Check
        className={cn("size-4 text-foreground", chosen ? "opacity-100" : "opacity-0")}
        aria-hidden="true"
      />
    </CommandItem>
  )
}

/**
 * An artifact a pasted link names that the reader can read but not change: shown, so they know the
 * link worked, with why it cannot be chosen and what to do. Not an option, so keys pass it by.
 */
function ReadOnlyRow({ artifact }: { readonly artifact: ArtifactSummary }) {
  const messages = useArtifactMessages().picker

  return (
    <div role="status" className="flex items-start gap-3 rounded-lg px-2 py-1.5">
      <KindTile kind={artifact.kind} muted />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13.5px] leading-snug font-medium text-foreground/70">
          {artifact.title}
        </span>
        <span className="flex items-center gap-1.5 text-xs leading-snug text-muted-foreground">
          <Lock className="size-3 shrink-0" aria-hidden="true" />
          {messages.readOnly}
        </span>
        <span className="text-xs leading-snug text-muted-foreground/80">
          {messages.readOnlyHint}
        </span>
      </span>
    </div>
  )
}

/** An artifact's kind as a row leads with it. */
function KindTile({
  kind,
  muted = false,
}: {
  readonly kind: ArtifactSummary["kind"]
  readonly muted?: boolean
}) {
  return (
    <span
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg bg-card shadow-[0_1px_1px_rgb(0_0_0/0.04)] ring-1 ring-border/80 ring-inset",
        muted ? "text-muted-foreground" : "text-foreground/75"
      )}
    >
      <ArtifactKindIcon kind={kind} className="size-[15px]" />
    </span>
  )
}

function RowSkeletons({ count }: { readonly count: number }) {
  return (
    <div aria-hidden="true" className="flex flex-col">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex items-center gap-3 px-2 py-1.5">
          <span className="size-8 shrink-0 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="h-3 w-1/2 rounded bg-muted" />
            <span className="h-2.5 w-1/3 rounded bg-muted/70" />
          </span>
        </div>
      ))}
    </div>
  )
}

/** A line in the list's place: nothing to show, nothing found, or a failure to try again. */
function Notice({
  icon: Icon,
  title,
  description,
  action,
}: {
  readonly icon: typeof Layers
  readonly title: string
  readonly description?: string
  readonly action?: { readonly label: string; readonly onClick: () => void }
}) {
  return (
    <div role="status" className="flex flex-col items-center gap-2 px-4 py-7 text-center">
      <span className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <p className="text-[13.5px] font-medium text-foreground">{title}</p>
      {description ? (
        <p className="max-w-[30ch] text-xs text-muted-foreground">{description}</p>
      ) : null}
      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-1 rounded-full border border-border px-3 py-1 text-xs font-medium text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  )
}
