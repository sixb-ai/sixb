import { type AppMetadata, AppShellProvider } from "@sixb/app"
import type { CSSProperties, PropsWithChildren } from "react"
import { responsePolicyView } from "./_agent/response-policy-view"
import { NorthlineShell } from "./_components/northline-shell"

export const metadata = {
  title: "Northline Operations",
  description: "Connected service operations for Northline Mechanical.",
  favicon: "/favicon.svg",
  themeColor: "#fbfbfd",
  backgroundColor: "#fbfbfd",
  // The installed app draws under the status bar; the phone shell clears it.
  statusBar: "under",
} satisfies AppMetadata

export const toolViews = [responsePolicyView]

export default function RootLayout({ children }: PropsWithChildren) {
  return (
    <AppShellProvider style={{ "--sidebar-width": "220px" } as CSSProperties}>
      <NorthlineShell>{children}</NorthlineShell>
    </AppShellProvider>
  )
}
