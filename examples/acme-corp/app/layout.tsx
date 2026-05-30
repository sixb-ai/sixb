import type { PropsWithChildren } from "react"

export const metadata = {
  title: "Acme Review Desk",
  description: "Review pending workflow interventions for Acme operations.",
}

export default function RootLayout({ children }: PropsWithChildren) {
  return <>{children}</>
}
