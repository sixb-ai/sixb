import { cn } from "@sixb/ui/lib/utils"
import { ArrowUp, LoaderCircle, X } from "lucide-react"
import { type CSSProperties, type KeyboardEvent, type ReactNode, useId, useState } from "react"
import { useGiveGuestName, useSharedGuest } from "../../shared-session"
import { GuestBadge } from "../guest-badge"
import { useArtifactMessages } from "../messages"
import { PersonAvatar } from "../person-avatar"
import { CommentActionError, type CommentFailure } from "./comments"

// What every artifact's comments are drawn with: a pin, numbered as the panel lists them, the box a
// comment or a reply is written in, and the card a new comment is written in beside its pin.

/** The widest a new comment's card is. */
const CARD_WIDTH = 288

/**
 * Where a new comment's card sits from its pin, `x` along a view `width` wide: beside the pin,
 * else as far left as it must to stay in view, and narrower in a view narrower than it.
 */
export function cardPlace(x: number, width: number): { left: number; width: number } {
  const card = Math.min(CARD_WIDTH, width - 16)
  const beside = 36
  const left = Math.max(8 - x, Math.min(beside, width - 8 - card - x))
  return { left, width: card }
}

/** A pin: a bubble with its number, pointing at its place from its bottom left. */
export function CommentPin({
  number,
  label,
  active,
  resolved,
  draft = false,
  onClick,
  style,
}: {
  readonly number?: number
  readonly label: string
  readonly active: boolean
  readonly resolved: boolean
  readonly draft?: boolean
  readonly onClick?: () => void
  readonly style?: CSSProperties
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={onClick ? active : undefined}
      data-comment-pin={number ?? "draft"}
      onClick={(event) => {
        event.stopPropagation()
        onClick?.()
      }}
      // React Flow leaves a press on it to the pin: no pan, no drag, no selection.
      className={cn(
        "nodrag nopan nowheel pointer-events-auto absolute flex h-7 min-w-7 origin-bottom-left -translate-y-full items-center justify-center rounded-full rounded-bl-[4px] px-1.5 text-[12px] font-semibold tabular-nums shadow-[0_1px_2px_rgb(0_0_0/0.12),0_6px_16px_-6px_rgb(0_0_0/0.35)] outline-none ring-2 ring-background transition-[transform,background-color] duration-150 focus-visible:ring-ring motion-safe:hover:scale-110",
        draft || active
          ? "bg-primary text-primary-foreground"
          : resolved
            ? "bg-muted text-muted-foreground"
            : "bg-foreground text-background",
        draft && "motion-safe:animate-in motion-safe:zoom-in-50 motion-safe:fade-in-0"
      )}
      style={style}
    >
      {draft ? <span className="size-1.5 rounded-full bg-current" aria-hidden="true" /> : number}
    </button>
  )
}

/**
 * Where a comment is written: its words, posted with ↩ or the arrow, a new line with ⇧↩, given
 * up with Esc. A failure says why, and keeps the words. A shared link's guest who gave no name yet
 * gives it here, once, above their first comment: their session keeps it for the next ones.
 */
