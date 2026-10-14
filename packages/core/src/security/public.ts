/**
 * Browser-safe security entrypoint (`@sixb/core/security`).
 *
 * Group files import `defineGroup` from here, because an app layout imports groups to decide who
 * sees which screens, and the browser cannot load the `@sixb/core` root.
 */

export type { DefineGroupOptions } from "./builders"
export { defineGroup } from "./builders"
export type { GroupDefinition } from "./types"
