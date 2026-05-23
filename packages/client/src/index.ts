// Generated SDK surface (modern)

export type {
  SixbBrowserClientController,
  SixbBrowserRuntimeConfig,
  SixbBrowserRuntimeDefaults,
} from "./browser"
export * from "./events"
export * from "./generated"
export { client } from "./generated/client.gen"

// Framework UI models and adapters
export * from "./models"

// React hooks
export {
  createSixbEventsWebSocketUrl,
  type UseSixbEventsOptions,
  type UseSixbEventsResult,
  useSixbEvents,
} from "./useSixbEvents"
