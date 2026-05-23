import type { PropsWithChildren } from "react"

export const metadata = {
  title: "Sixb Counter",
  description: "A simple Sixb starter with a built-in counter and custom app.",
  favicon: "/favicon.svg",
}

export default function RootLayout({ children }: PropsWithChildren) {
  return <>{children}</>
}
