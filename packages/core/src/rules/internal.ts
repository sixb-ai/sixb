/**
 * What this repo's own packages need from the rules module, and nothing else.
 *
 * The rules worker and the server's rules route both derive a rule's event dependencies to decide
 * which events wake it. That derivation is plumbing, not authoring API, so it lives here rather than
 * on the `@sixb/core` root — see the export-surface rules in `AGENTS.md`.
 */
export { deriveRuleEventDependencies } from "./dependencies"
