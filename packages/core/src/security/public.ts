/**
 * Browser-safe security entrypoint (`@sixb/core/security`).
 *
 * Group files import `defineGroup` from here, because an app layout imports groups to decide who
 * sees which screens, and the browser cannot load the `@sixb/core` root. Marking files import
 * `defineMarking` from here for the same reason: an ontology that marks a property imports them,
 * and the app imports the ontology.
 */

export type { DefineGroupOptions, DefineMarkingOptions } from "./builders"
export { defineGroup, defineMarking } from "./builders"
export type { GroupDefinition, MarkingDefinition } from "./types"
