import { setTimeout as delay } from "node:timers/promises"
import { SandboxError } from "@sixb/core/sandboxes"
import {
  type AzureSandboxClient,
  AzureSandboxRequestError,
  type AzureSandboxResource,
} from "./azure-client"

export interface AzureLifecycleOptions {
  readonly teardownTimeoutMs: number
  readonly pollIntervalMs: number
}

export function positiveMilliseconds(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new SandboxError(`[Sandbox] Azure ${name} must be a positive 32-bit integer.`)
  }
  return value
}

/** Bound the whole lifecycle, not just its individual HTTP requests. */
export async function withLifecycleDeadline<T>(
  operation: string,
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new SandboxError(`[Sandbox] Azure ${operation} timed out after ${timeoutMs}ms.`)
      controller.abort(error)
      reject(error)
    }, timeoutMs)
  })
  try {
    return await Promise.race([work(controller.signal), expired])
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason
    if (error instanceof SandboxError) throw error
    throw new SandboxError(`[Sandbox] Azure ${operation} failed.`)
  } finally {
    clearTimeout(timer)
  }
}

export function hasHttpStatus(error: unknown, status: number): boolean {
  return error instanceof AzureSandboxRequestError && error.statusCode === status
}

async function readState(
  client: AzureSandboxClient,
  id: string,
  signal: AbortSignal
): Promise<AzureSandboxResource> {
  signal.throwIfAborted()
  const resource = await client.get(id, { signal })
  signal.throwIfAborted()
  if (resource.id !== id) {
    throw new SandboxError("[Sandbox] Azure returned a different sandbox identity during polling.")
  }
  return resource
}

export async function waitForRunning(
  client: AzureSandboxClient,
  initial: AzureSandboxResource,
  pollIntervalMs: number,
  signal: AbortSignal
): Promise<void> {
  let resource = initial
  for (;;) {
    signal.throwIfAborted()
    if (resource.state === "Running") return
    if (resource.state !== "Creating") {
      throw new SandboxError("[Sandbox] Azure sandbox entered an unexpected state during creation.")
    }
    await delay(pollIntervalMs, undefined, { signal })
    try {
      resource = await readState(client, initial.id, signal)
    } catch (error) {
      // A just-created resource can be temporarily absent from the read endpoint.
      if (!hasHttpStatus(error, 404)) throw error
    }
  }
}

function isStopped(state: string): boolean {
  return state === "Stopped" || state === "Suspended" || state === "Idle"
}

export function stopAzureSandbox(
  client: AzureSandboxClient,
  id: string,
  options: AzureLifecycleOptions
): Promise<void> {
  return withLifecycleDeadline("stop", options.teardownTimeoutMs, async (signal) => {
    let resource: AzureSandboxResource
    try {
      resource = await readState(client, id, signal)
    } catch (error) {
      if (hasHttpStatus(error, 404)) return
      throw error
    }
    if (isStopped(resource.state)) return
    if (resource.state === "Running") {
      try {
        await client.stop(id, { signal })
      } catch (error) {
        // Another actor may have stopped/deleted it. Confirm state; never replay stop.
        if (!hasHttpStatus(error, 409) && !hasHttpStatus(error, 404)) throw error
      }
    } else if (resource.state !== "Stopping") {
      throw new SandboxError(
        "[Sandbox] Azure cannot confirm stop from the sandbox's current state."
      )
    }
    for (;;) {
      try {
        resource = await readState(client, id, signal)
      } catch (error) {
        if (hasHttpStatus(error, 404)) return
        throw error
      }
      if (isStopped(resource.state)) return
      if (resource.state !== "Running" && resource.state !== "Stopping") {
        throw new SandboxError("[Sandbox] Azure sandbox entered an unexpected state during stop.")
      }
      await delay(options.pollIntervalMs, undefined, { signal })
    }
  })
}

export function deleteAzureSandbox(
  client: AzureSandboxClient,
  id: string,
  options: AzureLifecycleOptions
): Promise<void> {
  return withLifecycleDeadline("delete", options.teardownTimeoutMs, async (signal) => {
    await client.delete(id, { signal })
    for (;;) {
      try {
        await readState(client, id, signal)
      } catch (error) {
        if (hasHttpStatus(error, 404)) return
        throw error
      }
      await delay(options.pollIntervalMs, undefined, { signal })
    }
  })
}
