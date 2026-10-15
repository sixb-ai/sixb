import type { AppMetadata, AppVisibility } from "@sixb/app"
import type { PropsWithChildren } from "react"
import { securityAdmins } from "../security/groups/security-admins"

export const metadata = {
  title: "Acme Operations",
  description: "Secure access to Acme operations.",
  themeColor: "#13271f",
  backgroundColor: "#eef2ed",
} satisfies AppMetadata

// Everyone signed in keeps Settings › Personal and Developers; only security admins see Members,
// Service accounts, and the Data and Observability pages.
export const visibility = {
  settings: [securityAdmins],
  data: [securityAdmins],
  observability: [securityAdmins],
} satisfies AppVisibility

export default function RootLayout({ children }: PropsWithChildren) {
  return <>{children}</>
}
