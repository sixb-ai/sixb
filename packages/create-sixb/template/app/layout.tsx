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
        <a href="/" className="flex h-10 items-center px-2">
          <img src="/sixb-wordmark.svg" alt="Sixb" className="h-[15px] w-auto" />
        </a>
      }
      nav={[{ label: "Mission tracker", href: "/", icon: Satellite }]}
    >
      {children}
    </AppShell>
  )
}
