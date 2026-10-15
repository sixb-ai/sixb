import { type AppMetadata, AppShellProvider } from "@sixb/app"
import type { CSSProperties, PropsWithChildren } from "react"
import { NorthlineShell } from "./_components/northline-shell"

export const metadata = {
  title: "Northline Operations",
  description: "Connected service operations for Northline Mechanical.",
  favicon: "/favicon.svg",
  themeColor: "#132a33",
  backgroundColor: "#f5f7f7",
} satisfies AppMetadata

export default function RootLayout({ children }: PropsWithChildren) {
  return (
    <AppShellProvider style={{ "--sidebar-width": "12.5rem" } as CSSProperties}>
      <NorthlineShell>{children}</NorthlineShell>
    </AppShellProvider>
  )
}
