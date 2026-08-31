import { getAuthSessionOptions } from "@sixb/client/hooks"
import { useQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { AccessErrorState, LoadingSpinner } from "./SettingsAccessControls"
import { SettingsTabs } from "./SettingsTabs"

export function SettingsAccessGate({ children }: { readonly children: ReactNode }) {
  const sessionQuery = useQuery({ ...getAuthSessionOptions(), retry: false })

  if (sessionQuery.isLoading) {
    return (
      <div className="flex min-h-90 items-center justify-center">
        <LoadingSpinner text="Checking your session…" />
      </div>
    )
  }

  if (sessionQuery.isError) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-4">
        <SettingsTabs />
        <AccessErrorState
          title="Settings unavailable"
          description="We could not verify your session. Try again shortly."
        />
      </div>
    )
  }

  if (sessionQuery.data?.authenticated !== true) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-4">
        <SettingsTabs />
        <AccessErrorState
          title="Sign in to manage project access"
          description="Members, service accounts, tokens, and sessions are available after you sign in."
        />
      </div>
    )
  }

  return children
}
