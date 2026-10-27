import { Button } from "@sixb/ui/components"
import { History } from "lucide-react"
import { useAgentMessages } from "../i18n"

const NO_WAITING_THREADS: ReadonlySet<string> = new Set()

export interface ThreadsButtonProps {
  /** The thread open beside it, whose own cards say what waits in it. */
  readonly currentThreadId: string | null
  readonly runningThreadCount?: number
  /** The threads where a call waits for the reader: the button counts the others. */
  readonly waitingThreadIds?: ReadonlySet<string>
  readonly onOpen: () => void
}

/**
 * The way from a thread to all of them: a button in its header. It counts the other threads
 * waiting for the reader, in amber, or shows a dot while one is at work.
 */
export function ThreadsButton({
  currentThreadId,
  runningThreadCount = 0,
  waitingThreadIds = NO_WAITING_THREADS,
  onOpen,
}: ThreadsButtonProps) {
  const agentMessages = useAgentMessages()
  const messages = agentMessages.threads
  const waitingElsewhere = [...waitingThreadIds].filter(
    (threadId) => threadId !== currentThreadId
  ).length
  const waitingLabel =
    waitingElsewhere > 0 ? agentMessages.approvals.waitingThreads(waitingElsewhere) : null
  const label = [
    messages.open,
    runningThreadCount > 0 ? messages.running(runningThreadCount) : null,
    waitingLabel,
  ]
    .filter(Boolean)
    .join(". ")

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-lg"
      aria-label={label}
      title={waitingLabel ?? messages.open}
      onClick={onOpen}
      className="relative [&_svg]:size-5"
    >
      <History />
      {waitingElsewhere > 0 ? (
        // What waits on the reader outranks what is merely running.
        <span
          data-waiting-approval-count={waitingElsewhere}
          aria-hidden="true"
          className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] leading-none font-semibold text-white tabular-nums ring-2 ring-background"
        >
          {waitingElsewhere > 9 ? "9+" : waitingElsewhere}
        </span>
      ) : runningThreadCount > 0 ? (
        <span
          data-active-thread-count={runningThreadCount}
          aria-hidden="true"
          className="absolute top-1.5 right-1.5 size-2 rounded-full bg-sky-500 ring-2 ring-background motion-safe:animate-pulse"
        />
      ) : null}
    </Button>
  )
}
