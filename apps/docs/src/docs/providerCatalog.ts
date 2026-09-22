export interface ProviderEntry {
  readonly name: string
  readonly description: string
  readonly package: string
  readonly href: string
  readonly icon: string | null
  readonly environment?: string
}

export const providerCatalog: Record<"models" | "sandboxes", readonly ProviderEntry[]> = {
  models: [
    {
      name: "Anthropic",
      description: "Connect directly to Anthropic models.",
      package: "@sixb/anthropic",
      href: "https://github.com/sixb-ai/sixb/tree/main/models/anthropic#readme",
      icon: "anthropic.svg",
    },
    {
      name: "Azure AI Foundry",
      description: "Use models deployed through Azure AI Foundry.",
      package: "@sixb/azure-ai-foundry",
      href: "https://github.com/sixb-ai/sixb/tree/main/models/azure-ai-foundry#readme",
      icon: "azure.svg",
    },
    {
      name: "Vercel AI Gateway",
      description: "Access models from multiple vendors through one gateway.",
      package: "@sixb/vercel-ai-gateway",
      href: "https://github.com/sixb-ai/sixb/tree/main/models/vercel-ai-gateway#readme",
      icon: "vercel.svg",
    },
  ],
  sandboxes: [
    {
      name: "Local",
      description: "Run tools on your development machine.",
      package: "@sixb/sandboxes-local",
      href: "https://github.com/sixb-ai/sixb/tree/main/sandboxes/local#readme",
      icon: null,
      environment: "Local",
    },
    {
      name: "Apple Container",
      description: "Run tools in containers on Apple silicon Macs.",
      package: "@sixb/sandboxes-apple-container",
      href: "https://github.com/sixb-ai/sixb/tree/main/sandboxes/apple-container#readme",
      icon: "apple.svg",
      environment: "Local",
    },
    {
      name: "smolvm",
      description: "Run tools in isolated microVMs on your own host.",
      package: "@sixb/sandboxes-smolvm",
      href: "https://github.com/sixb-ai/sixb/tree/main/sandboxes/smolvm#readme",
      icon: null,
      environment: "Self-hosted",
    },
    {
      name: "Vercel",
      description: "Run tools in managed, hosted sandboxes.",
      package: "@sixb/sandboxes-vercel",
      href: "https://github.com/sixb-ai/sixb/tree/main/sandboxes/vercel#readme",
      icon: "vercel.svg",
      environment: "Hosted",
    },
    {
      name: "Azure",
      description: "Run tools in Azure Container Apps sandboxes. Available in preview.",
      package: "@sixb/sandboxes-azure",
      href: "https://github.com/sixb-ai/sixb/tree/main/sandboxes/azure#readme",
      icon: "azure.svg",
      environment: "Hosted · Preview",
    },
  ],
}
