import { type AppMetadata, AppShell } from "@sixb/app"
import { Satellite } from "lucide-react"
import type { PropsWithChildren } from "react"

export const metadata = {
  title: "Sentinel-6B Mission Tracker",
  description: "A minimal Sixb starter that locates the Sentinel-6B satellite.",
  favicon: "/favicon.svg",
} satisfies AppMetadata

export default function RootLayout({ children }: PropsWithChildren) {
  return (
    <AppShell
      brand={
        // The wordmark, or just the mark while the sidebar is collapsed to icons.
        <a
          href="/"
          className="flex h-10 items-center px-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
        >
          <img
            src="/sixb-wordmark.svg"
            alt="Sixb"
            className="h-[15px] w-auto group-data-[collapsible=icon]:hidden"
          />
          <img
            src="/favicon.svg"
            alt="Sixb"
            className="hidden size-5 group-data-[collapsible=icon]:block"
          />
        </a>
      }
      nav={[{ label: "Mission tracker", href: "/", icon: Satellite }]}
    >
      {children}
    </AppShell>
  )
}
