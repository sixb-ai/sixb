"use client"

import { ThemeProvider } from "@sixb/ui/hooks"
import type { ReactNode } from "react"

export function Providers({ children }: Readonly<{ children: ReactNode }>) {
  return <ThemeProvider>{children}</ThemeProvider>
}
