import type {
  Sandbox,
  SandboxEnvironment,
  SandboxFactory,
  SandboxRequestCredential,
  SandboxSessionOptions,
  SandboxSourceAuth,
} from "@sixb/core"
import type { SandboxNetworkPolicy } from "@sixb/core/sandboxes"
import type { AgentWorkspacePromptContext } from "./agent-prompt"
import { sandboxError } from "./sandbox-operation"
import { WorkspaceAuthSession, type WorkspaceGrant } from "./workspace-auth"
import { workspaceNetwork } from "./workspace-network"

interface WorkspaceAccessInput {
  readonly recipe: SandboxEnvironment
  /** The factory's source authentication, when it declares one. */
  readonly auth?: SandboxSourceAuth
  readonly factory: Pick<SandboxFactory, "supportsRequestCredentials">
  readonly apiOrigin: string
  readonly signal: AbortSignal
  readonly assertOwner: () => Promise<void>
  readonly onAuthFailure: (error: Error) => void
}

/**
 * One run's access to a recipe's source: the session network, the guest environment and the
 * host-side credentials. Credentials never enter workspace state, guest files or env.
 */
export class WorkspaceAccess {
  readonly sourceUrl: URL | undefined
  private credentialOrigins: readonly string[] = []
  private network: SandboxNetworkPolicy
  private env: Readonly<Record<string, string>> | undefined
  private auth: WorkspaceAuthSession | undefined
  private credentials: readonly SandboxRequestCredential[] | undefined

  constructor(private readonly input: WorkspaceAccessInput) {
    this.sourceUrl = input.recipe.source ? new URL(input.recipe.source.url) : undefined
    this.env = input.recipe.env

    // Reject an unusable policy before any token is issued. Authorization only adds credential
    // origins to the network, so it cannot make this check pass or fail.
    this.network = this.resolveNetwork()
  }

  /** Session defaults for creation and resume. */
  get sessionOptions(): SandboxSessionOptions {
    return { env: this.env, network: this.network }
  }

  /** The first grant's requests; absent without authentication. */
  get requestCredentials(): readonly SandboxRequestCredential[] | undefined {
    return this.credentials
  }

  /**
   * Issue the first grant when the source is authenticated. Write access requires
   * authentication, and authentication a provider injecting credentials outside the guest.
   */
  async authorize(): Promise<void> {
    const { recipe, auth, factory, signal, assertOwner, onAuthFailure } = this.input
    if (!recipe.source || !auth) {
      if (recipe.source?.access === "write") {
        throw sandboxError("write access requires source authentication.")
      }
      return
    }
    if (!factory.supportsRequestCredentials) {
      throw sandboxError("authentication requires a provider with secure credential injection.")
    }

    this.auth = new WorkspaceAuthSession({
      auth,
      source: recipe.source,
      signal,
      assertOwner,
      onFailure: onAuthFailure,
    })
    let grant: WorkspaceGrant
    try {
      grant = await this.auth.prepare()
    } catch (error) {
      await this.closeAfterFailure("before acquisition")
      throw error
    }

    // Credential origins are known only now; the network opens every one of them, so the
    // provider receives the grant's requests as issued.
    this.credentialOrigins = grant.requests.map((request) => request.origin)
    this.network = this.resolveNetwork()
    this.env = { ...grant.env, ...recipe.env }
    this.credentials = grant.requests
  }

  /** Start renewing on the session the provider applied the first grant to. */
  attach(session: Sandbox): void {
    this.auth?.attach(session)
  }

  /** Remove injection and revoke every grant. Memoized; rejects when either is unconfirmed. */
  async close(): Promise<void> {
    await this.auth?.close()
  }

  /** Close on a path that already fails; the original error is the one to report. */
  async closeAfterFailure(phase: string): Promise<void> {
    try {
      await this.close()
    } catch {
      console.error(`[SixbAgentWorker] Sandbox authentication cleanup failed ${phase}.`)
    }
  }

  /** Only non-secret facts about the prepared session, for the system prompt. */
  promptContext(session: Sandbox): AgentWorkspacePromptContext {
    const { source } = this.input.recipe
    return {
      workingDirectory: session.workingDirectory,
      ...(source && this.sourceUrl
        ? {
            source: {
              type: source.type,
              url: this.sourceUrl.href,
              ...(this.auth ? { authenticatedAccess: source.access ?? "read" } : {}),
            },
          }
        : {}),
    }
  }

  private resolveNetwork(): SandboxNetworkPolicy {
    return workspaceNetwork(
      this.input.recipe.network,
      this.input.apiOrigin,
      this.sourceUrl?.origin,
      this.credentialOrigins
    )
  }
}
