import type { Metadata, Viewport } from "next"
import type { ReactNode } from "react"
import "../src/styles.css"
import { Providers } from "./providers"

export const siteDescription =
  "Sixb is a TypeScript framework for operational software. Model your domain as a typed " +
  "ontology, sync live data, and ship automation, a typed API, a client, and apps from one runtime."

export const metadata: Metadata = {
  metadataBase: new URL("https://docs.sixb.ai"),
  title: {
    default: "Sixb Docs",
    template: "%s | Sixb Docs",
  },
  description: siteDescription,
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Sixb Docs",
    title: "Sixb Docs",
    description: siteDescription,
  },
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
}

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
