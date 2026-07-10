import type { AppMetadata } from "@sixb/app"
import type { PropsWithChildren } from "react"

export const metadata = {
  title: "Acme Review Desk",
  description: "Review pending workflow interventions for Acme operations.",
  favicon: "/favicon.svg",
  themeColor: "#1d5c53",
  backgroundColor: "#f6f8f3",
} satisfies AppMetadata

export default function RootLayout({ children }: PropsWithChildren) {
  return <>{children}</>
}
