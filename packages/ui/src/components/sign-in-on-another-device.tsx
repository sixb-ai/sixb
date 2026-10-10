import { CircleCheck } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Button } from "./ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog"
import { QrCode } from "./ui/qr-code"
import { Spinner } from "./ui/spinner"

/** A code that signs another device in as the current user, from `createSignInCode`. */
export interface SignInCode {
  readonly id: string
  /** The link the QR code carries. */
  readonly url: string
  readonly expiresAt: string
}

export type SignInCodeStatus = "pending" | "used" | "expired"

export interface SignInOnAnotherDeviceDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  /** Create a code, such as with `createSignInCode` from `@sixb/client`. */
  readonly createCode: () => Promise<SignInCode>
  /** Look up a code, such as with `getSignInCode` from `@sixb/client`. */
  readonly getCodeStatus: (codeId: string) => Promise<SignInCodeStatus>
}

type DialogState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly code: SignInCode }
  | { readonly kind: "signed-in" }
  | { readonly kind: "failed"; readonly message: string }

const STATUS_POLL_MS = 2000

/**
 * Shows a QR code that signs another device in as the current user. A code works once and only for a
 * couple of minutes, so the dialog replaces it as it runs out, and says when a device has used it.
 */
export function SignInOnAnotherDeviceDialog({
  open,
  onOpenChange,
  createCode,
  getCodeStatus,
}: SignInOnAnotherDeviceDialogProps) {
  const [state, setState] = useState<DialogState>({ kind: "loading" })
  // Bumped to replace a code that ran out.
  const [round, setRound] = useState(0)
  // Callers pass fresh functions each render; only opening and renewal should create a code.
  const createRef = useRef(createCode)
  const statusRef = useRef(getCodeStatus)
  useEffect(() => {
    createRef.current = createCode
    statusRef.current = getCodeStatus
  }, [createCode, getCodeStatus])

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new round is what asks for a new code.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setState({ kind: "loading" })
    createRef.current().then(
      (code) => {
        if (!cancelled) setState({ kind: "ready", code })
      },
      (error: unknown) => {
        if (!cancelled) setState({ kind: "failed", message: describeError(error) })
      }
    )
    return () => {
      cancelled = true
    }
  }, [open, round])

  useEffect(() => {
    if (state.kind !== "ready") return
    const { code } = state
    let cancelled = false
    const renew = () => {
      if (!cancelled) setRound((count) => count + 1)
    }
    const expiry = setTimeout(renew, Math.max(0, Date.parse(code.expiresAt) - Date.now()))
    const poll = setInterval(() => {
      statusRef.current(code.id).then(
        (status) => {
          if (cancelled) return
          if (status === "used") setState({ kind: "signed-in" })
          else if (status === "expired") renew()
        },
        // A missed check is retried by the next one.
        () => undefined
      )
    }, STATUS_POLL_MS)
    return () => {
      cancelled = true
      clearTimeout(expiry)
      clearInterval(poll)
    }
  }, [state])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Sign in on another device</DialogTitle>
          <DialogDescription>
            Scan this code with the device you want to sign in. It works once, and a new one appears
            every two minutes.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-64 items-center justify-center">
          {state.kind === "loading" ? <Spinner className="size-6 text-muted-foreground" /> : null}
          {state.kind === "ready" ? (
            <QrCode
              value={state.code.url}
              label="QR code to sign in on another device"
              className="size-64 rounded-lg"
            />
          ) : null}
          {state.kind === "signed-in" ? (
            <div className="flex flex-col items-center gap-3 text-center" aria-live="polite">
              <CircleCheck className="size-10 text-primary" aria-hidden />
              <p className="text-sm">
                Signed in. The device is listed with your sessions, where you can sign it out.
              </p>
            </div>
          ) : null}
          {state.kind === "failed" ? (
            <div className="flex flex-col items-center gap-3 text-center" aria-live="polite">
              <p className="text-sm text-destructive">{state.message}</p>
              <Button variant="outline" size="sm" onClick={() => setRound((count) => count + 1)}>
                Try again
              </Button>
            </div>
          ) : null}
        </div>

        {state.kind === "signed-in" ? (
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : ""
  return message.replace(/^\[Sixb\w*\]\s*/, "") || "Couldn't create a sign-in code."
}
