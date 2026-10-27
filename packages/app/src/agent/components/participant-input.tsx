import { cn } from "@sixb/ui/lib/utils"
import { X } from "lucide-react"
import { type KeyboardEvent, type Ref, useId, useState } from "react"
import { useAgentMessages } from "../i18n"

/** Someone the owner picked to add: a member of the directory, or whoever an email names. */
export type ParticipantChoice =
  | { readonly kind: "user"; readonly id: string; readonly displayName?: string }
  | { readonly kind: "email"; readonly email: string }

export interface ParticipantInputProps {
  /** Who is picked so far, shown as chips inside the field. */
  readonly staged: readonly ParticipantChoice[]
  readonly onAdd: (choice: ParticipantChoice) => void
  readonly onRemove: (choice: ParticipantChoice) => void
  readonly disabled?: boolean
  /** Where focus goes back once someone is added or removed. */
  readonly inputRef?: Ref<HTMLInputElement>
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const SEPARATORS = /[\s,;]+/

/**
 * How the owner names people to add, like an invite field: Enter, a comma or leaving the field
 * turns each valid email into a chip, a malformed one stays to be fixed, and Backspace in an empty
 * field takes the last chip back. Today an email, which the server resolves to an active member;
 * a member directory can take this place and emit `{ kind: "user" }` instead.
 */
export function ParticipantInput({
  staged,
  onAdd,
  onRemove,
  disabled = false,
  inputRef,
}: ParticipantInputProps) {
  const messages = useAgentMessages().sharing
  const id = useId()
  const errorId = `${id}-error`
  const hintId = `${id}-hint`
  const [text, setText] = useState("")
  const [invalid, setInvalid] = useState(false)

  // Every valid email becomes a chip; whatever is not one stays in the field, flagged.
  const commit = () => {
    const entries = text.split(SEPARATORS).filter(Boolean)
    if (entries.length === 0) return

    const rejected = entries.filter((entry) => !EMAIL.test(entry))
    for (const email of entries.filter((entry) => EMAIL.test(entry))) {
      onAdd({ kind: "email", email })
    }

    setText(rejected.join(" "))
    setInvalid(rejected.length > 0)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault()
      commit()
      return
    }

    const last = staged.at(-1)
    if (event.key === "Backspace" && text === "" && last) onRemove(last)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="sr-only">
        {messages.email}
      </label>

      <div
        className={cn(
          "flex min-h-10 flex-wrap items-center gap-1.5 rounded-xl bg-muted/60 px-2 py-1.5 transition-colors",
          "focus-within:bg-muted",
          invalid && "ring-1 ring-destructive",
          disabled && "opacity-60"
        )}
      >
        {staged.length > 0 ? (
          <ul aria-label={messages.staged} className="contents">
            {staged.map((choice) => (
              <StagedChip
                key={participantChoiceKey(choice)}
                label={participantChoiceLabel(choice)}
                disabled={disabled}
                onRemove={() => onRemove(choice)}
              />
            ))}
          </ul>
        ) : null}

        <input
          ref={inputRef}
          id={id}
          type="email"
          value={text}
          autoComplete="off"
          enterKeyHint="done"
          placeholder={
            staged.length > 0 ? messages.emailPlaceholder : messages.emailPlaceholderEmpty
          }
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : hintId}
          disabled={disabled}
          onChange={(event) => {
            setText(event.target.value)
            setInvalid(false)
          }}
          onKeyDown={onKeyDown}
          onBlur={commit}
          className="h-7 min-w-[10rem] flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>

      {invalid ? (
        <p id={errorId} role="alert" className="px-1 text-xs text-destructive">
          {messages.invalidEmail}
        </p>
      ) : (
        <p id={hintId} className="px-1 text-xs text-muted-foreground">
          {messages.addHint}
        </p>
      )}
    </div>
  )
}

function StagedChip({
  label,
  disabled,
  onRemove,
}: {
  readonly label: string
  readonly disabled: boolean
  readonly onRemove: () => void
}) {
  const messages = useAgentMessages().sharing

  return (
    <li className="flex h-7 max-w-full items-center gap-1 rounded-full bg-muted pr-1 pl-2.5 text-xs text-foreground">
      <span className="min-w-0 truncate">{label}</span>
      <button
        type="button"
        aria-label={messages.unstage(label)}
        onClick={onRemove}
        disabled={disabled}
        className="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
      >
        <X className="size-3" />
      </button>
    </li>
  )
}

export function participantChoiceKey(choice: ParticipantChoice): string {
  return choice.kind === "user" ? `user:${choice.id}` : `email:${choice.email.toLowerCase()}`
}

export function participantChoiceLabel(choice: ParticipantChoice): string {
  return choice.kind === "user" ? (choice.displayName ?? choice.id) : choice.email
}
