import {
  type AgentToolDefinition,
  AgentToolPublicError,
  cloneJsonValue,
  defineAgentTool,
  getInvalidJsonValueReason,
  type JsonValue,
  type ReadonlyJsonValue,
} from "@sixb/core"
import { agentContextIdentity } from "@sixb/core/agents/context"
import type { AgentMessageRecord } from "@sixb/core/storage"
import {
  type AppBrowserCommandInput,
  AppBrowserControlError,
  AppBrowserControlHub,
} from "./browser-control-server"

export interface AppBrowserControlRuntime {
  readonly hub: AppBrowserControlHub
  readonly conversationToolProvider: ReturnType<typeof createAppBrowserAgentToolProvider>
}

function createBoundAppBrowserAgentTools(
  hub: AppBrowserControlHub,
  sessionId: string,
  excludedContext: readonly string[]
): readonly AgentToolDefinition[] {
  const inspectApp = defineAgentTool("inspect_app")
    .description(
      "Inspect the current page, route catalog, and live component context of the connected app tab. Context entries describe view state and available commands with their registrationId, name, and JSON input schema. Inspect before invoking a view command; historical context is not the current workspace."
    )
    .input({})
    .run(async ({ signal }) => {
      return await dispatchBrowserCommand(
        hub,
        sessionId,
        { kind: "inspect", excludedContext },
        signal
      )
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
        { kind: "navigate", path: input.path, excludedContext },
        signal
      )
    })

  const invokeAppCommand = defineAgentTool("invoke_app_command")
    .description(
      "Operate a mounted app view using a command returned by inspect_app or navigate_app. Pass its exact registrationId and command name, and a JSON-encoded input object matching its inputSchema. Use this for view changes such as filters, tabs, and selections. The result contains the updated app state. If the view is no longer available, inspect again. Business changes still use declared Sixb actions or workflow interventions."
    )
    .input({ registrationId: "string", command: "string", inputJson: "string" })
    .run(async ({ input, signal }) => {
      let value: unknown
      try {
        value = JSON.parse(input.inputJson)
      } catch {
        throw new AgentToolPublicError("[SixbApp] View command inputJson must contain valid JSON.")
      }
      return await dispatchBrowserCommand(
        hub,
        sessionId,
        {
          kind: "invoke",
          registrationId: input.registrationId,
          command: input.command,
          input: value,
          excludedContext,
        },
        signal
      )
    })

  return Object.freeze([inspectApp, navigateApp, invokeAppCommand])
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
      tools: createBoundAppBrowserAgentTools(
        hub,
        sessionId,
        excludedAppContext(input.triggerMessage)
      ),
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

/** Omitted composer chips stay omitted from inspection and command execution for this turn. */
function excludedAppContext(message: AgentMessageRecord): readonly string[] {
  const included = new Set(
    message.parts.flatMap((part) =>
      part.type === "context" ? [agentContextIdentity(part.context)] : []
    )
  )
  for (const part of message.parts) {
    if (
      part.type !== "context" ||
      part.context.kind !== "app-state" ||
      part.context.id !== "sixb-custom-app-route" ||
      !isRecord(part.context.value) ||
      !isRecord(part.context.value.browser)
    )
      continue
    const offered = part.context.value.browser.offeredContext
    if (!Array.isArray(offered)) return []
    return offered.filter(
      (identity): identity is string => typeof identity === "string" && !included.has(identity)
    )
  }
  return []
}

async function dispatchBrowserCommand(
  hub: AppBrowserControlHub,
  sessionId: string,
  input: AppBrowserCommandInput,
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
