import {
  type AzureAIFoundryChatOptions,
  type AzureAIFoundryMessagesOptions,
  type AzureAIFoundryModelOptions,
  type AzureAIFoundryOptions,
  createAzureAIFoundry as create,
  type FoundryProtocol,
} from "../src"

export type * from "../src"

type Identity = { publisher?: string; modelName?: string; modelVersion?: string }
type FixtureOptions<T> = T & { identity?: Identity }

// Protocol fixtures still exercise mandatory deployment resolution, with synthetic Azure
// records and an empty public catalog. `identity` describes the mock Azure response only.
export function createAzureAIFoundry(options: AzureAIFoundryOptions) {
  const records = new Map<string, unknown>()
  const provider = create({
    ...options,
    catalog: options.catalog ?? { fetch: async () => Response.json({ azure: { models: {} } }) },
    fetch: async (url, init) => {
      if (new URL(String(url)).pathname.endsWith("/deployments"))
        return Response.json({ value: [...records.values()] })
      if (!options.fetch) throw new Error("Fixture inference fetch is not configured")
      return options.fetch(url, init)
    },
  })
  function register<T>(name: string, input: FixtureOptions<T>, protocol: FoundryProtocol) {
    const { identity, ...binding } = input
    if (!records.has(name))
      records.set(name, {
        type: "ModelDeployment",
        name,
        modelName: identity?.modelName ?? name,
        modelVersion: identity?.modelVersion ?? "1",
        modelPublisher: identity?.publisher ?? "Fixture",
        capabilities: { [protocol === "chat" ? "chat_completion" : protocol]: "true" },
        sku: { name: "GlobalStandard" },
      })
    return binding as T
  }
  return Object.assign(
    (name: string, input: FixtureOptions<AzureAIFoundryModelOptions> = {}) =>
      provider(name, register(name, input, "responses")),
    {
      providerId: provider.providerId,
      catalog: provider.catalog,
      responses: (name: string, input: FixtureOptions<AzureAIFoundryModelOptions> = {}) =>
        provider.responses(name, register(name, input, "responses")),
      chat: (name: string, input: FixtureOptions<AzureAIFoundryChatOptions> = {}) =>
        provider.chat(name, register(name, input, "chat")),
      messages: (name: string, input: FixtureOptions<AzureAIFoundryMessagesOptions> = {}) =>
        provider.messages(name, register(name, input, "messages")),
    }
  )
}
