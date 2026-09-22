import { useCallback, useEffect, useRef, useState } from "react"

export function useClipboard(text: string) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle")
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const request = useRef(0)
  const cancel = useCallback(() => {
    request.current += 1
    clearTimeout(timer.current)
  }, [])
  const reset = useCallback(() => {
    cancel()
    setStatus("idle")
  }, [cancel])

  // biome-ignore lint/correctness/useExhaustiveDependencies: Changing snippets invalidates pending copies and their feedback.
  useEffect(() => {
    reset()
    return cancel
  }, [text, reset, cancel])

  async function copy() {
    reset()
    const current = request.current
    try {
      await navigator.clipboard.writeText(text)
      if (current !== request.current) return null
      setStatus("copied")
      timer.current = setTimeout(reset, 1800)
      return true
    } catch {
      if (current !== request.current) return null
      setStatus("error")
      return false
    }
  }

  return { status, copy, reset }
}
