import { LinkedinMediaUploadError } from "../media-upload"
import type { LinkedinImage, LinkedinMediaWaitOptions, LinkedinVideo } from "../types/media"

export function assertOwner(owner: string): void {
  if (!/^urn:li:(organization|person):[^\s:]+$/.test(owner)) {
    throw new Error("[SixbLinkedin] media owner must be an organization or person URN.")
  }
}

export function assertFile(file: Blob): void {
  if (!(file instanceof Blob) || !Number.isSafeInteger(file.size) || file.size <= 0) {
    throw new Error("[SixbLinkedin] file must be a non-empty Blob or File.")
  }
}

export function assertUnexpired(expiresAt: number): void {
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new LinkedinMediaUploadError("Upload session has expired; initialize a new upload.")
  }
}

export function assertWaitOptions(options: LinkedinMediaWaitOptions): void {
  for (const value of [options.timeoutMs ?? 300_000, options.pollIntervalMs ?? 1_000]) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
      throw new Error("[SixbLinkedin] media wait durations must be positive timer-safe integers.")
    }
  }
}

export async function waitForMedia<T extends LinkedinImage | LinkedinVideo>(
  id: T["id"],
  get: (signal: AbortSignal) => Promise<T>,
  contextSignal: AbortSignal,
  options: LinkedinMediaWaitOptions = {}
): Promise<T> {
  assertWaitOptions(options)
  const controller = new AbortController()
  const signal = AbortSignal.any([
    contextSignal,
    controller.signal,
    ...(options.signal ? [options.signal] : []),
  ])
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(`[SixbLinkedin] Timed out waiting for ${id}; check its status before publishing.`)
      ),
    options.timeoutMs ?? 300_000
  )
  let onAbort: (() => void) | undefined
  try {
    signal.throwIfAborted()
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener("abort", onAbort, { once: true })
    })
    const poll = async () => {
      for (;;) {
        signal.throwIfAborted()
        const media = await get(signal)
        if (media.status === "AVAILABLE") return media
        if (media.status === "PROCESSING_FAILED") {
          throw new Error(
            `[SixbLinkedin] Processing failed for ${id}; read its metadata for details.`
          )
        }
        await delay(options.pollIntervalMs ?? 1_000, signal)
      }
    }
    // Bounds the wait even if a configured HTTP retry delay outlives the deadline.
    return await Promise.race([poll(), cancelled])
  } finally {
    clearTimeout(timer)
    if (onAbort) signal.removeEventListener("abort", onAbort)
    controller.abort()
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}
