import { describe, expect, test } from "bun:test"
import type { AuthStorage } from "../storage/auth"
import type {
  CreateExecutionInput,
  ExecutionStorage,
  TrustedPrimitiveKind,
} from "../storage/executions"
import type { Storage } from "../storage/types"

export type ExecutionStorageContractStorage = Storage & {
  readonly auth: AuthStorage
  readonly executions: ExecutionStorage
}

export interface ExecutionStorageContractSuiteOptions<
  TStorage extends ExecutionStorageContractStorage = ExecutionStorageContractStorage,
> {
  /** Factory that returns one isolated, migrated storage bundle for each test. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
}

const projectId = "execution-contract"
const createdAt = new Date("2026-06-01T12:00:00.000Z")
const expiresAt = new Date("2027-06-01T12:00:00.000Z")

/** Runs the immutable execution-ledger contract against one complete storage provider. */
export function runExecutionStorageContractSuite<TStorage extends ExecutionStorageContractStorage>(
  label: string,
  options: ExecutionStorageContractSuiteOptions<TStorage>
): void {
  const withStorage = async (body: (storage: TStorage) => Promise<void>): Promise<void> => {
    const storage = await options.createStorage()
    try {
      await body(storage)
    } finally {
      await options.cleanup?.(storage)
    }
  }

  describe(label, () => {
    test("round-trips every durable executor and authority shape", async () => {
      await withStorage(async (storage) => {
        await seedAuth(storage.auth)

        const records = [
          principalRequest({
            id: "principal-request",
            credential: { type: "session", id: "session-user" },
          }),
          principalRequest({
            id: "service-request",
            principal: { type: "serviceAccount", id: "service-one" },
            credential: { type: "accessToken", id: "token-service" },
          }),
          disabledRequest("disabled-request"),
          sharedAccessRequest("shared-access-request"),
          ...trustedPrimitiveKinds.map((kind) => trustedPrimitive(`${kind}-execution`, {}, kind)),
          agentExecution("agent-execution"),
          kernelExecution("kernel-execution"),
        ] as const

        for (const input of records) {
          const creationStartedAt = new Date()
          const created = await storage.executions.create(input)
          const { createdAt: persistedAt, ...persistedInput } = created
          expect(persistedInput).toEqual(input)
          expect(Number.isFinite(persistedAt.getTime())).toBe(true)
          expect(persistedAt.getTime()).toBeGreaterThanOrEqual(creationStartedAt.getTime())
          expect(
            await storage.executions.getById({ projectId: input.projectId, id: input.id })
          ).toEqual(created)
        }

        const first = await storage.executions.getById({ projectId, id: "principal-request" })
        if (!first || first.authorizationRef.type !== "principal") {
          throw new Error("Expected principal execution fixture")
        }
        const persisted = structuredClone(first)
        ;(first.authorizationRef.principal as { id: string }).id = "mutated"
        first.createdAt.setUTCFullYear(2000)
        expect(await storage.executions.getById({ projectId, id: first.id })).toEqual(persisted)
      })
    })

    test("keeps execution identity immutable and project-scoped", async () => {
      await withStorage(async (storage) => {
        const first = disabledRequest("shared-id")
        await storage.executions.create(first)

        await expect(storage.executions.create(first)).rejects.toMatchObject({
          code: "duplicate_execution",
        })

        const otherProject = disabledRequest("shared-id", "execution-contract-other")
        await expect(storage.executions.create(otherProject)).resolves.toMatchObject({
          projectId: otherProject.projectId,
        })
        expect(
          await storage.executions.getById({ projectId: "missing-project", id: first.id })
        ).toBeNull()

        const backdated = await storage.executions.create({
          ...disabledRequest("caller-timestamp"),
          createdAt: new Date("2000-01-01T00:00:00.000Z"),
        } as CreateExecutionInput)
        expect(backdated.createdAt.getUTCFullYear()).not.toBe(2000)
      })
    })

    test("admits exactly one concurrent create for an execution id", async () => {
      await withStorage(async (storage) => {
        const input = disabledRequest("concurrent-id")
        const results = await Promise.allSettled([
          storage.executions.create(input),
          storage.executions.create(input),
        ])

        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
        const [rejected] = results.filter((result) => result.status === "rejected")
        expect(rejected?.reason).toMatchObject({ code: "duplicate_execution" })
      })
    })

    test("rejects non-durable sources and executor-authority mismatches", async () => {
      await withStorage(async (storage) => {
        await seedAuth(storage.auth)

        const invalidInputs: readonly CreateExecutionInput[] = [
          {
            ...disabledRequest("queue-source"),
            source: { type: "queue", queue: "actions", jobId: "job-1" },
          } as unknown as CreateExecutionInput,
          {
            ...disabledRequest("wrong-request-source"),
            source: { type: "http", requestId: "different-request" },
          },
          {
            ...disabledRequest("principal-missing-requester"),
            authorizationRef: {
              type: "principal",
              principal: { type: "user", id: "user-one" },
            },
          },
          {
            ...sharedAccessRequest("shared-requester"),
            requestedBy: { type: "user", id: "user-one" },
          },
          {
            ...trustedPrimitive("untrusted-primitive"),
            authorizationRef: { type: "disabled" },
          },
          {
            ...agentExecution("user-agent"),
            authorizationRef: {
              type: "principal",
              principal: { type: "user", id: "user-one" },
            },
          },
          {
            ...kernelExecution("requested-kernel"),
            requestedBy: { type: "user", id: "user-one" },
          },
        ]

        for (const input of invalidInputs) {
          await expect(storage.executions.create(input)).rejects.toMatchObject({
            code: "invalid_input",
          })
        }
      })
    })

    test("requires every principal and verifies credential ownership", async () => {
      await withStorage(async (storage) => {
        await seedAuth(storage.auth)

        await expect(
          storage.executions.create(
            principalRequest({
              id: "missing-principal",
              principal: { type: "user", id: "unknown-user" },
            })
          )
        ).rejects.toMatchObject({ code: "missing_principal" })

        await expect(
          storage.executions.create(
            principalRequest({
              id: "missing-session",
              credential: { type: "session", id: "missing-session" },
            })
          )
        ).rejects.toMatchObject({ code: "missing_credential" })

        await expect(
          storage.executions.create(
            principalRequest({
              id: "wrong-session-owner",
              credential: { type: "session", id: "session-other" },
            })
          )
        ).rejects.toMatchObject({ code: "invalid_credential" })

        await expect(
          storage.executions.create({
            ...trustedPrimitive("missing-requester"),
            requestedBy: { type: "user", id: "unknown-user" },
          })
        ).rejects.toMatchObject({ code: "missing_principal" })
      })
    })

    test("requires children to preserve direct parent provenance", async () => {
      await withStorage(async (storage) => {
        await seedAuth(storage.auth)
        await storage.executions.create(principalRequest({ id: "parent" }))

        const validChild = trustedPrimitive("valid-child", {
          parentExecutionId: "parent",
          correlationId: "correlation-parent",
          source: { type: "execution", executionId: "parent" },
        })
        await expect(storage.executions.create(validChild)).resolves.toMatchObject({
          parentExecutionId: "parent",
        })

        const invalidChildren: readonly [CreateExecutionInput, string][] = [
          [
            trustedPrimitive("missing-parent", {
              parentExecutionId: "unknown-parent",
              source: { type: "execution", executionId: "unknown-parent" },
            }),
            "missing_parent_execution",
          ],
          [
            trustedPrimitive("wrong-correlation", {
              parentExecutionId: "parent",
              correlationId: "different-correlation",
              source: { type: "execution", executionId: "parent" },
            }),
            "invalid_parent_execution",
          ],
          [
            trustedPrimitive("wrong-requester", {
              parentExecutionId: "parent",
              requestedBy: { type: "user", id: "user-other" },
              source: { type: "execution", executionId: "parent" },
            }),
            "invalid_parent_execution",
          ],
        ]

        for (const [input, code] of invalidChildren) {
          await expect(storage.executions.create(input)).rejects.toMatchObject({ code })
        }
      })
    })

    test("participates in storage transactions and rollback", async () => {
      await withStorage(async (storage) => {
        await expect(
          storage.transaction(async (tx) => {
            await tx.executions.create(disabledRequest("rolled-back"))
            throw new Error("rollback")
          })
        ).rejects.toThrow("rollback")
        expect(await storage.executions.getById({ projectId, id: "rolled-back" })).toBeNull()

        await storage.transaction((tx) => tx.executions.create(disabledRequest("committed")))
        expect(await storage.executions.getById({ projectId, id: "committed" })).not.toBeNull()
      })
    })
  })
}

async function seedAuth(auth: AuthStorage): Promise<void> {
  await auth.users.create({
    id: "user-one",
    projectId,
    email: "one@example.com",
    createdAt,
    updatedAt: createdAt,
  })
  await auth.users.create({
    id: "user-other",
    projectId,
    email: "other@example.com",
    createdAt,
    updatedAt: createdAt,
  })
  await auth.serviceAccounts.create({
    id: "service-one",
    projectId,
    name: "Service one",
    createdAt,
    updatedAt: createdAt,
  })
  await auth.sessions.create({
    id: "session-user",
    projectId,
    userId: "user-one",
    strategyId: "contract",
    audience: "atlas",
    tokenHash: "session-user-hash",
    createdAt,
    expiresAt,
  })
  await auth.sessions.create({
    id: "session-other",
    projectId,
    userId: "user-other",
    strategyId: "contract",
    audience: "atlas",
    tokenHash: "session-other-hash",
    createdAt,
    expiresAt,
  })
  await auth.accessTokens.create({
    id: "token-service",
    projectId,
    name: "Service token",
    kind: "serviceAccount",
    subjectType: "serviceAccount",
    subjectId: "service-one",
    tokenHash: "service-token-hash",
    createdAt,
    expiresAt,
  })
}

function principalRequest(input: {
  readonly id: string
  readonly principal?: { readonly type: "user" | "serviceAccount"; readonly id: string }
  readonly credential?:
    | { readonly type: "session"; readonly id: string }
    | { readonly type: "accessToken"; readonly id: string }
}): CreateExecutionInput {
  const principal = input.principal ?? ({ type: "user", id: "user-one" } as const)
  return {
    id: input.id,
    projectId,
    requestedBy: principal,
    executor: { type: "request", requestId: `request-${input.id}` },
    source: { type: "http", requestId: `request-${input.id}` },
    correlationId: input.id === "parent" ? "correlation-parent" : `correlation-${input.id}`,
    authorizationRef: {
      type: "principal",
      principal,
      ...(input.credential === undefined ? {} : { credential: input.credential }),
    },
  }
}

function disabledRequest(id: string, inputProjectId = projectId): CreateExecutionInput {
  return {
    id,
    projectId: inputProjectId,
    executor: { type: "request", requestId: `request-${id}` },
    source: { type: "http", requestId: `request-${id}` },
    correlationId: `correlation-${id}`,
    authorizationRef: { type: "disabled" },
  }
}

function sharedAccessRequest(id: string): CreateExecutionInput {
  return {
    id,
    projectId,
    executor: { type: "request", requestId: `request-${id}` },
    source: { type: "http", requestId: `request-${id}` },
    correlationId: `correlation-${id}`,
    authorizationRef: {
      type: "sharedAccess",
      grantId: "share-grant-one",
      sessionId: "share-session-one",
    },
  }
}

function trustedPrimitive(
  id: string,
  overrides: Partial<
    Pick<CreateExecutionInput, "correlationId" | "parentExecutionId" | "requestedBy" | "source">
  > = {},
  kind: TrustedPrimitiveKind = "action"
): CreateExecutionInput {
  const runId = `run-${id}`
  return {
    id,
    projectId,
    requestedBy: { type: "user", id: "user-one" },
    executor: { type: "primitive", kind, runId },
    source: trustedPrimitiveSource(kind, id),
    correlationId: `correlation-${id}`,
    authorizationRef: {
      type: "trustedPrimitive",
      primitive: { kind, id: `contract.${kind}`, runId },
    },
    ...overrides,
  }
}

function trustedPrimitiveSource(
  kind: TrustedPrimitiveKind,
  id: string
): CreateExecutionInput["source"] {
  if (kind === "pipeline") {
    return { type: "schedule", eventId: `schedule-event-${id}` }
  }
  if (kind === "webhook") {
    return { type: "webhook", deliveryId: `delivery-${id}` }
  }
  return { type: "event", eventId: `event-${id}` }
}

const trustedPrimitiveKinds = [
  "action",
  "pipeline",
  "projection",
  "rule",
  "sync",
  "webhook",
  "workflow",
] as const satisfies readonly TrustedPrimitiveKind[]

function agentExecution(id: string): CreateExecutionInput {
  return {
    id,
    projectId,
    requestedBy: { type: "user", id: "user-one" },
    executor: { type: "agent", runId: `run-${id}` },
    source: { type: "event", eventId: `event-${id}` },
    correlationId: `correlation-${id}`,
    authorizationRef: {
      type: "principal",
      principal: { type: "serviceAccount", id: "service-one" },
    },
  }
}

function kernelExecution(id: string): CreateExecutionInput {
  const operation = { type: "ontology.recover", recoveryId: `recovery-${id}` } as const
  return {
    id,
    projectId,
    executor: { type: "kernel", operation },
    source: { type: "event", eventId: `event-${id}` },
    correlationId: `correlation-${id}`,
    authorizationRef: { type: "kernel", operation },
  }
}
