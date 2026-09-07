import {
  type AgentToolDefinition,
  AgentToolPublicError,
  cloneJsonValue,
  defineAgentTool,
  getInvalidJsonValueReason,
  type JsonValue,
  type ReadonlyJsonValue,
} from "@sixb/core"
import type { AgentMessageRecord } from "@sixb/core/storage"
import { AppBrowserControlError, AppBrowserControlHub } from "./browser-control-server"

export interface AppBrowserControlRuntime {
  readonly hub: AppBrowserControlHub
  readonly conversationToolProvider: ReturnType<typeof createAppBrowserAgentToolProvider>
}

function createBoundAppBrowserAgentTools(
  hub: AppBrowserControlHub,
  sessionId: string
): readonly AgentToolDefinition[] {
  const inspectApp = defineAgentTool("inspect_app")
    .description(
      "Inspect the exact current page, matching route, complete route catalog, title, and viewport of the connected custom-app browser tab."
    )
    .input({})
    .run(async ({ signal }) => {
      return await dispatchBrowserCommand(hub, sessionId, { kind: "inspect" }, signal)
    })

  const navigateApp = defineAgentTool("navigate_app")
    .description(
      "Navigate an active custom-app browser tab to a route listed in its sixb-custom-app-route context when that visible destination helps the user continue the work, then return the resulting page inspection. Use project data tools for research instead of touring routes, and do not navigate to a launcher or home screen merely to inspect the organization."
    )
    .input({ path: "string" })
    .run(async ({ input, signal }) => {
      return await dispatchBrowserCommand(
        hub,
        sessionId,
        { kind: "navigate", path: input.path },
        signal
      )
    })

  return Object.freeze([inspectApp, navigateApp])
}

/**
 * Host-owned provider for `sixb dev`. It grants browser tools only when the triggering message
 * came from a currently connected custom-app tab.
 */
export function createAppBrowserAgentToolProvider(hub: AppBrowserControlHub): (input: {
  readonly triggerMessage: AgentMessageRecord
}) => {
  readonly tools: readonly AgentToolDefinition[]
  readonly capabilities: readonly ["application-surface"] | readonly []
} {
  return (input) => {
    const sessionId = appBrowserSessionId(input.triggerMessage)
    if (!sessionId || !hub.hasActiveSession(sessionId)) {
      return { tools: [], capabilities: [] }
    }
    return {
      tools: createBoundAppBrowserAgentTools(hub, sessionId),
      capabilities: ["application-surface"],
    }
  }
}

/** One explicitly owned bridge shared by the custom-app server and co-hosted agent worker. */
export function createAppBrowserControlRuntime(): AppBrowserControlRuntime {
  const hub = new AppBrowserControlHub()
  return {
    hub,
    conversationToolProvider: createAppBrowserAgentToolProvider(hub),
  }
}

function appBrowserSessionId(message: AgentMessageRecord): string | null {
  for (const part of message.parts) {
    if (
      part.type !== "context" ||
      part.context.kind !== "app-state" ||
      part.context.id !== "sixb-custom-app-route" ||
      !isRecord(part.context.value)
    ) {
      continue
    }
    const browser = part.context.value.browser
    if (!isRecord(browser) || browser.navigate !== true) continue
    if (typeof browser.sessionId === "string" && browser.sessionId.trim().length > 0) {
      return browser.sessionId
    }
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function dispatchBrowserCommand(
  hub: AppBrowserControlHub,
  sessionId: string,
  input: { readonly kind: "inspect" } | { readonly kind: "navigate"; readonly path: string },
  signal: AbortSignal
): Promise<JsonValue> {
  try {
    const value = await hub.dispatch(sessionId, input, signal)
    const reason = getInvalidJsonValueReason(value, "browser result")
    if (reason) {
      throw new AgentToolPublicError(`[SixbApp] The browser returned an invalid result; ${reason}.`)
    }
    return cloneJsonValue(value as ReadonlyJsonValue, "browser result")
  } catch (error) {
    if (error instanceof AppBrowserControlError) {
      throw new AgentToolPublicError(`[SixbApp] ${error.message}`)
    }
    throw error
  }
}
