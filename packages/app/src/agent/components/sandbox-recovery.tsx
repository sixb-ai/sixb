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

export function SandboxRecovery({
  pending,
  error,
  onRecreate,
  canRecreate,
  owner,
}: {
  readonly pending: boolean
  readonly error: boolean
  readonly onRecreate: () => void
  /** Only the thread's owner recreates its sandbox; anyone else is told who can. */
  readonly canRecreate: boolean
  /** The thread's owner, by name. */
  readonly owner: string
}) {
  const messages = useAgentMessages().sandbox

  if (!canRecreate) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-3 text-sm" role="status">
        <p className="font-medium">{messages.title}</p>
        <p className="text-muted-foreground">{messages.ownerOnly(owner)}</p>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-3 text-sm" role="status">
      <p className="font-medium">{messages.title}</p>
      <p className="text-muted-foreground">{messages.description}</p>
      {error && <p role="alert">{messages.recreateFailed}</p>}
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button className="mt-2" variant="outline" size="sm" disabled={pending}>
            {pending ? messages.recreating : messages.startFresh}
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
  )
}
