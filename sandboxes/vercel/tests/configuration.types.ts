import {
  type CreateSixbOptions,
  createSixb,
  type ExecutionScope,
  optional,
  param,
  type SixbHostView,
} from "@sixb/core"
import type { SandboxFactory } from "@sixb/core/sandboxes"
import { VercelSandboxFactory, type VercelSandboxFactoryOptions } from "../src"

// Regression proof: remove the options' `in out` annotation, rebuild types, then typecheck tests.
function checkAnnotatedOptions(options: VercelSandboxFactoryOptions) {
  const factory: SandboxFactory = new VercelSandboxFactory(options)
  const params = { clientId: param("string") }
  const configured: VercelSandboxFactoryOptions<typeof params> = {
    params,
    resolve: ({ params }) => ({ source: { type: "git", url: params.clientId } }),
  }
  const typed: SandboxFactory<typeof params> = new VercelSandboxFactory(configured)
  // @ts-expect-error a parameterized recipe cannot become an untyped resolver
  const widened: VercelSandboxFactoryOptions = configured
  void [factory, typed, widened]
}
void checkAnnotatedOptions

// Regression proof: erase TParams on the factory or createSixb; the expected errors disappear.
async function checkConfiguration(options: CreateSixbOptions, scope: ExecutionScope) {
  const sandboxes = new VercelSandboxFactory({
    params: { clientId: param("string"), branch: optional(param("string")) },
    resolve: ({ params }) => {
      const clientId: string = params.clientId
      const branch: string | undefined = params.branch
      // @ts-expect-error the factory preserves schema inference
      const invalid: number = params.clientId
      void invalid
      return { source: { type: "git", url: clientId, revision: branch } }
    },
  })
  const host = await createSixb({ ...options, sandboxes })
  host.withScope(scope).agent.threads.create({ sandbox: { clientId: "acme" } })
  // @ts-expect-error required parameter
  host.withScope(scope).agent.threads.create({ sandbox: {} })
  // @ts-expect-error wrong parameter type
  host.withScope(scope).agent.threads.create({ sandbox: { clientId: 42 } })
  // @ts-expect-error undeclared parameter
  host.withScope(scope).agent.threads.create({ sandbox: { clientId: "acme", extra: true } })

  const staticHost = await createSixb({
    ...options,
    sandboxes: new VercelSandboxFactory({ setup: [] }),
  })
  staticHost.withScope(scope).agent.threads.create({ sandbox: {} })
  // @ts-expect-error static environments have no parameters
  staticHost.withScope(scope).agent.threads.create({ sandbox: { extra: true } })

  const inferred: SixbHostView = host
  void inferred
}
void checkConfiguration
