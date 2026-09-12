import type { AuthStorage } from "../auth"
import { ExecutionStorageError } from "./errors"
import type { CreateExecutionInput, ExecutionRecord, ExecutionStorage } from "./types"
import { cloneExecutionRecord, prepareExecutionRecord } from "./validation"

type RunRootOperation = <T>(run: () => Promise<T> | T) => Promise<T>

const runDirectly: RunRootOperation = async <T>(run: () => Promise<T> | T): Promise<T> => run()

function executionKey(projectId: string, id: string): string {
  return JSON.stringify([projectId, id])
}

export class InMemoryExecutionStorage implements ExecutionStorage {
  private readonly rows = new Map<string, ExecutionRecord>()
  private readonly runRootOperation: RunRootOperation

  constructor(
    private readonly auth: AuthStorage,
    input: { readonly runRootOperation?: RunRootOperation } = {}
  ) {
    this.runRootOperation = input.runRootOperation ?? runDirectly
  }

  snapshot(): InMemoryExecutionStorageSnapshot {
    return structuredClone(this.rows)
  }

  restore(snapshot: InMemoryExecutionStorageSnapshot): void {
    this.rows.clear()
    for (const [key, record] of structuredClone(snapshot)) {
      this.rows.set(key, record)
    }
  }

  async create(input: CreateExecutionInput): Promise<ExecutionRecord> {
    return this.runRootOperation(async () => {
      const key = executionKey(input.projectId, input.id)
      if (this.rows.has(key)) {
        throw new ExecutionStorageError(
          "duplicate_execution",
          `[Sixb] Execution '${input.id}' already exists in project '${input.projectId}'.`
        )
      }

      const record = await prepareExecutionRecord(input, {
        auth: this.auth,
        getExecution: async ({ projectId, id }) => {
          const existing = this.rows.get(executionKey(projectId, id))
          return existing ? cloneExecutionRecord(existing) : null
        },
      })

      this.rows.set(key, cloneExecutionRecord(record))
      return cloneExecutionRecord(record)
    })
  }

  async getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<ExecutionRecord | null> {
    return this.runRootOperation(() => {
      const record = this.rows.get(executionKey(params.projectId, params.id))
      return record ? cloneExecutionRecord(record) : null
    })
  }
}

export type InMemoryExecutionStorageSnapshot = Map<string, ExecutionRecord>
