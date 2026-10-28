import { cn } from "@sixb/ui/lib/utils"
import { Mail, X } from "lucide-react"
import { type KeyboardEvent, type Ref, useId, useState } from "react"
import { PersonAvatar } from "../../artifacts/person-avatar"
import { type PersonSuggestion, usePeopleSuggestions } from "../hooks/use-people-suggestions"
import { useAgentMessages } from "../i18n"

/** Someone the owner picked to add: a member, or whoever an email names. */
export type ParticipantChoice =
  | { readonly kind: "user"; readonly id: string; readonly displayName?: string }
  | { readonly kind: "email"; readonly email: string }

export interface ParticipantInputProps {
  /** Who is picked so far, shown as chips inside the field. */
  readonly staged: readonly ParticipantChoice[]
  /** User ids the list never suggests: the reader and whoever is in the thread already. */
  readonly exclude: ReadonlySet<string>
  readonly onAdd: (choice: ParticipantChoice) => void
  readonly onRemove: (choice: ParticipantChoice) => void
  readonly disabled?: boolean
  /** Where focus goes back once someone is added or removed. */
  readonly inputRef?: Ref<HTMLInputElement>
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const SEPARATORS = /[\s,;]+/

/** A row of the list: a suggested person, or the email as typed. */
type Option =
  | { readonly kind: "person"; readonly person: PersonSuggestion }
  | { readonly kind: "email"; readonly email: string }

/**
 * Who to add, as in a mail client: typing lists the people it matches, by name, or by email too
 * where the reader may read the member directory, and a full email can be added as typed. Up and
 * down choose, Enter adds, Backspace in an empty field takes the last chip back.
 */
export function ParticipantInput({
  staged,
  exclude,
  onAdd,
  onRemove,
  disabled = false,
  inputRef,
}: ParticipantInputProps) {
  const messages = useAgentMessages().sharing
  const id = useId()
  const listId = `${id}-list`
  const errorId = `${id}-error`
  const [text, setText] = useState("")
  const [focused, setFocused] = useState(false)
  const [invalid, setInvalid] = useState(false)
  // Nothing is chosen until the reader types or moves: a stray Enter adds no one.
  const [active, setActive] = useState<number | null>(null)

  const stagedIds = staged.flatMap((choice) => (choice.kind === "user" ? [choice.id] : []))
  const { suggestions, canSearch } = usePeopleSuggestions({
    text,
    exclude: new Set([...exclude, ...stagedIds]),
  })
  const typed = text.trim()
  const options: Option[] = [
    ...suggestions.map((person) => ({ kind: "person" as const, person })),
    ...(EMAIL.test(typed) &&
    !suggestions.some((person) => person.email?.toLowerCase() === typed.toLowerCase())
      ? [{ kind: "email" as const, email: typed }]
      : []),
  ]
  const open = focused && !disabled && options.length > 0
  const current = open && active !== null ? Math.min(active, options.length - 1) : -1

  const choose = (option: Option) => {
    onAdd(
      option.kind === "person"
        ? { kind: "user", id: option.person.id, displayName: option.person.name }
        : { kind: "email", email: option.email }
    )
    setText("")
    setInvalid(false)
    setActive(null)
  }

  // Pasted or typed emails become chips; whatever is not one stays in the field, flagged.
  const commitEmails = () => {
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
    if (open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault()
      const step = event.key === "ArrowDown" ? 1 : -1
      setActive(
        current < 0
          ? step > 0
            ? 0
            : options.length - 1
          : (current + step + options.length) % options.length
      )
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      const option = options[current]
      if (option) choose(option)
      else commitEmails()
      return
    }
    if (event.key === ",") {
      event.preventDefault()
      commitEmails()
      return
    }
    // Escape closes the list first, and the dialog only after.
    if (event.key === "Escape" && open) {
      event.stopPropagation()
      setFocused(false)
      return
    }

    const last = staged.at(-1)
    if (event.key === "Backspace" && text === "" && last) onRemove(last)
  }

  return (
    <div className="flex flex-col">
      <label htmlFor={id} className="sr-only">
        {messages.addLabel}
      </label>

      <div
        className={cn(
          "flex min-h-11 flex-wrap items-center gap-1.5 rounded-xl bg-muted/60 px-2 py-1.5 transition-colors",
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
          type="text"
          inputMode="email"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={current >= 0 ? `${listId}-${current}` : undefined}
          value={text}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="done"
          placeholder={
            staged.length > 0
              ? messages.addMore
              : canSearch
                ? messages.addPlaceholder
                : messages.addByEmail
          }
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          disabled={disabled}
          onChange={(event) => {
            setText(event.target.value)
            setInvalid(false)
            setActive(event.target.value.trim() ? 0 : null)
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false)
            if (EMAIL.test(typed) || typed.includes(",")) commitEmails()
          }}
          className="h-8 min-w-[10rem] flex-1 bg-transparent px-1.5 text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>

      {/* The list opens in the flow under the field, so the dialog grows to hold it. */}
      <ul
        id={listId}
        role="listbox"
        aria-label={messages.suggestions}
        className={cn("flex flex-col py-1", !open && "hidden")}
      >
        {open
          ? options.map((option, index) => (
              <li
                key={option.kind === "person" ? option.person.id : `email:${option.email}`}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === current}
                // Pressing keeps focus in the field, so the list stays open until the pick lands.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(option)}
                className={cn(
                  "flex min-h-12 cursor-default items-center gap-3 rounded-xl px-2 py-1.5 text-sm",
                  index === current && "bg-black/[0.045] dark:bg-white/[0.07]"
                )}
              >
                {option.kind === "person" ? (
                  <>
                    <PersonAvatar name={option.person.name} size="md" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-foreground">
                        {option.person.name}
                      </span>
                      {option.person.email ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {option.person.email}
                        </span>
                      ) : null}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted-foreground/15 text-foreground/70">
                      <Mail className="size-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 truncate text-foreground">
                      {messages.addEmail(option.email)}
                    </span>
                  </>
                )}
              </li>
            ))
          : null}
      </ul>

      {invalid ? (
        <p id={errorId} role="alert" className="px-1 pt-1.5 text-xs text-destructive">
          {canSearch ? messages.notFound : messages.invalidEmail}
        </p>
      ) : null}
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
    <li className="flex h-7 max-w-full items-center gap-1.5 rounded-full bg-background pr-1 pl-1 text-xs font-medium text-foreground shadow-[0_0_0_1px_rgb(0_0_0/0.06)] dark:shadow-[0_0_0_1px_rgb(255_255_255/0.1)]">
      <PersonAvatar name={label} size="xs" />
      <span className="min-w-0 truncate">{label}</span>
      <button
        type="button"
        aria-label={messages.unstage(label)}
        onClick={onRemove}
        disabled={disabled}
        className="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
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
