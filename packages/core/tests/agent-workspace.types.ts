import type { CreateSixbOptions, ExecutionScope } from "../src"
import { createSixb, optional, param, SixbHost } from "../src"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// Regression proof: erase the workspace type parameter from SixbHost.withScope or createSixb.
function checkHost(scope: ExecutionScope) {
  const host = new SixbHost({
    ...createTestRuntimeDeps(),
    ontology: [],
    agentWorkspace: {
      params: { clientId: param("string"), branch: optional(param("string")) },
      resolve: ({ params }) => {
        const clientId: string = params.clientId
        const branch: string | undefined = params.branch
        // @ts-expect-error inferred from the configured param schema
        const wrong: number = params.clientId
        void wrong
        return { source: { type: "git", url: clientId, revision: branch } }
      },
    },
  })
  const sixb = host.withScope(scope)
  sixb.agent.threads.create({ workspace: { params: { clientId: "acme" } } })
  // @ts-expect-error clientId is required
  sixb.agent.threads.create({ workspace: { params: {} } })
  // @ts-expect-error clientId must be a string
  sixb.agent.threads.create({ workspace: { params: { clientId: 42 } } })
  // @ts-expect-error unknown parameters are rejected
  sixb.agent.threads.create({ workspace: { params: { clientId: "acme", other: true } } })
}

async function checkDiscoveredHost(options: CreateSixbOptions, scope: ExecutionScope) {
  const host = await createSixb({
    ...options,
    agentWorkspace: {
      params: { clientId: param("string") },
      resolve: ({ params }) => ({ source: { type: "git", url: params.clientId } }),
    },
  })
  // @ts-expect-error createSixb must preserve the workspace parameter schema too
  host.withScope(scope).agent.threads.create({ workspace: { params: { clientId: 42 } } })
}

void checkHost
void checkDiscoveredHost
