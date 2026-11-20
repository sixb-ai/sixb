import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
} from "@sixb/ui/components"
import { useAgentMessages } from "../i18n"

export interface SandboxRecoveryProps {
  readonly pending: boolean
  readonly error: boolean
  readonly onRecreate: () => void
  /** Going on in the previous sandbox, offered when its last run finished preparing it. */
  readonly restore?: {
    readonly pending: boolean
    readonly error: boolean
    readonly onRestore: () => void
  }
  /**
   * The newest run finished its answer, and only its files were not saved: the block says so
   * instead of an interruption.
   */
  readonly answered?: boolean
  /** Only the thread's owner recreates its sandbox; anyone else is told who can. */
  readonly canRecreate: boolean
  /** The thread's owner, by name. */
  readonly owner: string
}

/**
 * Offers to go on in the thread's sandbox, as its failed save left it, or to start fresh when it
 * stops responding; the composer waits for either. An answer that finished before its save failed
 * stands: the block then only asks what to do with the files.
 */
export function SandboxRecovery({
  pending,
  error,
  onRecreate,
  restore,
  answered = false,
  canRecreate,
  owner,
}: SandboxRecoveryProps) {
  const messages = useAgentMessages().sandbox
  const title = answered ? messages.answeredTitle : messages.title

  if (!canRecreate) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-3 text-sm" role="status">
        <p className="font-medium">{title}</p>
        <p className="text-muted-foreground">{messages.ownerOnly(owner)}</p>
      </div>
    )
  }

  const resumeLabel = answered
    ? restore?.pending
      ? messages.keepingFiles
      : messages.keepFiles
    : restore?.pending
      ? messages.resuming
      : messages.resume

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-3 text-sm" role="status">
      <p className="font-medium">{title}</p>
      <p className="text-muted-foreground">
        {answered ? messages.answeredDescription : messages.description}
      </p>
      {restore && !answered && <p className="text-muted-foreground">{messages.resumeHint}</p>}
      {restore?.error && <p role="alert">{messages.resumeFailed}</p>}
      {error && <p role="alert">{messages.recreateFailed}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {restore && (
          <Button size="sm" disabled={pending} onClick={restore.onRestore}>
            {resumeLabel}
          </Button>
        )}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" size="sm" disabled={pending}>
              {pending && !restore?.pending ? messages.recreating : messages.startFresh}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{messages.confirmTitle}</AlertDialogTitle>
              <AlertDialogDescription>{messages.confirmDescription}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{messages.cancel}</AlertDialogCancel>
              <AlertDialogAction onClick={onRecreate}>{messages.create}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  )
}
