const resizeObserverGuardKey = "__sixbAgentUiResizeObserverGuardInstalled__"

export function installAgentResizeObserverGuard(): void {
  const state = globalThis as typeof globalThis &
    Record<typeof resizeObserverGuardKey, boolean | undefined>
  if (state[resizeObserverGuardKey]) {
    return
  }

  state[resizeObserverGuardKey] = true

  const NativeResizeObserver = globalThis.ResizeObserver
  if (typeof NativeResizeObserver === "function") {
    globalThis.ResizeObserver = class extends NativeResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        let frame = 0
        super((entries, observer) => {
          globalThis.cancelAnimationFrame(frame)
          frame = globalThis.requestAnimationFrame(() => callback(entries, observer))
        })
      }
    }
  }

  if (typeof window !== "undefined") {
    window.addEventListener("error", suppressResizeObserverLoopError, { capture: true })
  }
}

function suppressResizeObserverLoopError(event: ErrorEvent): void {
  if (event.message.startsWith("ResizeObserver loop")) {
    event.stopImmediatePropagation()
    event.preventDefault()
  }
}
