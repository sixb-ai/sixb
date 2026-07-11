/** @deprecated Use named schedules and the `events.*` facade. */
export { datasetUpdated, pipelineFinished, syncFinished } from "./builders"
/** @deprecated Removed with the legacy run-trigger helpers. */
export { TriggerValidationError } from "./errors"
/** @deprecated Use `ScheduleReference` for normalized schedule bindings. */
export type { RunTrigger } from "./types"
/** @deprecated Internal compatibility guard for legacy run triggers. */
export { isRunTrigger } from "./types"
