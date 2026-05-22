import type { PropsWithChildren } from "react"

export const metadata = {
  title: "Pario AC Twin",
  description: "Realtime air conditioning digital twin dashboard and controls.",
  favicon: "/favicon.svg",
}

export default function RootLayout({ children }: PropsWithChildren) {
  return <>{children}</>
}
