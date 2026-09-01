import { describe, expect, test } from "bun:test"
import { createAuthorizedObjectReader } from "../src/execution/authorized-object-reader"
import { createTestingScope } from "../src/execution/scopes"
import { OntologyRegistry } from "../src/ontology"
import { SixbHost } from "../src/runtime/host"
import { createBoundSixb, type SixbDependencies } from "../src/runtime/sixb"
import type { SixbRuntimeContext } from "../src/runtime/types"
import { InMemoryStorage } from "../src/storage"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const projectId = "authorized-object-reader-runtime"

describe("AuthorizedObjectReader runtime binding", () => {
  test("SixbHost creates the bound reader before composing the SDK", () => {
    const host = new SixbHost({ id: projectId, ontology: [], ...createTestRuntimeDeps() })
    const scope = createTestingScope({ projectId, executionId: "execution-1" })

    expect(host.withScope(scope).execution).toBe(scope.execution)
  })

  test("SixbHost captures an accessor-backed scope once before composition", () => {
    const host = new SixbHost({ id: projectId, ontology: [], ...createTestRuntimeDeps() })
    const source = createTestingScope({ projectId, executionId: "execution-accessor" })
    let executionReads = 0
    let authorizationReads = 0
    const accessorScope = Object.defineProperties(
      {},
      {
        execution: {
          enumerable: true,
          get: () => {
            executionReads += 1
            return source.execution
          },
        },
        authorization: {
          enumerable: true,
          get: () => {
            authorizationReads += 1
            return source.authorization
          },
        },
      }
    ) as typeof source

    expect(host.withScope(accessorScope).execution).toBe(source.execution)
    expect(executionReads).toBe(1)
    expect(authorizationReads).toBe(1)
  })

  test("createBoundSixb rejects a reader from another exact authority", () => {
    const ontology = new OntologyRegistry({ sources: [] })
    const storage = new InMemoryStorage()
    const boundScope = createTestingScope({ projectId, executionId: "execution-bound" })
    const foreignScope = createTestingScope({ projectId, executionId: "execution-foreign" })
    const foreignReader = createAuthorizedObjectReader({
      scope: foreignScope,
      ontology,
      objectStorage: storage.objects,
    })
    const runtime = {
      projectId,
      runtimeAuthorization: boundScope.authorization,
      objectReader: foreignReader,
    } as SixbRuntimeContext

    expect(() =>
      createBoundSixb<readonly []>(runtime, {} as SixbDependencies, boundScope.execution)
    ).toThrow("AuthorizedObjectReader is not bound to this exact execution authority")
  })
})
