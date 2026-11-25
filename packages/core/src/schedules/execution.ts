import { type AuthzRequest, assertAuthorized } from "../authorization"
import { resolveRuntimeAuthorizationForProject } from "../execution/authorization"
import { isCronSchedule, triggerScheduleNow } from "../maintenance/passes/cron-pass"
import type { DefinitionCatalog, SixbDefinitions } from "../runtime/definitions"
import type { SixbRuntimeContext } from "../runtime/types"
import { SchedulerValidationError } from "../scheduler/errors"
import type { ScheduleDefinition } from "./types"

/** A cron schedule run now: the occurrence it appended. */
export interface ScheduleRunResult {
  readonly scheduleId: string
  readonly occurrenceKey: string
  readonly triggeredAt: string
}

/** Schedule definitions visible to an execution; process lifecycle remains on the host. */
export interface SchedulesRuntime extends DefinitionCatalog<ScheduleDefinition> {
  /**
   * Run a cron schedule now, as its next occurrence would: what it starts runs as on any
   * occurrence. It takes the run grant of every sync, pipeline and workflow it starts. This is how
   * a cron schedule runs on a branch, where none runs on its own clock.
   */
  run(scheduleId: string): Promise<ScheduleRunResult>
}

export function createSchedulesRuntime(
  runtime: SixbRuntimeContext,
  definitions: Pick<SixbDefinitions, "schedules" | "syncs" | "pipelines" | "workflows">
): SchedulesRuntime {
  const authority = resolveRuntimeAuthorizationForProject(runtime)
  const { schedules } = definitions

  return {
    list: () => {
      switch (authority.type) {
        case "denied":
        case "delegated":
          return []
        case "principal":
        case "unrestricted":
          return schedules.list()
      }
    },
    getById: (scheduleId) => {
      switch (authority.type) {
        case "denied":
        case "delegated":
          return null
        case "principal":
        case "unrestricted":
          return schedules.getById(scheduleId)
      }
    },
    run: async (scheduleId) => {
      const schedule = schedules.getById(scheduleId)
      if (!schedule) {
        throw new SchedulerValidationError(
          `[Sixb] Unknown schedule '${scheduleId}'. Add it to 'schedules/', or pass it to ` +
            "createSixb({ schedules })."
        )
      }

      if (!isCronSchedule(schedule)) {
        throw new SchedulerValidationError(
          `[Sixb] Schedule '${schedule.id}' runs when its event happens, not on a clock, so it ` +
            "cannot be run now. Make the event happen instead."
        )
      }

      const starts = runsStartedBy(definitions, schedule.id)
      if (starts.length === 0) {
        throw new SchedulerValidationError(
          `[Sixb] Schedule '${schedule.id}' starts nothing: attach it to a sync, a pipeline or a ` +
            "workflow with `.when(...)` before running it."
        )
      }

      for (const request of starts) assertAuthorized(runtime, request)

      return triggerScheduleNow(runtime.events, schedule)
    },
  }
}

/** The run grant of each sync, pipeline and workflow the schedule starts. */
function runsStartedBy(
  definitions: Pick<SixbDefinitions, "syncs" | "pipelines" | "workflows">,
  scheduleId: string
): readonly AuthzRequest[] {
  const startedBy = (triggers: readonly { readonly scheduleId: string }[]) =>
    triggers.some((trigger) => trigger.scheduleId === scheduleId)

  return [
    ...definitions.syncs
      .list()
      .filter((sync) => startedBy(sync.triggers))
      .map((sync) => ({ kind: "sync.run" as const, syncId: sync.id })),
    ...definitions.pipelines
      .list()
      .filter((pipeline) => startedBy(pipeline.triggers))
      .map((pipeline) => ({ kind: "pipeline.run" as const, pipelineId: pipeline.id })),
    ...definitions.workflows
      .list()
      .filter((workflow) => startedBy(workflow.triggers))
      .map((workflow) => ({ kind: "workflow.run" as const, workflowId: workflow.id })),
  ]
}