export function CommentComposer({
  placeholder,
  onSubmit,
  onCancel,
  autoFocus = true,
  compact = false,
  notice,
  className,
}: {
  readonly placeholder: string
  readonly onSubmit: (body: string) => Promise<void>
  readonly onCancel?: () => void
  readonly autoFocus?: boolean
  /** A reply's: one line until it grows. */
  readonly compact?: boolean
  /** Under the words, before they are posted: who else will read them. */
  readonly notice?: ReactNode
  readonly className?: string
}) {
  const messages = useArtifactMessages().comments
  const guest = useSharedGuest()
  const giveName = useGiveGuestName()
  const [body, setBody] = useState("")
  const [name, setName] = useState("")
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<CommentFailure | null>(null)

  // Asked once: the name stays with the session, whichever composer it was given in.
  const naming = guest !== null && guest.name === undefined
  const ready = body.trim().length > 0 && (!naming || name.trim().length > 0) && !sending

  const submit = async () => {
    if (!ready) return
    setSending(true)
    setFailure(null)
    try {
      if (naming) {
        await giveName(name).catch(() => {
          throw new CommentActionError("name")
        })
      }
      await onSubmit(body.trim())
      setBody("")
    } catch (error) {
      setFailure(error instanceof CommentActionError ? error.failure : "failed")
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    // The canvas's keys stay out of the words.
    event.stopPropagation()
    // Not the Enter that ends a word typed through an input method: Safari sends it as 229.
    const composing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
    if (event.key === "Enter" && !event.shiftKey && !composing) {
      event.preventDefault()
      void submit()
    }
    if (event.key === "Escape") {
      event.preventDefault()
      onCancel?.()
    }
  }

  return (
    <div className={cn("flex flex-col gap-1.5", className)} data-board-tools="">
      {naming ? (
        <GuestNameField
          value={name}
          onChange={setName}
          autoFocus={autoFocus}
          invalid={failure === "name"}
          onKeyDown={onKeyDown}
        />
      ) : null}
      <div className="flex items-end gap-1.5 rounded-xl border border-border bg-background px-2.5 py-1.5 focus-within:ring-2 focus-within:ring-ring/40">
        <textarea
          autoFocus={autoFocus && !naming}
          value={body}
          rows={1}
          maxLength={4000}
          aria-label={placeholder}
          placeholder={placeholder}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={onKeyDown}
          // One line that grows with the words, as a message's does.
          className="max-h-40 min-h-6 flex-1 resize-none bg-transparent py-0.5 text-sm leading-5 outline-none [field-sizing:content] placeholder:text-muted-foreground"
        />
        <button
          type="button"
          aria-label={compact ? messages.reply : messages.post}
          title={compact ? messages.reply : messages.post}
          disabled={!ready}
          onClick={() => void submit()}
          className="mb-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground text-background outline-none transition-colors hover:bg-foreground/85 focus-visible:ring-2 focus-visible:ring-ring disabled:bg-foreground/20 [&_svg]:size-3.5"
        >
          {sending ? (
            <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          ) : (
            <ArrowUp aria-hidden="true" />
          )}
        </button>
      </div>
      {failure ? (
        <p role="alert" className="m-0 px-1 text-xs text-destructive">
          {messages.failures[failure]}
        </p>
      ) : notice ? (
        <div className="px-1">{notice}</div>
      ) : null}
    </div>
  )
}

/**
 * Who a guest comments as, asked before their first comment: their name, which everyone reads
 * beside their comments with a guest's badge.
 */
function GuestNameField({
  value,
  onChange,
  autoFocus,
  invalid,
  onKeyDown,
}: {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly autoFocus: boolean
  readonly invalid: boolean
  readonly onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
}) {
  const messages = useArtifactMessages().comments
  const id = useId()

  return (
    <div className="flex flex-col gap-1 px-1 pt-0.5">
      <div className="flex items-center gap-2">
        <PersonAvatar name={value.trim() || messages.guest} size="xs" />
        <input
          id={id}
          autoFocus={autoFocus}
          value={value}
          maxLength={GUEST_NAME_INPUT_LENGTH}
          autoComplete="name"
          aria-label={messages.guestName}
          aria-invalid={invalid}
          aria-describedby={`${id}-hint`}
          placeholder={messages.guestName}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          className="h-7 min-w-0 flex-1 bg-transparent text-sm font-medium text-foreground outline-none placeholder:font-normal placeholder:text-muted-foreground"
        />
        <GuestBadge />
      </div>
      <p id={`${id}-hint`} className="m-0 pl-7 text-[11px] leading-4 text-muted-foreground">
        {messages.guestNameHint}
      </p>
    </div>
  )
}

/** A name a little past what the server keeps, so it says why rather than cutting it short. */
const GUEST_NAME_INPUT_LENGTH = 80

/** The card a new comment is written in, by its pin: what it is about, then its words. */
export function DraftCard({
  anchor,
  onSubmit,
  onCancel,
}: {
  readonly anchor?: string
  readonly onSubmit: (body: string) => Promise<void>
  readonly onCancel: () => void
}) {
  const messages = useArtifactMessages().comments
  return (
    <div
      role="dialog"
      aria-label={messages.newPin}
      className="nodrag nopan nowheel pointer-events-auto w-full min-w-56 rounded-2xl border border-border bg-popover p-1.5 text-popover-foreground shadow-[0_2px_4px_rgb(0_0_0/0.06),0_18px_40px_-16px_rgb(0_0_0/0.35)] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:slide-in-from-top-1"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex h-7 items-center gap-1 pr-0.5 pl-2">
        <p className="m-0 min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {anchor ? messages.about(anchor) : messages.newPin}
        </p>
        <button
          type="button"
          aria-label={messages.cancel}
          title={messages.cancel}
          onClick={onCancel}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5"
        >
          <X aria-hidden="true" />
        </button>
      </div>
      <CommentComposer placeholder={messages.placeholder} onSubmit={onSubmit} onCancel={onCancel} />
    </div>
  )
}
