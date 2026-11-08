import { SheetGestures, TouchViewport } from "@sixb/ui/components"
import { useLayoutEffect } from "react"
import { useLocation } from "react-router-dom"
import { PullToRefresh } from "./pull-to-refresh"
import { runScreenMotion, watchScreenChanges } from "./screen-motion"
import { ScrollRestoration } from "./scroll-restoration"

/**
 * What makes every Sixb app behave like an installed one on a phone, whatever its layout: the
 * keyboard, sheets that pull down to close, screens that push and pop, scroll positions kept across
 * Back, and pull to refresh. The generated root renders it once, inside the router; each part does
 * nothing with a mouse or on a wide screen. The back swipe is iOS's own.
 */
export function PhoneFoundations() {
  return (
    <>
      <TouchViewport />
      <SheetGestures />
      <ScreenMotion />
      <ScrollRestoration />
      <PullToRefresh />
    </>
  )
}

function ScreenMotion() {
  const location = useLocation()

  // A layout effect inside the router runs before the router starts listening, so Back is seen
  // here first, while the screen being left is still on the page.
  useLayoutEffect(() => watchScreenChanges(), [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per navigation, keyed by it.
  useLayoutEffect(() => {
    runScreenMotion()
  }, [location.key])

  return null
}
