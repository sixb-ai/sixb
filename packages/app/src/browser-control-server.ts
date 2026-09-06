import {
  type AppBrowserCommand,
  type AppBrowserCommandResult,
  type AppBrowserOperation,
  appBrowserControlPath,
  appBrowserControlSecretHeader,
} from "./browser-control-protocol"

// Bun's default HTTP idle timeout is 10 seconds. Finish each poll below that boundary so the
// browser receives a clean 204 instead of a transport-level disconnect.
const browserPollTimeoutMs = 8_000
const browserCommandTimeoutMs = 30_000
const browserSessionStaleAfterMs = 45_000
const maxBrowserResultBytes = 8 * 1024 * 1024

interface BrowserPollWaiter {
  readonly resolve: (command: AppBrowserCommand | null) => void
  readonly dispose: () => void
}

interface BrowserSession {
  readonly id: string
  readonly secret: string
  readonly commands: AppBrowserCommand[]
  lastSeenAt: number
  pollWaiter: BrowserPollWaiter | null
}

interface PendingBrowserCommand {
  readonly sessionId: string
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly dispose: () => void
}

export type AppBrowserCommandInput = AppBrowserOperation

export class AppBrowserControlError extends Error {
  readonly name = "AppBrowserControlError"

  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message)
  }
}

/**
 * Development bridge between one co-hosted agent worker and the custom-app tabs it can drive.
 * The browser secret authenticates only browser polling/result delivery and is never model input.
 */
export class AppBrowserControlHub {
  readonly #sessions = new Map<string, BrowserSession>()
  readonly #pending = new Map<string, PendingBrowserCommand>()

  constructor(private readonly now: () => number = Date.now) {}

  register(sessionId: string, secret: string): void {
    assertBrowserCredential(sessionId, "session id")
    assertBrowserCredential(secret, "session secret")

    this.#pruneStaleSessions()

    const existing = this.#sessions.get(sessionId)
    if (existing) {
      if (existing.secret !== secret) {
        throw new AppBrowserControlError("Browser session credentials do not match.", 409)
      }
      existing.lastSeenAt = this.now()
      return
    }

    this.#sessions.set(sessionId, {
      id: sessionId,
      secret,
      commands: [],
      lastSeenAt: this.now(),
      pollWaiter: null,
    })
  }

  /** Whether a recently connected tab can currently receive agent commands. */
  hasActiveSession(sessionId: string): boolean {
    this.#pruneStaleSessions()
    return this.#sessions.has(sessionId)
  }

  async poll(
    sessionId: string,
    secret: string,
    signal?: AbortSignal
  ): Promise<AppBrowserCommand | null> {
    const session = this.#browserSession(sessionId, secret)
    session.lastSeenAt = this.now()

    const queued = session.commands.shift()
    if (queued) return queued

    session.pollWaiter?.resolve(null)
    return await new Promise<AppBrowserCommand | null>((resolve) => {
      let settled = false
      const finish = (command: AppBrowserCommand | null) => {
        if (settled) return
        settled = true
        dispose()
        if (session.pollWaiter === waiter) session.pollWaiter = null
        resolve(command)
      }
      const timer = setTimeout(() => finish(null), browserPollTimeoutMs)
      const onAbort = () => finish(null)
      const dispose = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
      }
      const waiter: BrowserPollWaiter = { resolve: finish, dispose }
      session.pollWaiter = waiter
      signal?.addEventListener("abort", onAbort, { once: true })
      if (signal?.aborted) finish(null)
    })
  }

  submit(sessionId: string, secret: string, result: AppBrowserCommandResult): void {
    const session = this.#browserSession(sessionId, secret)
    session.lastSeenAt = this.now()
    const pending = this.#pending.get(result.commandId)
    if (!pending || pending.sessionId !== sessionId) {
      throw new AppBrowserControlError("Browser command is no longer pending.", 409)
    }

    this.#pending.delete(result.commandId)
    pending.dispose()
    if (result.ok) {
      pending.resolve(result.value ?? null)
      return
    }
    pending.reject(
      new AppBrowserControlError(
        result.error?.trim() || "The browser could not complete the command."
      )
    )
  }

  async dispatch(
    sessionId: string,
    input: AppBrowserCommandInput,
    signal?: AbortSignal
  ): Promise<unknown> {
    this.#pruneStaleSessions()
    const session = this.#activeSession(sessionId)
    const command: AppBrowserCommand = {
      id: crypto.randomUUID(),
      expiresAt: this.now() + browserCommandTimeoutMs,
      ...input,
    }

    return await new Promise<unknown>((resolve, reject) => {
      let settled = false
      const finishWithError = (error: Error) => {
        if (settled) return
        settled = true
        this.#pending.delete(command.id)
        const queuedIndex = session.commands.findIndex((entry) => entry.id === command.id)
        if (queuedIndex !== -1) session.commands.splice(queuedIndex, 1)
        dispose()
        reject(error)
      }
      const finishWithValue = (value: unknown) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      const timer = setTimeout(
        () =>
          finishWithError(
            new AppBrowserControlError(
              "The browser tab did not answer in time. Keep the tab open and try again.",
              504
            )
          ),
        browserCommandTimeoutMs
      )
      const onAbort = () =>
        finishWithError(new AppBrowserControlError("The browser command was cancelled.", 499))
      const dispose = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
      }
      this.#pending.set(command.id, {
        sessionId,
        resolve: finishWithValue,
        reject: finishWithError,
        dispose,
      })
      signal?.addEventListener("abort", onAbort, { once: true })
      if (signal?.aborted) {
        onAbort()
        return
      }

      if (session.pollWaiter) {
        const waiter = session.pollWaiter
        session.pollWaiter = null
        waiter.dispose()
        waiter.resolve(command)
      } else {
        session.commands.push(command)
      }
    })
  }

  #activeSession(sessionId: string): BrowserSession {
    const session = this.#sessions.get(sessionId)
    if (!session || this.now() - session.lastSeenAt > browserSessionStaleAfterMs) {
      throw new AppBrowserControlError(
        "That custom-app tab is not connected. Keep it open, then try again.",
        404
      )
    }
    return session
  }

  #browserSession(sessionId: string, secret: string): BrowserSession {
    const session = this.#sessions.get(sessionId)
    if (!session || session.secret !== secret) {
      throw new AppBrowserControlError("Browser session credentials are invalid.", 401)
    }
    return session
  }

  #pruneStaleSessions(): void {
    const now = this.now()
    for (const [sessionId, session] of this.#sessions) {
      if (now - session.lastSeenAt <= browserSessionStaleAfterMs) continue

      session.pollWaiter?.resolve(null)
      this.#sessions.delete(sessionId)
      for (const pending of this.#pending.values()) {
        if (pending.sessionId !== sessionId) continue
        pending.reject(
          new AppBrowserControlError(
            "That custom-app tab disconnected before it completed the command.",
            404
          )
        )
      }
    }
  }
}

