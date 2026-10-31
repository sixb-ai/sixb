import { isSixbApiError } from "@sixb/client"
import { deleteAgentMemoryMutation, saveAgentMemoryMutation } from "@sixb/client/hooks"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Input,
  Kbd,
  Textarea,
} from "@sixb/ui/components"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import { type FormEvent, type ReactNode, useState } from "react"
import { useNavigate } from "react-router-dom"
import { notify } from "../section-page"
import { apiErrorMessage, Field } from "../section-ui"
import { type MemoryRepo, type MemoryRepoView, memoryPageHref, refreshMemory } from "./memory-files"
import { useSettingsMessages } from "./messages"

// ---------------------------------------------------------------------------
// Saving: every change on the page is a save of whole files, like the agent's.
// ---------------------------------------------------------------------------

export interface MemoryChange {
  readonly path: string
  readonly contents: string | null
}

/**
 * Saves files of the repo from the revision on the page. A save another one beat is refused with a
 * conflict: the page reloads the memory and says so, and what was typed stays where it was.
 */
export function useMemorySave(repo: MemoryRepo, view: MemoryRepoView) {
  const messages = useSettingsMessages().memory
  const queryClient = useQueryClient()
  const mutation = useMutation({ ...saveAgentMemoryMutation() })
  const save = async (
    changes: readonly MemoryChange[],
    message: string,
    baseRevision = view.revision
  ): Promise<number | null> => {
    try {
      const saved = await mutation.mutateAsync({
        path: { repo },
        body: { baseRevision, message, changes: [...changes] },
      })
      await refreshMemory(queryClient, repo)
      return saved.revision
    } catch (error) {
      if (isSixbApiError(error) && error.status === 409) {
        notify.error(messages.conflict)
        await refreshMemory(queryClient, repo)
      } else {
        notify.error(apiErrorMessage(error, messages.saveFailed))
      }
      return null
    }
  }
  return { save, pending: mutation.isPending }
}

/** A save's message from what it says, kept short for the history. */
export function summary(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim()
  return oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine
}

/** The field a memory is written in: ⌘↵ or Enter saves it, Escape leaves it as it was. */
export function EntryEditor({
  initial,
  placeholder,
  submitLabel,
  pending,
  onSubmit,
  onCancel,
  hint,
}: {
  readonly initial: string
  readonly placeholder?: string
  readonly submitLabel: string
  readonly pending: boolean
  readonly onSubmit: (text: string) => void | Promise<void>
  readonly onCancel: () => void
  readonly hint?: string
}) {
  const messages = useSettingsMessages()
  const [text, setText] = useState(initial)
  const ready = text.trim() !== "" && text.trim() !== initial.trim()
  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    if (ready && !pending) await onSubmit(text.trim())
  }
  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-2">
      <Textarea
        value={text}
        autoFocus
        rows={2}
        placeholder={placeholder}
        aria-label={placeholder ?? submitLabel}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel()
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey || !event.shiftKey)) {
            event.preventDefault()
            void submit()
          }
        }}
        className="min-h-[4.5rem] resize-y bg-background text-base leading-[1.6] shadow-none"
      />
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={!ready || pending}>
          {pending ? <Loader2 className="animate-spin" /> : null}
          {submitLabel}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {messages.common.cancel}
        </Button>
        {hint ? (
          <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">{hint}</span>
        ) : null}
      </div>
    </form>
  )
}

/**
 * A whole file as text, for what the list of memories cannot change, such as its headings.
 *
 * The draft saves from the revision it was opened at. When the file changes meanwhile, the draft
 * stays as typed and saving waits until the person starts again from the latest version.
 */
export function TextEditor({
  name,
  contents,
  revision,
  pending,
  onSave,
  onCancel,
}: {
  readonly name: string
  readonly contents: string
  readonly revision: number
  readonly pending: boolean
  readonly onSave: (contents: string, note: string, baseRevision: number) => void | Promise<void>
  readonly onCancel: () => void
}) {
  const allMessages = useSettingsMessages()
  const messages = allMessages.memory
  const [base, setBase] = useState({ revision, contents })
  const [draft, setDraft] = useState(contents)
  const [note, setNote] = useState("")
  const changed = draft !== contents
  const stale = base.contents !== contents

  const submit = () => {
    if (changed && !stale && !pending) void onSave(draft, note.trim(), base.revision)
  }

  const startFromLatest = () => {
    setBase({ revision, contents })
    setDraft(contents)
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      {stale ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/40 py-1.5 pr-1.5 pl-3 text-[0.8125rem]"
        >
          <span className="mr-auto">{messages.changedSinceOpened(name)}</span>
          <Button type="button" variant="outline" size="sm" onClick={startFromLatest}>
            {messages.startFromLatest}
          </Button>
        </div>
      ) : null}

      <Textarea
        aria-label={messages.editing(name)}
        value={draft}
        autoFocus
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            submit()
          }
          // Escape leaves only an untouched draft, so a stray key loses nothing.
          if (event.key === "Escape" && !changed) onCancel()
        }}
        spellCheck={false}
        className="min-h-80 resize-y font-mono text-[0.8125rem] leading-6"
      />
      <Field label={messages.note} htmlFor="memory-note">
        <Input
          id="memory-note"
          value={note}
          placeholder={messages.notePlaceholder}
          onChange={(event) => setNote(event.target.value)}
          maxLength={200}
        />
      </Field>
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
          <Kbd>{isApplePlatform() ? "⌘" : "Ctrl"}</Kbd>
          <Kbd>↵</Kbd>
          {messages.saveHint}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {allMessages.common.cancel}
        </Button>
        <Button type="submit" size="sm" disabled={pending || !changed || stale}>
          {pending ? <Loader2 className="animate-spin" /> : null}
          {pending ? messages.saving : messages.save}
        </Button>
      </div>
    </form>
  )
}

/** Whether the reader's keyboard has ⌘, for the shortcut the editor names. */
function isApplePlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "")
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  action,
  onConfirm,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly title: string
  readonly description: ReactNode
  readonly action: string
  readonly onConfirm: () => void | Promise<void>
}) {
  const cancel = useSettingsMessages().common.cancel
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancel}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => void onConfirm()}>
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** Delete the repo with its history, after a confirmation. */
export function ForgetDialog({
  repo,
  open,
  onOpenChange,
}: {
  readonly repo: MemoryRepo
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  const messages = useSettingsMessages().memory
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const forget = useMutation({
    ...deleteAgentMemoryMutation(),
    onSuccess: async () => {
      notify.success(messages.forgottenAll)
      navigate(memoryPageHref({ repo }))
      await refreshMemory(queryClient, repo)
    },
    onError: (error) =>
      notify.error(
        isSixbApiError(error) && error.status === 403
          ? messages.forgetDenied
          : apiErrorMessage(error, messages.forgetFailed)
      ),
  })
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={messages.forgetConfirmTitle}
      description={repo === "user" ? messages.forgetConfirmYours : messages.forgetConfirmProject}
      action={messages.forgetConfirm}
      onConfirm={() => forget.mutate({ path: { repo } })}
    />
  )
}
