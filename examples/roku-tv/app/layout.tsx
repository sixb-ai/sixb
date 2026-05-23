import type { PropsWithChildren } from "react"

export const metadata = {
  title: "Sixb Television Twin",
  description: "Realtime television digital twin remote and telemetry dashboard.",
  favicon: "/favicon.svg",
}

export default function RootLayout({ children }: PropsWithChildren) {
  return <>{children}</>
}
