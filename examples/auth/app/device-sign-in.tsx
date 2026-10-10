import { createSignInCodeMutation, getSignInCodeOptions } from "@sixb/client/hooks"
import { QrCode } from "@sixb/ui/components/ui/qr-code"
import { useMutation, useQuery } from "@tanstack/react-query"

const STATUS_POLL_MS = 2000

/** Shows a QR code that signs another device in as the current user. */
export function DeviceSignIn() {
  const create = useMutation(createSignInCodeMutation())
  const code = create.data
  const check = useQuery({
    ...getSignInCodeOptions({ path: { codeId: code?.id ?? "" } }),
    enabled: code !== undefined,
    // Check until a device uses the code or it runs out.
    refetchInterval: (query) =>
      query.state.data?.status === "pending" || !query.state.data ? STATUS_POLL_MS : false,
  })
  const status = check.data?.status ?? "pending"

  return (
    <div className="auth-app-device">
      <p className="auth-app-label">Another device</p>
      {code && status === "pending" ? (
        <>
          <QrCode
            value={code.url}
            label="QR code to sign in on another device"
            className="auth-app-qr"
          />
          <p className="auth-app-muted">
            Scan it with the device you want to sign in. It works once, within two minutes.
          </p>
        </>
      ) : code && status === "used" ? (
        <p className="auth-app-muted">Signed in. The device is listed with your sessions.</p>
      ) : (
        <>
          {code ? <p className="auth-app-muted">That code expired.</p> : null}
          <button
            type="button"
            className="auth-app-button"
            disabled={create.isPending}
            onClick={() => create.mutate({})}
          >
            {code ? "Show a new code" : "Sign in on another device"}
          </button>
          {create.isError ? (
            <p className="auth-app-error">Couldn't create a sign-in code.</p>
          ) : null}
        </>
      )}
    </div>
  )
}
