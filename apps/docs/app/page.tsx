import type { Metadata } from "next"
import { App } from "../src/App"
import { siteDescription } from "./layout"

export const metadata: Metadata = {
  title: "Sixb Docs",
  description: siteDescription,
  alternates: {
    canonical: "/",
  },
}

export default function HomePage() {
  return <App initialPath="/" />
}
