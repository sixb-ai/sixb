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
} satisfies AppMetadata

export const toolViews = [responsePolicyView]

export default function RootLayout({ children }: PropsWithChildren) {
  return (
    <AppShellProvider style={{ "--sidebar-width": "15.5rem" } as CSSProperties}>
      <NorthlineShell>{children}</NorthlineShell>
    </AppShellProvider>
  )
}
