import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Checkbox,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@sixb/ui/components"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import {
  Check,
  CornerDownRight,
  MessageSquare,
  MoreHorizontal,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react"
import { type ComponentPropsWithoutRef, forwardRef, useEffect, useRef, useState } from "react"
import { useArtifactMessages } from "../../messages"
import { PersonAvatar } from "../../person-avatar"
import { CommentComposer } from "./comment-pins"
import {
  type ArtifactComment,
  CommentActionError,
  type CommentAuthor,
  type CommentThread,
} from "./comments"

// The canvas's comments, as threads: the open ones, or those resolved, each saying where it is,
// who wrote it and its replies, resolved, reopened, replied to or deleted in place. The reader
// picks some to send to the Agent, which puts them, quoted with where they are, in the message
// they are writing. Beside the canvas while it is wide, a sheet over its foot on a phone.

export type CommentFilter = "open" | "resolved"

/** What the panel shows of a thread's place: its board's title, and its element, or none left. */
export interface ThreadPlace {
  readonly board: string | null
  readonly element: string | null
  readonly gone: boolean
}

export function CommentsPanel({
  threads,
  loading,
  failed,
  filter,
  active,
  placeOf,
  nameOf,
  canManage,
  onFilter,
  onActivate,
  onReply,
  onResolve,
  onDelete,
  onSend,
  onClose,
}: {
  readonly threads: readonly CommentThread[]
  readonly loading: boolean
  readonly failed: boolean
  readonly filter: CommentFilter
  readonly active: string | null
  readonly placeOf: (thread: CommentThread) => ThreadPlace
  readonly nameOf: (comment: ArtifactComment) => CommentAuthor | null
  readonly canManage: (comment: ArtifactComment) => boolean
  readonly onFilter: (filter: CommentFilter) => void
  readonly onActivate: (id: string) => void
  readonly onReply: (thread: CommentThread, body: string) => Promise<void>
  readonly onResolve: (thread: CommentThread, resolved: boolean) => Promise<void>
  readonly onDelete: (thread: CommentThread) => Promise<void>
  /** Puts these threads in the message to the Agent; none where there is no conversation. */
  readonly onSend: ((threads: readonly CommentThread[]) => void) | null
  readonly onClose: () => void
}) {
  const messages = useArtifactMessages().canvas.comments
  const open = threads.filter((thread) => !thread.comment.resolvedAt)
  const resolved = threads.filter((thread) => thread.comment.resolvedAt)
  const shown = filter === "open" ? open : resolved
  const [choosing, setChoosing] = useState(false)
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set())
  const [sent, setSent] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  // What is chosen stays among the threads shown.
  useEffect(() => {
    setChosen((current) => {
      const ids = new Set(shown.map((thread) => thread.comment.id))
      const kept = [...current].filter((id) => ids.has(id))
      return kept.length === current.size ? current : new Set(kept)
    })
  }, [shown])
  useEffect(() => {
    if (!sent) return
    const timer = window.setTimeout(() => setSent(false), 4000)
    return () => window.clearTimeout(timer)
  }, [sent])

  const act = async (action: () => Promise<void>) => {
    setFailure(null)
    try {
      await action()
    } catch (error) {
      setFailure(messages.failures[error instanceof CommentActionError ? error.failure : "failed"])
    }
  }

  const send = () => {
    if (!onSend) return
    onSend(shown.filter((thread) => chosen.has(thread.comment.id)))
    setChoosing(false)
    setChosen(new Set())
    setSent(true)
  }

  return (
    <aside
      aria-label={messages.panel}
      data-comments-panel=""
      className={cn(
        // A sheet over the canvas's foot while it is narrow, a column beside it once it is wide.
        "absolute inset-x-0 bottom-0 z-30 flex max-h-[68%] flex-col rounded-t-2xl border-t border-border bg-background shadow-[0_-12px_32px_-18px_rgb(0_0_0/0.35)]",
        "motion-safe:animate-in motion-safe:slide-in-from-bottom-4 motion-safe:fade-in-0",
        "@3xl/canvas:relative @3xl/canvas:inset-auto @3xl/canvas:z-auto @3xl/canvas:h-full @3xl/canvas:max-h-none @3xl/canvas:w-[22rem] @3xl/canvas:shrink-0 @3xl/canvas:rounded-none @3xl/canvas:border-t-0 @3xl/canvas:border-l @3xl/canvas:shadow-none @3xl/canvas:slide-in-from-right-4 @3xl/canvas:slide-in-from-bottom-0"
      )}
    >
      <span
        aria-hidden="true"
        className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-border @3xl/canvas:hidden"
      />
      <header className="flex h-12 shrink-0 items-center gap-2 px-3">
        <h2 className="m-0 text-sm font-semibold">{messages.title}</h2>
        {open.length > 0 ? (
          <span className="rounded-full bg-muted px-1.5 text-xs font-medium text-muted-foreground tabular-nums">
            {open.length}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {onSend && filter === "open" && open.length > 0 && !choosing ? (
            <button
              type="button"
              onClick={() => setChoosing(true)}
              className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-primary outline-none transition-colors hover:bg-[color-mix(in_oklab,var(--primary)_10%,transparent)] focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5"
            >
              <Sparkles aria-hidden="true" />
              {messages.select}
            </button>
          ) : null}
          <IconButton label={messages.close} onClick={onClose}>
            <X />
          </IconButton>
        </div>
      </header>

      <div className="flex shrink-0 items-center gap-2 px-3 pb-2">
        <div
          role="tablist"
          aria-label={messages.filter}
          className="flex flex-1 items-center rounded-lg bg-muted/70 p-0.5"
        >
          {(["open", "resolved"] as const).map((each) => (
            <button
              key={each}
              type="button"
              role="tab"
              aria-selected={filter === each}
              onClick={() => {
                onFilter(each)
                setChoosing(false)
              }}
              className={cn(
                "flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                filter === each && "bg-background text-foreground shadow-sm"
              )}
            >
              {messages[each]}
              <span className="tabular-nums opacity-60">
                {(each === "open" ? open : resolved).length}
              </span>
            </button>
          ))}
        </div>
      </div>

      {choosing ? (
        <p className="m-0 shrink-0 px-4 pb-2 text-xs text-muted-foreground">
          {messages.chooseHint}
        </p>
      ) : null}
      {failure ? (
        <p role="alert" className="m-0 shrink-0 px-4 pb-2 text-xs text-destructive">
          {failure}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
        {failed ? (
          <Empty title={messages.loadFailed} />
        ) : loading ? (
          <div className="flex flex-col gap-2 p-1" aria-busy="true">
            {[0, 1].map((index) => (
              <div key={index} className="h-20 animate-pulse rounded-xl bg-muted/60" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          filter === "open" ? (
            <Empty title={messages.empty} hint={messages.emptyHint} />
          ) : (
            <Empty title={messages.emptyResolved} />
          )
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {shown.map((thread) => (
              <ThreadCard
                key={thread.comment.id}
                thread={thread}
                place={placeOf(thread)}
                active={active === thread.comment.id}
                choosing={choosing}
                chosen={chosen.has(thread.comment.id)}
                nameOf={nameOf}
                manages={canManage(thread.comment)}
                onChoose={(next) =>
                  setChosen((current) => {
                    const updated = new Set(current)
                    if (next) updated.add(thread.comment.id)
                    else updated.delete(thread.comment.id)
                    return updated
                  })
                }
                onActivate={() => onActivate(thread.comment.id)}
                onReply={(body) => onReply(thread, body)}
                onResolve={(next) => act(() => onResolve(thread, next))}
                onDelete={() => act(() => onDelete(thread))}
              />
            ))}
          </ul>
        )}
      </div>

      {choosing ? (
        <footer className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={() => {
              setChoosing(false)
              setChosen(new Set())
            }}
            className="h-8 rounded-lg px-3 text-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {messages.cancelSelect}
          </button>
          <button
            type="button"
            disabled={chosen.size === 0}
            onClick={send}
            className="ml-auto flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-40 [&_svg]:size-4"
          >
            <Sparkles aria-hidden="true" />
            {messages.send(chosen.size)}
          </button>
        </footer>
      ) : sent ? (
        <p
          role="status"
          className="m-0 flex shrink-0 items-center gap-2 border-t border-border px-4 py-2.5 text-xs text-muted-foreground"
        >
          <Check className="size-3.5 text-primary" aria-hidden="true" />
          {messages.sent}
        </p>
      ) : null}
    </aside>
  )
}

function ThreadCard({
  thread,
  place,
  active,
  choosing,
  chosen,
  nameOf,
  manages,
  onChoose,
  onActivate,
  onReply,
  onResolve,
  onDelete,
}: {
  readonly thread: CommentThread
  readonly place: ThreadPlace
  readonly active: boolean
  readonly choosing: boolean
  readonly chosen: boolean
  readonly nameOf: (comment: ArtifactComment) => CommentAuthor | null
  readonly manages: boolean
  readonly onChoose: (chosen: boolean) => void
  readonly onActivate: () => void
  readonly onReply: (body: string) => Promise<void>
  readonly onResolve: (resolved: boolean) => Promise<void>
  readonly onDelete: () => Promise<void>
}) {
  const messages = useArtifactMessages().canvas.comments
  const { comment, replies, number } = thread
  const resolved = Boolean(comment.resolvedAt)
  const [replying, setReplying] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const card = useRef<HTMLElement | null>(null)

  // The thread its pin opened comes into view.
  useEffect(() => {
    if (active) card.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [active])

  return (
    <li>
      <article
        ref={card}
        aria-label={messages.pin(number, nameOf(comment)?.name ?? messages.someone)}
        data-comment-thread={comment.id}
        data-active={active ? "" : undefined}
        className={cn(
          "group relative flex gap-2.5 rounded-xl px-2.5 py-2.5 transition-colors",
          active
            ? "bg-[color-mix(in_oklab,var(--primary)_7%,var(--background))] ring-1 ring-[color-mix(in_oklab,var(--primary)_30%,transparent)]"
            : "hover:bg-muted/50",
          resolved && "opacity-80"
        )}
      >
        {choosing ? (
          <Checkbox
            checked={chosen}
            onCheckedChange={(value) => onChoose(value === true)}
            aria-label={messages.selectLabel(number)}
            className="mt-0.5"
          />
        ) : (
          <span
            aria-hidden="true"
            className={cn(
              "mt-px flex h-5 min-w-5 items-center justify-center rounded-full rounded-bl-[3px] px-1 text-[10.5px] font-semibold tabular-nums",
              active
                ? "bg-primary text-primary-foreground"
                : resolved
                  ? "bg-muted text-muted-foreground"
                  : "bg-foreground text-background"
            )}
          >
            {number}
          </span>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-1">
            <button
              type="button"
              onClick={onActivate}
              className="min-w-0 flex-1 rounded-sm text-left text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Where place={place} />
            </button>
            {manages ? (
              <div className="-mt-1 -mr-1 flex shrink-0 items-center opacity-100 transition-opacity @3xl/canvas:opacity-0 @3xl/canvas:group-focus-within:opacity-100 @3xl/canvas:group-hover:opacity-100 @3xl/canvas:group-data-[active]:opacity-100">
                <IconButton
                  label={resolved ? messages.reopen : messages.resolve}
                  onClick={() => void onResolve(!resolved)}
                >
                  {resolved ? <RotateCcw /> : <Check />}
                </IconButton>
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <IconButton label={messages.more}>
                      <MoreHorizontal />
                    </IconButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
                      <Trash2 aria-hidden="true" />
                      {messages.delete}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ) : null}
          </div>

          <Message comment={comment} nameOf={nameOf} />
          {replies.map((reply) => (
            <div key={reply.id} className="mt-2.5 border-l-2 border-border/70 pl-2.5">
              <Message comment={reply} nameOf={nameOf} />
            </div>
          ))}

          {resolved ? null : replying || active ? (
            <CommentComposer
              compact
              autoFocus={replying}
              placeholder={messages.replyPlaceholder}
              onSubmit={async (body) => {
                await onReply(body)
                setReplying(false)
              }}
              onCancel={() => setReplying(false)}
              className="mt-2.5"
            />
          ) : (
            <button
              type="button"
              onClick={() => setReplying(true)}
              className="mt-1.5 flex items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3"
            >
              <CornerDownRight aria-hidden="true" />
              {replies.length > 0 ? messages.replies(replies.length) : messages.reply}
            </button>
          )}
        </div>
      </article>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{messages.deleteTitle}</AlertDialogTitle>
            <AlertDialogDescription>{messages.deleteDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{messages.cancel}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void onDelete()}>
              {messages.delete}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  )
}

/** Where a thread is: its board, and its element by its first words, or that it is gone. */
function Where({ place }: { readonly place: ThreadPlace }) {
  const messages = useArtifactMessages().canvas.comments
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5">
      <span className="truncate font-medium text-foreground/80">
        {place.board ?? messages.onCanvas}
      </span>
      {place.board ? (
        <>
          <span aria-hidden="true">·</span>
          <span className={cn("min-w-0 truncate", place.gone && "line-through decoration-1")}>
            {place.element ? `“${place.element}”` : messages.wholeBoard}
          </span>
        </>
      ) : null}
      {place.gone ? (
        <span className="rounded-sm bg-muted px-1 text-[10.5px] text-muted-foreground">
          {messages.elementGone}
        </span>
      ) : null}
    </span>
  )
}

function Message({
  comment,
  nameOf,
}: {
  readonly comment: ArtifactComment
  readonly nameOf: (comment: ArtifactComment) => CommentAuthor | null
}) {
  const messages = useArtifactMessages().canvas.comments
  const when = useWhen()
  const author = nameOf(comment)
  const name = author ? (author.you ? messages.you : author.name) : messages.someone
  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-1.5 text-xs">
        <PersonAvatar name={author?.name || name} size="xs" />
        <span className="truncate font-medium text-foreground">{name}</span>
        <time dateTime={comment.createdAt} className="shrink-0 text-muted-foreground">
          {when(comment.createdAt)}
        </time>
      </div>
      <p className="m-0 mt-1 text-sm leading-5 break-words whitespace-pre-wrap text-foreground">
        {comment.body}
      </p>
    </div>
  )
}

/** A moment, as the reader reads it: the time alone today, the date with it before. */
function useWhen(): (iso: string) => string {
  const locale = useLocale()
  return (iso) => {
    const date = new Date(iso)
    const today = date.toDateString() === new Date().toDateString()
    return date.toLocaleString(locale, {
      ...(today ? {} : { month: "short", day: "numeric" }),
      hour: "numeric",
      minute: "2-digit",
    })
  }
}

function Empty({ title, hint }: { readonly title: string; readonly hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <MessageSquare className="size-4" aria-hidden="true" />
      </span>
      <p className="m-0 text-sm font-medium text-foreground">{title}</p>
      {hint ? <p className="m-0 max-w-[24ch] text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

/** A quiet icon button; a menu's trigger takes it as its own. */
const IconButton = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<"button"> & { readonly label: string }
>(function IconButton({ label, children, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className="flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted [&_svg]:size-4"
      {...props}
    >
      {children}
    </button>
  )
})
