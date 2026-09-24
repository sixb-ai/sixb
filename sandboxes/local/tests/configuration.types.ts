import {
  type CreateSixbOptions,
  createSixb,
  type ExecutionScope,
  optional,
  param,
} from "@sixb/core"
import type { SandboxFactory } from "@sixb/core/sandboxes"
import { LocalSandboxFactory, type LocalSandboxFactoryOptions } from "../src"

// Keep annotated options usable without losing inference for inline or explicitly typed recipes.
// Regression proof: remove the options' `in out` annotation, rebuild types, then typecheck tests.
async function checkConfiguration(
  options: CreateSixbOptions,
  providerOptions: LocalSandboxFactoryOptions,
  scope: ExecutionScope
) {
  const factory: SandboxFactory = new LocalSandboxFactory(providerOptions)
  void factory

  const params = { clientId: param("string"), branch: optional(param("string")) }
  const configured: LocalSandboxFactoryOptions<typeof params> = {
    ...providerOptions,
    params,
    resolve: ({ params }) => {
      const clientId: string = params.clientId
      const branch: string | undefined = params.branch
      // @ts-expect-error callback parameters retain their schema types
      const invalid: number = params.clientId
      void invalid
      return { source: { type: "git", url: clientId, revision: branch } }
    },
  }
  const sandboxes = new LocalSandboxFactory(configured)
  const inferred: SandboxFactory<typeof params> = new LocalSandboxFactory({
    ...providerOptions,
    params,
    resolve: ({ params }) => {
      // @ts-expect-error inline resolvers retain parameter types too
      const invalid: number = params.clientId
      void invalid
      return { source: { type: "git", url: params.clientId, revision: params.branch } }
    },
  })
  void inferred
  // @ts-expect-error a parameterized recipe cannot become an untyped resolver
  const widened: LocalSandboxFactoryOptions = configured
  void widened

  const host = await createSixb({ ...options, sandboxes })
  host.withScope(scope).agent.threads.create({ sandbox: { clientId: "acme" } })
  // @ts-expect-error required parameter
  host.withScope(scope).agent.threads.create({ sandbox: {} })
  // @ts-expect-error wrong parameter type
  host.withScope(scope).agent.threads.create({ sandbox: { clientId: 42 } })
  // @ts-expect-error undeclared parameter
  host.withScope(scope).agent.threads.create({ sandbox: { clientId: "acme", extra: true } })
}
void checkConfiguration
