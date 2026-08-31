import type { AuthExperienceProps } from "@sixb/app/auth"
import { type FormEvent, useState } from "react"

export default function AuthExperience({ state, actions }: AuthExperienceProps) {
  const [email, setEmail] = useState("")
  const [pending, setPending] = useState(false)

  function requestLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    actions.requestMagicLink(email)
  }

  function confirmSignIn() {
    if (pending) return
    setPending(true)
    actions.confirmSignIn()
  }

  return (
    <main className="auth-login-shell">
      <section className="auth-login-story" aria-label="Acme Operations">
        <p className="auth-login-mark">A</p>
        <div>
          <p className="auth-login-eyebrow">Acme Operations</p>
          <h1>Clear access to the work that matters.</h1>
          <p>
            One secure link connects your team to live operations, approvals, and shared context.
          </p>
        </div>
      </section>

      <section className="auth-login-panel">
        <div className="auth-login-card">
          {state.kind === "signIn" ? (
            <>
              <p className="auth-login-step">Welcome back</p>
              <h2>Sign in to Acme</h2>
              <p className="auth-login-copy">Use your work email. No password required.</p>
              <form onSubmit={requestLink}>
                <label htmlFor="auth-email">Work email</label>
                <input
                  id="auth-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                  placeholder="you@acme.com"
                  required
                  autoFocus
                />
                <button type="submit" disabled={pending}>
                  {pending ? "Sending…" : "Email me a sign-in link"}
                </button>
              </form>
            </>
          ) : state.kind === "checkEmail" ? (
            <>
              <p className="auth-login-icon" aria-hidden="true">
                ✦
              </p>
              <p className="auth-login-step">Almost there</p>
              <h2>Check your inbox</h2>
              <p className="auth-login-copy">
                If your email can sign in, a secure link is on its way. It expires soon and works
                once.
              </p>
              <button
                type="button"
                className="auth-login-secondary"
                onClick={actions.restartSignIn}
              >
                Use a different email
              </button>
            </>
          ) : state.kind === "confirm" ? (
            <>
              <p className="auth-login-step">Secure sign-in</p>
              <h2>Continue to Acme</h2>
              <p className="auth-login-copy">
                {state.email
                  ? `Confirm sign-in as ${state.email}.`
                  : "Confirm this sign-in request."}
              </p>
              <button type="button" onClick={confirmSignIn} disabled={pending}>
                {pending ? "Signing in…" : "Continue"}
              </button>
            </>
          ) : (
            <>
              <p className="auth-login-step">Start again</p>
              <h2>
                {state.kind === "invalidLink" ? "This link has expired" : "Sign-in unavailable"}
              </h2>
              <p className="auth-login-copy">
                Request a fresh link to continue. If the problem persists, contact your Acme
                administrator.
              </p>
              <button type="button" onClick={actions.restartSignIn}>
                Request a new link
              </button>
            </>
          )}
        </div>
        <p className="auth-login-footnote">Protected by Sixb passwordless authentication</p>
      </section>
    </main>
  )
}
