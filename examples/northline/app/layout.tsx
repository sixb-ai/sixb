import type { AppMetadata } from "@sixb/app"
import { SixbEventsProvider } from "@sixb/client/hooks"
import { ThemeProvider } from "@sixb/ui/hooks"
import type { PropsWithChildren } from "react"
import { AppShell } from "./_components/app-shell"

export const metadata = {
  title: "Northline Operations",
  description: "Connected service operations for Northline Mechanical.",
  favicon: "/favicon.svg",
  themeColor: "#132a33",
  backgroundColor: "#f5f7f7",
} satisfies AppMetadata

export default function RootLayout({ children }: PropsWithChildren) {
  return (
    <ThemeProvider>
      <SixbEventsProvider>
        <AppShell>{children}</AppShell>
      </SixbEventsProvider>
    </ThemeProvider>
  )
}
