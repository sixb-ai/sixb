import type { Sixb } from "../runtime/sixb"
import type { OntologySource } from "../runtime/types"
import { createCronMatcher } from "../schedules"
import { FunctionError, FunctionValidationError } from "./errors"
import type {
  CronTriggerDefinition,
  FunctionContext,
  FunctionDefinition,
  FunctionMetadata,
  IntervalTriggerDefinition,
} from "./types"

type CleanupFn = () => Promise<void>

export interface FunctionRuntimeOptions {
  sixb: Sixb<readonly OntologySource[]>
  functions: readonly FunctionDefinition[]
}

export class FunctionRuntime {
  private readonly sixb: Sixb<readonly OntologySource[]>
  private readonly functions: readonly FunctionDefinition[]
  private readonly cleanups: CleanupFn[] = []
  private started = false

  constructor(options: FunctionRuntimeOptions) {
    this.sixb = options.sixb
    this.functions = options.functions
  }

  async start(): Promise<void> {
    if (this.started) return

    const seenIds = new Set<string>()
    for (const fn of this.functions) {
      if (seenIds.has(fn.id)) {
        throw new FunctionValidationError(`Duplicate function id '${fn.id}'.`)
      }
      seenIds.add(fn.id)
    }

    try {
      for (const fn of this.functions) {
        const trigger = fn.trigger

        if (trigger.type === "cron") {
          this.startCronTrigger(fn.id, trigger)
        } else if (trigger.type === "interval") {
          this.startIntervalTrigger(fn.id, trigger)
        }
      }

      this.started = true
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  async stop(): Promise<void> {
    const errors: unknown[] = []

    while (this.cleanups.length > 0) {
      const cleanup = this.cleanups.pop()!

      try {
        await cleanup()
      } catch (error) {
        errors.push(error)
      }
    }

    this.started = false

    if (errors.length > 0) {
      throw new FunctionError(
        `Failed to stop all functions (${errors.length} error${errors.length === 1 ? "" : "s"}).`
      )
    }
  }

  private startCronTrigger(functionId: string, trigger: CronTriggerDefinition): void {
    const matcher = createCronMatcher(trigger.expression)
    let lastExecutedMinute: number | null = null

    const tick = () => {
      const now = new Date()
      const minuteKey = Math.floor(now.getTime() / 60_000)

      if (minuteKey === lastExecutedMinute) {
        return
      }

      lastExecutedMinute = minuteKey
      if (!matcher(now)) {
        return
      }

      void this.safeInvoke(functionId, trigger, (ctx) => trigger.handler(ctx))
    }

    const interval = setInterval(tick, 1_000)
    tick()

    this.cleanups.push(async () => {
      clearInterval(interval)
    })
  }

  private startIntervalTrigger(functionId: string, trigger: IntervalTriggerDefinition): void {
    const tick = () => {
      void this.safeInvoke(functionId, trigger, (ctx) => trigger.handler(ctx))
    }

    const handle = setInterval(tick, trigger.intervalMs)
    tick()

    this.cleanups.push(async () => {
      clearInterval(handle)
    })
  }

  private async safeInvoke(
    functionId: string,
    trigger: FunctionMetadata["trigger"],
    fn: (ctx: FunctionContext) => Promise<void> | void
  ): Promise<void> {
    const context = this.createContext({ id: functionId, trigger })
    try {
      await fn(context)
    } catch (error) {
      console.error(`[Sixb] Function '${functionId}' ${trigger.type} handler failed:`, error)
    }
  }

  private createContext(metadata: FunctionMetadata): FunctionContext {
    return {
      sixb: this.sixb,
      fn: metadata,
    }
  }
}
