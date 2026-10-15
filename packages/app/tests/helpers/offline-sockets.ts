/**
 * Replaces the global `WebSocket` with one that never connects, so pages that subscribe to live
 * events render in tests without reaching a network. Returns what puts the real one back.
 */
export function stubWebSockets(): { readonly opened: string[]; restore(): void } {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")
  const opened: string[] = []

  class OfflineWebSocket {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSING = 2
    static readonly CLOSED = 3
    readyState = OfflineWebSocket.CONNECTING
    onopen: (() => void) | null = null
    onmessage: (() => void) | null = null
    onerror: (() => void) | null = null
    onclose: (() => void) | null = null

    constructor(url: string | URL) {
      opened.push(String(url))
    }

    send(): void {}

    close(): void {
      this.readyState = OfflineWebSocket.CLOSED
    }

    addEventListener(): void {}

    removeEventListener(): void {}
  }

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: OfflineWebSocket,
  })
  return {
    opened,
    restore() {
      if (previous) Object.defineProperty(globalThis, "WebSocket", previous)
      else Reflect.deleteProperty(globalThis, "WebSocket")
    },
  }
}
