import { useEffect, useState } from "react"

/** Returns `value` after it has stopped changing for `delayMs`. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    if (delayMs <= 0) {
      setDebounced(value)
      return
    }
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])

  return delayMs <= 0 ? value : debounced
}