export async function handleAppBrowserControlRequest(
  request: Request,
  hub: AppBrowserControlHub
): Promise<Response> {
  try {
    const url = new URL(request.url)
    const operation = url.pathname.slice(appBrowserControlPath.length).replace(/^\/+/, "")
    if (operation === "register" && request.method === "POST") {
      const body = await readBrowserRequestBody(request)
      hub.register(requireBodyString(body, "sessionId"), requireBrowserSecret(request))
      return browserJsonResponse({ ok: true })
    }

    if (operation === "next" && request.method === "GET") {
      const sessionId = url.searchParams.get("sessionId") ?? ""
      const command = await hub.poll(sessionId, requireBrowserSecret(request), request.signal)
      return command ? browserJsonResponse(command) : new Response(null, { status: 204 })
    }

    if (operation === "result" && request.method === "POST") {
      const body = await readBrowserRequestBody(request)
      const commandId = requireBodyString(body, "commandId")
      const ok = body.ok
      if (typeof ok !== "boolean") {
        throw new AppBrowserControlError("Browser result 'ok' must be a boolean.")
      }
      hub.submit(requireBodyString(body, "sessionId"), requireBrowserSecret(request), {
        commandId,
        ok,
        ...(Object.hasOwn(body, "value") ? { value: body.value } : {}),
        ...(typeof body.error === "string" ? { error: body.error } : {}),
      })
      return browserJsonResponse({ ok: true })
    }

    return new Response("Not Found", { status: 404 })
  } catch (error) {
    const status = error instanceof AppBrowserControlError ? error.status : 500
    const message =
      error instanceof AppBrowserControlError
        ? error.message
        : "The browser control request could not be processed."
    return browserJsonResponse({ error: message }, status)
  }
}

function assertBrowserCredential(value: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(value)) {
    throw new AppBrowserControlError(`Browser ${label} is invalid.`)
  }
}

function requireBrowserSecret(request: Request): string {
  return request.headers.get(appBrowserControlSecretHeader) ?? ""
}

async function readBrowserRequestBody(request: Request): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(declaredLength) && declaredLength > maxBrowserResultBytes) {
    throw new AppBrowserControlError("Browser control result is too large.", 413)
  }
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > maxBrowserResultBytes) {
    throw new AppBrowserControlError("Browser control result is too large.", 413)
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new AppBrowserControlError("Browser control body must be valid JSON.")
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppBrowserControlError("Browser control body must be an object.")
  }
  return value as Record<string, unknown>
}

function requireBodyString(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== "string" || !value.trim()) {
    throw new AppBrowserControlError(`Browser control '${key}' must be a non-empty string.`)
  }
  return value
}

function browserJsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  })
}
