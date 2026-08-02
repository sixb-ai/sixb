import type { AppMetadata } from "@sixb/app"
import type { PropsWithChildren } from "react"

export const metadata = {
  title: "Sentinel-6B Mission Tracker",
  description: "A minimal Sixb starter that locates the Sentinel-6B satellite.",
  favicon: "/favicon.svg",
} satisfies AppMetadata

export default function RootLayout({ children }: PropsWithChildren) {
  return <>{children}</>
}
