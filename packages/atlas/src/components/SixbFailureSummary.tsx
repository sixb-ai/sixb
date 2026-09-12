import type { SixbFailure } from "@sixb/core"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { Check, Copy } from "lucide-react"
import { useEffect, useState } from "react"

type FailureView = Pick<SixbFailure, "code" | "message"> &
  Partial<Omit<SixbFailure, "code" | "message" | "details">> & { readonly details?: unknown }

export function SixbFailureSummary({
  failure,
  className,
  truncateMessage = false,
  showDetails = false,
}: {
  failure: FailureView
  className?: string
  truncateMessage?: boolean
  /** Enable on detail surfaces; keep summaries inside clickable run rows non-interactive. */
  showDetails?: boolean
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <p
        className={cn(
          "text-destructive",
          truncateMessage ? "truncate" : "whitespace-pre-wrap break-words"
        )}
        title={truncateMessage ? failure.message : undefined}
      >
        {failure.message}
      </p>
      <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{failure.code}</p>
      {showDetails ? (
        <FailureDetails
          key={`${failure.code}:${failure.at ?? failure.message}`}
          failure={failure}
        />
      ) : null}
    </div>
  )
}

function FailureDetails({ failure }: { failure: FailureView }) {
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(failure, null, 2))
      setCopied(true)
      setCopyFailed(false)
    } catch {
      setCopyFailed(true)
    }
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="link" size="sm" className="mt-1 h-auto px-0 py-1 text-xs">
          View error details
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Error details</DialogTitle>
          <DialogDescription className="break-all font-mono text-xs">
            {failure.code}
          </DialogDescription>
        </DialogHeader>
        <p className="whitespace-pre-wrap break-words text-sm leading-6 text-destructive">
          {failure.message}
        </p>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
          {failure.at ? (
            <>
              <dt className="text-muted-foreground">Occurred at</dt>
              <dd className="break-all font-mono">{failure.at}</dd>
            </>
          ) : null}
          {failure.httpStatus !== undefined ? (
            <>
              <dt className="text-muted-foreground">Upstream HTTP status</dt>
              <dd className="font-mono">{failure.httpStatus}</dd>
            </>
          ) : null}
          {failure.retryable !== undefined ? (
            <>
              <dt className="text-muted-foreground">Retry policy</dt>
              <dd>
                {failure.retryable
                  ? "Potentially retryable; execution safety rules still apply."
                  : "Not automatically retryable."}
              </dd>
            </>
          ) : null}
        </dl>
        {failure.details !== undefined ? (
          <section className="min-w-0 space-y-2">
            <h3 className="text-sm font-medium">Context</h3>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-3 font-mono text-xs leading-5">
              {JSON.stringify(failure.details, null, 2)}
            </pre>
          </section>
        ) : null}
        {failure.redacted ? (
          <p className="text-xs text-muted-foreground">Sensitive context was redacted.</p>
        ) : null}
        {failure.truncated ? (
          <p className="text-xs text-muted-foreground">
            Some error details were omitted because the size or depth limit was reached.
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" size="sm" onClick={copy}>
            {copied ? <Check /> : <Copy />}
            {copied ? "Copied" : "Copy diagnostic"}
          </Button>
          <span role="status" className="text-xs text-muted-foreground">
            {copyFailed
              ? "Could not copy. Select the diagnostic text to copy it manually."
              : copied
                ? "Diagnostic copied."
                : ""}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
