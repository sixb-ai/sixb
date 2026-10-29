import { cn } from "@sixb/ui/lib/utils"
import { AtSign, type LucideIcon, Paperclip, Plus, Slash } from "lucide-react"
import { useRef, useState } from "react"
import { useAgentMessages } from "../i18n"
import { COMPOSER_MENU_ROW_CLASS_NAME, ComposerMenu } from "./composer-menu"

export interface ComposerAddMenuProps {
  readonly onAddFiles?: () => void
  /** Starts an `@` mention at the caret, which opens the context picker. */
  readonly onMention: () => void
  /** Starts a slash command; omitted while the message has text. */
  readonly onCommand?: () => void
  readonly disabled?: boolean
}

/** The composer's `+`: what a message can carry besides its text. It turns into × while open. */
export function ComposerAddMenu({
  onAddFiles,
  onMention,
  onCommand,
  disabled,
}: ComposerAddMenuProps) {
  const messages = useAgentMessages().composer
  const [open, setOpen] = useState(false)
  // A choice that types into the message keeps the focus there, not on `+`.
  const typing = useRef(false)

  const choose = (action: () => void, types: boolean) => () => {
    typing.current = types
    setOpen(false)
    action()
  }

  return (
    <ComposerMenu
      open={open}
      onOpenChange={setOpen}
      title={messages.add}
      align="start"
      className="w-[16.5rem]"
      onCloseAutoFocus={(event) => {
        if (!typing.current) return
        typing.current = false
        event.preventDefault()
      }}
      trigger={
        <button
          type="button"
          disabled={disabled}
          aria-label={messages.add}
          aria-haspopup="menu"
          aria-expanded={open}
          className="flex size-[38px] shrink-0 items-center justify-center self-end rounded-full bg-black/[0.05] text-foreground/80 outline-none transition-[background-color,transform] duration-200 ease-[cubic-bezier(.2,.8,.2,1)] hover:bg-black/[0.08] focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 aria-expanded:rotate-45 aria-expanded:bg-black/[0.08] dark:bg-white/[0.1] dark:hover:bg-white/[0.14] dark:aria-expanded:bg-white/[0.14] mb-px"
        >
          <Plus className="size-[18px]" strokeWidth={2} aria-hidden="true" />
        </button>
      }
    >
      <div role="menu" aria-label={messages.add} className="flex flex-col gap-px">
        {onAddFiles ? (
          <AddMenuItem
            icon={Paperclip}
            label={messages.addFiles}
            onSelect={choose(onAddFiles, false)}
          />
        ) : null}
        <AddMenuItem
          icon={AtSign}
          label={messages.mention}
          shortcut="@"
          onSelect={choose(onMention, true)}
        />
        {onCommand ? (
          <AddMenuItem
            icon={Slash}
            label={messages.commands}
            shortcut="/"
            onSelect={choose(onCommand, true)}
          />
        ) : null}
      </div>
    </ComposerMenu>
  )
}

function AddMenuItem({
  icon: Icon,
  label,
  shortcut,
  onSelect,
}: {
  readonly icon: LucideIcon
  readonly label: string
  /** The character that does the same from the message. */
  readonly shortcut?: string
  readonly onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={cn(COMPOSER_MENU_ROW_CLASS_NAME, "min-h-10 gap-3")}
    >
      <Icon
        className="size-[18px] shrink-0 text-foreground/75"
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate text-foreground">{label}</span>
      {shortcut ? <ComposerKey>{shortcut}</ComposerKey> : null}
    </button>
  )
}

/** A keycap, for the character or key that does the same from the keyboard. */
export function ComposerKey({ children }: { readonly children: string }) {
  return (
    <kbd
      aria-hidden="true"
      className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md bg-background px-[5px] font-sans text-[11px] text-foreground/75 shadow-[0_0_0_0.5px_rgb(0_0_0/0.16),0_1px_0_rgb(0_0_0/0.08)] dark:bg-white/[0.1] dark:shadow-[0_0_0_0.5px_rgb(255_255_255/0.16)]"
    >
      {children}
    </kbd>
  )
}
