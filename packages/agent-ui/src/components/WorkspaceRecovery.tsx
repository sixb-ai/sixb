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

export function WorkspaceRecovery({
  pending,
  error,
  onRecreate,
}: {
  readonly pending: boolean
  readonly error: boolean
  readonly onRecreate: () => void
}) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-3 text-sm" role="status">
      <p className="font-medium">Workspace recovery required</p>
      <p className="text-muted-foreground">
        Saved files are unavailable or the previous operation could not be confirmed. Automatic
        resume is blocked to protect your work.
      </p>
      {error && <p role="alert">Could not recreate the workspace. Reload and try again.</p>}
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button className="mt-2" variant="outline" size="sm" disabled={pending}>
            {pending ? "Recreating…" : "Start with a fresh workspace"}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start with a fresh workspace?</AlertDialogTitle>
            <AlertDialogDescription>
              The next run will initialize a new checkout. Uncommitted files from the previous
              workspace will not be copied. Conversation history and published attachments stay
              available. The previous sandbox is not deleted and remains subject to provider
              retention.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onRecreate}>Create fresh workspace</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
