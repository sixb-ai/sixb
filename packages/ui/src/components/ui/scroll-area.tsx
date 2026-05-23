"use client"

import { cn } from "@sixb/ui/lib/utils"
import type * as React from "react"

/**
 * Lightweight scroll container that replaces the Radix ScrollArea primitive.
 *
 * The Radix implementation (`@radix-ui/react-scroll-area@1.2.x`) triggers an
 * infinite "Maximum update depth exceeded" loop under React 19 due to its
 * ref-callback / setState interaction in `@radix-ui/react-compose-refs`.
 *
 * This drop-in replacement uses native CSS overflow + thin-scrollbar styling,
 * which is supported in all modern browsers and avoids the React 19 bug.
 */
function ScrollArea({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="scroll-area"
      className={cn(
        "relative overflow-y-auto overscroll-contain",
        "[scrollbar-width:thin] [scrollbar-color:var(--color-border)_transparent]",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

function ScrollBar() {
  return null
}

export { ScrollArea, ScrollBar }
