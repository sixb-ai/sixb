import { useCallback, useEffect, useRef, useState } from "react"

const COPIED_MS = 1600

/** Copies text to the clipboard, and says so for a moment: `copied` is true until then. */
export function useCopyFeedback(): {
  readonly copied: boolean
  readonly copy: (text: string) => Promise<void>
} {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // The clipboard can be unavailable, such as on an insecure origin.
      return
    }
    clearTimeout(timer.current)
    setCopied(true)
    timer.current = setTimeout(() => setCopied(false), COPIED_MS)
  }, [])
  return { copied, copy }
}
