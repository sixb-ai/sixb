import type { AuthStorage } from "../auth"
import type { ShareSessionStorage } from "../share-sessions"
import { ExecutionStorageError } from "./errors"
import { compareExecutionCreation } from "./provider"
import type {
  CreateExecutionInput,
  ExecutionDescendant,
  ExecutionRecord,
  ExecutionStorage,
  ListExecutionDescendantsInput,
  ListSessionExecutionsInput,
  SessionExecutions,
} from "./types"
import { cloneExecutionRecord, prepareExecutionRecord } from "./validation"

type RunRootOperation = <T>(run: () => Promise<T> | T) => Promise<T>

const runDirectly: RunRootOperation = async <T>(run: () => Promise<T> | T): Promise<T> => run()

function executionKey(projectId: string, id: string): string {
  return JSON.stringify([projectId, id])
}

export class InMemoryExecutionStorage implements ExecutionStorage {
  private readonly rows = new Map<string, ExecutionRecord>()
  private readonly runRootOperation: RunRootOperation
  private readonly shareSessions?: Pick<ShareSessionStorage, "getById">

  constructor(
    private readonly auth: AuthStorage,
    input: {
      readonly runRootOperation?: RunRootOperation
      readonly shareSessions?: Pick<ShareSessionStorage, "getById">
    } = {}
  ) {
    this.runRootOperation = input.runRootOperation ?? runDirectly
    this.shareSessions = input.shareSessions
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
        getShareSession: async ({ projectId, id }) =>
          (await this.shareSessions?.getById({ projectId, id })) ?? null,
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

  async listBySession(input: ListSessionExecutionsInput): Promise<SessionExecutions> {
    return this.runRootOperation(() => {
      const rows = [...this.rows.values()].filter((row) => row.projectId === input.projectId)

      const roots = rows
        .filter(
          (row) =>
            row.source.type !== "execution" &&
            row.createdAt >= input.from &&
            row.createdAt < input.to &&
            isFromSession(row, input.session)
        )
        .sort(compareExecutionCreation)
        .slice(0, input.limit + 1)

      // Level by level, as the SQL providers walk the tree, so truncation keeps roots first.
      const found = [...roots]
      let level = roots
      while (level.length > 0 && found.length <= input.limit) {
        const parents = new Set(level.map((row) => row.id))
        level = rows
          .filter((row) => row.source.type === "execution" && parents.has(row.source.executionId))
          .sort(compareExecutionCreation)
        found.push(...level)
      }

      return {
        executions: found
          .slice(0, input.limit)
          .sort(compareExecutionCreation)
          .map(cloneExecutionRecord),
        truncated: found.length > input.limit,
      }
    })
  }

  async listDescendants(
    input: ListExecutionDescendantsInput
  ): Promise<readonly ExecutionDescendant[]> {
    return this.runRootOperation(() => {
      const rows = [...this.rows.values()].filter((row) => row.projectId === input.projectId)
      const seen = new Set(input.executionIds)
      const found: ExecutionRecord[] = []

      let parents = new Set(input.executionIds)
      while (parents.size > 0) {
        const level = rows.filter(
          (row) =>
            row.source.type === "execution" &&
            parents.has(row.source.executionId) &&
            !seen.has(row.id)
        )

        for (const row of level) seen.add(row.id)
        found.push(...level)
        parents = new Set(level.map((row) => row.id))
      }

      return found
        .flatMap((row) =>
          row.source.type === "execution" ? [{ id: row.id, parentId: row.source.executionId }] : []
        )
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    })
  }
}

function isFromSession(
  row: ExecutionRecord,
  session: ListSessionExecutionsInput["session"]
): boolean {
  const ref = row.authorizationRef

  if (session.type === "user") {
    return (
      ref.type === "principal" &&
      ref.credential?.type === "session" &&
      ref.credential.id === session.id
    )
  }

  return ref.type === "delegated" && ref.delegation.sessionId === session.id
}

export type InMemoryExecutionStorageSnapshot = Map<string, ExecutionRecord>
