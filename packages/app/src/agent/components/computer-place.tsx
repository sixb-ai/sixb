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
  Badge,
  Button,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { Laptop } from "lucide-react"
import { useAgentMessages } from "../i18n"
import type { AgentThread } from "../types"

/** Where a conversation runs on its owner's computer, as its owner reads it. */
export type ThreadComputer = NonNullable<AgentThread["computer"]>

/** A folder as its owner reads it: their home folder as `~`. */
export function shownFolder(folder: string): string {
  return folder.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~")
}

/** The computer a conversation runs on, its folder there, and whether `sixb` is open in it. */
export function ComputerBadge({ computer }: { readonly computer: ThreadComputer }) {
  const messages = useAgentMessages().computer
  return (
    <Badge
      variant="outline"
      className="h-7 max-w-72 gap-1.5 px-2.5 font-normal text-muted-foreground"
      title={`${computer.name} · ${computer.folder}`}
    >
      <span
        aria-hidden
        className={cn(
          "size-2 shrink-0 rounded-full",
          computer.online ? "bg-emerald-500" : "border border-muted-foreground"
        )}
      />
      <span className="truncate text-foreground">{computer.name}</span>
      <span className="hidden truncate sm:inline">· {shownFolder(computer.folder)}</span>
      <span className="sr-only">{computer.online ? messages.online : messages.offline}</span>
    </Badge>
  )
}

export interface ComputerOfflineNoticeProps {
  /** Null for a conversation from before folders were kept, until it moves. */
  readonly computer: ThreadComputer | null
  readonly pending: boolean
  readonly error: boolean
  readonly onContinueInCloud: () => void
}

/**
 * Above the composer while the conversation's computer is offline: a message waits for it, or the
 * conversation moves to the cloud, for good.
 */
export function ComputerOfflineNotice({
  computer,
  pending,
  error,
  onContinueInCloud,
}: ComputerOfflineNoticeProps) {
  const messages = useAgentMessages().computer
  return (
    <div
      className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-1 text-xs text-muted-foreground"
      role="status"
    >
      <Laptop aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        {computer
          ? messages.offlineNotice(computer.name, shownFolder(computer.folder))
          : messages.noFolder}
      </span>
      {error ? (
        <span role="alert" className="text-destructive">
          {messages.moveFailed}
        </span>
      ) : null}
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            className="h-7 rounded-full"
          >
            {pending ? messages.moving : messages.continueInCloud}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{messages.confirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>{messages.confirmDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{messages.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={onContinueInCloud}>
              {messages.continueInCloud}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
