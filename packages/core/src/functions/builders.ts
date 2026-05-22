import { FunctionValidationError } from "./errors"
import type {
  CronFunctionBuilder,
  FunctionBuilder,
  FunctionDefinition,
  IntervalFunctionBuilder,
} from "./types"

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new FunctionValidationError(`Function ${field} must not be empty.`)
  }
}

export function defineFunction(id: string): FunctionBuilder {
  assertNonEmpty(id, "id")

  function cron(expression: string): CronFunctionBuilder {
    assertNonEmpty(expression, "cron expression")

    return {
      run(handler): FunctionDefinition {
        return {
          id,
          trigger: {
            type: "cron",
            expression,
            handler,
          },
        }
      },
    }
  }

  function interval(ms: number): IntervalFunctionBuilder {
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new FunctionValidationError(
        "Function interval must be a positive number of milliseconds."
      )
    }

    return {
      run(handler): FunctionDefinition {
        return {
          id,
          trigger: { type: "interval", intervalMs: ms, handler },
        }
      },
    }
  }

  return { cron, interval } as FunctionBuilder
}
