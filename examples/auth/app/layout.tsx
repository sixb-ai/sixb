import type { AppMetadata } from "@sixb/app"
import type { PropsWithChildren } from "react"

export const metadata = {
  title: "Acme Operations",
  description: "Secure access to Acme operations.",
  themeColor: "#13271f",
  backgroundColor: "#eef2ed",
} satisfies AppMetadata

export default function RootLayout({ children }: PropsWithChildren) {
  return <>{children}</>
}
