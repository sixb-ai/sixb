import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ModelInfo,
  type Options,
  type Query,
  query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import {
  defineLanguageModel,
  defineLanguageModelLabel,
  defineModelRateCard,
  estimateModelReservation,
  isJsonObject,
  type JsonObject,
  type LanguageModel,
  type LanguageModelDefinition,
  type LanguageModelDefinitionCatalog,
  type LanguageModelLabel,
  type LanguageModelProvider,
  type LanguageModelRequest,
  type LanguageModelStream,
  type LanguageModelStreamEvent,
  MODEL_REASONING_EFFORTS,
  MODEL_REASONING_LEVELS,
  type ModelCapabilities,
  ModelCatalogUnavailableError,
  type ModelCostEstimator,
  ModelProviderError,
  type ModelRateCard,
  type ModelReasoning,
  type ModelReasoningCapabilities,
  type ModelReasoningEffort,
  type ModelReasoningLevel,
  modelReasoningSupportIssue,
  rateModelCall,
  UnsupportedModelFeatureError,
} from "@sixb/core/models"
import { ClaudeCodeStream } from "./stream"
import { sixbToolServer, TOOL_PREFIX } from "./tools"
import { type ClaudeCodeSessionState, ERROR_PREFIX, PROVIDER_ID, planTurn } from "./turn"

const CATALOG_TTL_MS = 60 * 60 * 1_000
const INSPECT_TIMEOUT_MS = 30_000
const ANTHROPIC = { id: "anthropic", name: "Anthropic" } as const
/** How starting a Claude Code that is not there fails. */
const MISSING_EXECUTABLE = /ENOENT|not found/i

/**
 * Claude Code adds context about its own process to every conversation, with no way to leave it
 * out: where it runs, a scratchpad of its own, and the email of the account it is signed in with.
 */
const RELAY_NOTE = [
  "Claude Code relays this conversation, and adds context about its own process: an",
  '"# Environment" section with its working directory, platform and scratchpad, and the email of',
  "the account it is signed in with. That context describes the relay, not where your tools run",
  "or who you work for: the instructions that follow say that.",
].join(" ")

/** What every model reached through Claude Code takes, whatever its catalog entry says. */
const CAPABILITIES: ModelCapabilities = {
  inputMediaTypes: ["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"],
  localTools: true,
  parallelToolCalls: true,
  nativeStructuredOutput: true,
  providerExecutedTools: false,
}

/**
 * Claude Code signs in as whoever is signed in where it runs. Where nobody signs in to it, such as
 * the server the project's agent worker runs on, it reads `CLAUDE_CODE_OAUTH_TOKEN`: a token from
 * `claude setup-token`.
 */
/**
 * A Claude plan bills by subscription, not by call: each call costs the project nothing, so cost
 * limits admit it and token limits still count it.
 */
const RATE_CARD: ModelRateCard = defineModelRateCard({
  currency: "USD",
  input: "0",
  output: "0",
  cacheReadInput: "0",
  cacheWriteInput: "0",
  cacheWriteInput5m: "0",
  cacheWriteInput1h: "0",
})
const COST_ESTIMATOR: ModelCostEstimator = {
  estimateReservation: (tokens) => estimateModelReservation({ ...tokens, rateCard: RATE_CARD }),
  estimate: ({ usage }) => rateModelCall({ usage, rateCard: RATE_CARD }),
}

export interface ClaudeCodeOptions {
  /** The Claude Code executable to run, such as the `claude` on your PATH. Defaults to the SDK's. */
  readonly executable?: string
  /** Definitions supplied here override matching entries from Claude Code's model list. */
  readonly models?: readonly LanguageModelDefinition[]
  /**
   * Refuse every call but one a computer makes for a turn it runs, so the project's own processes
   * never start Claude Code: each person's turns use the Claude Code signed in on their computer.
   * The model list is then the definitions supplied in `models`.
   */
  readonly computersOnly?: boolean
}

export interface ClaudeCodeModelOptions extends LanguageModelLabel {
  /** Reasoning Sixb applies when this model runs without an explicit choice. */
  readonly reasoning?: ModelReasoningLevel
  readonly capabilities?: ModelCapabilities
}

export interface ClaudeCodeCatalog extends LanguageModelDefinitionCatalog {
  refresh(): Promise<readonly LanguageModelDefinition[]>
}

export interface ClaudeCodeProvider extends LanguageModelProvider {
  (modelId: string, options?: ClaudeCodeModelOptions): LanguageModel
  readonly providerId: typeof PROVIDER_ID
  readonly catalog: ClaudeCodeCatalog
}

/**
 * Claude through the Claude Code on this computer, signed in as you, so a Claude subscription pays
 * for the calls. Sixb keeps running the Agent: its prompt, its tools and its loop. Claude Code only
 * answers, without its own tools, settings or MCP servers.
 */
export function createClaudeCode(options: ClaudeCodeOptions = {}): ClaudeCodeProvider {
  if (options.executable !== undefined && !options.executable.trim()) {
    throw new TypeError(`${ERROR_PREFIX} executable must not be empty.`)
  }

  const runtime = new ClaudeCodeRuntime(options)
  const configured = configuredModelDefinitions(options.models ?? [])
  const catalog = new ClaudeCodeModelCatalog(runtime, configured)
  const model = (modelId: string, modelOptions: ClaudeCodeModelOptions = {}) => {
    if (!modelId.trim()) throw new TypeError(`${ERROR_PREFIX} Model id must not be empty.`)
    return new ClaudeCodeLanguageModel(
      runtime,
      catalog,
      modelId,
      structuredClone(modelOptions),
      configured.get(modelId)
    )
  }

  return Object.assign(model, { providerId: PROVIDER_ID as typeof PROVIDER_ID, catalog })
}

export const claudeCode: ClaudeCodeProvider = createClaudeCode()

/**
 * The folder every query runs Claude Code in, so that its sessions are filed together under
 * `~/.claude/projects`.
 */
const CWD = join(tmpdir(), "sixb-claude-code")

/** How every query starts Claude Code. */
class ClaudeCodeRuntime {
  constructor(private readonly options: ClaudeCodeOptions) {}

  get computersOnly(): boolean {
    return this.options.computersOnly === true
  }

  async queryOptions(): Promise<Options> {
    await mkdir(CWD, { recursive: true })

    return {
      cwd: CWD,
      env: environment(),
      ...(this.options.executable === undefined
        ? {}
        : { pathToClaudeCodeExecutable: this.options.executable }),
      // Sixb's prompt and tools only: none of Claude Code's tools, nor the user's settings, CLAUDE.md
      // files, skills or MCP servers.
      tools: [],
      settingSources: [],
      skills: [],
      strictMcpConfig: true,
    }
  }

  /** Asks a Claude Code that is sent nothing: it answers control requests without a turn. */
  async inspect<T>(model: string | undefined, ask: (session: Query) => Promise<T>): Promise<T> {
    const abort = new AbortController()
    let release = () => {}
    const idle = new Promise<void>((resolve) => {
      release = resolve
    })
    const session = query({
      prompt: waitFor(idle),
      options: {
        ...(await this.queryOptions()),
        abortController: abort,
        ...(model === undefined ? {} : { model }),
      },
    })

    try {
      return await Promise.race([
        ask(session),
        rejectOnAbort(AbortSignal.timeout(INSPECT_TIMEOUT_MS)),
      ])
    } finally {
      release()
      abort.abort()
      session.close()
    }
  }
}

/**
 * Left out of the environment Claude Code inherits. The Anthropic keys another provider of the
 * project may use: Claude Code would bill one ahead of its sign-in. And what a Claude Code session
 * exports to the commands it runs, such as `sixb dev` started from one: a Claude Code that inherits
 * its session id, messaging socket and token acts as part of that session.
 */
const WITHHELD_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_DESKTOP_APP_VERSION",
  "CLAUDE_EFFORT",
  "CLAUDE_PID",
  "CLAUDE_AGENT_SDK_VERSION",
]

/** The environment Claude Code runs with: this process's, without {@link WITHHELD_ENV}. */
export function environment(
  inherited: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string | undefined> {
  const env = { ...inherited }
  for (const name of WITHHELD_ENV) delete env[name]
  return { ...env, CLAUDE_AGENT_SDK_CLIENT_APP: "sixb" }
}

function configuredModelDefinitions(
  definitions: readonly LanguageModelDefinition[]
): ReadonlyMap<string, LanguageModelDefinition> {
  const configured = new Map<string, LanguageModelDefinition>()
  for (const input of definitions) {
    const definition = defineLanguageModel(input)
    if (definition.providerId !== PROVIDER_ID) {
      throw new TypeError(
        `${ERROR_PREFIX} Supplied model '${definition.modelId}' must use providerId '${PROVIDER_ID}'.`
      )
    }
    if (configured.has(definition.modelId)) {
      throw new TypeError(`${ERROR_PREFIX} Duplicate model '${definition.modelId}'.`)
    }
    configured.set(definition.modelId, definition)
  }
  return configured
}

/**
 * The models Claude Code offers the account it is signed in with, as it lists them itself. A model
 * looked up for a call also carries its context window, which the list does not have.
 */
class ClaudeCodeModelCatalog implements ClaudeCodeCatalog {
  private loadPromise: Promise<readonly LanguageModelDefinition[]> | undefined
  private loadedAt = 0
  private readonly windows = new Map<
    string,
    { readonly window: Promise<number | undefined>; readonly loadedAt: number }
  >()

  constructor(
    private readonly runtime: ClaudeCodeRuntime,
    private readonly supplied: ReadonlyMap<string, LanguageModelDefinition>
  ) {}

  async get(modelId: string): Promise<LanguageModelDefinition | undefined> {
    const definition =
      this.supplied.get(modelId) ?? (await this.load()).find((model) => model.modelId === modelId)
    if (
      definition === undefined ||
      definition.contextWindow !== undefined ||
      this.runtime.computersOnly
    ) {
      return definition
    }

    const contextWindow = await this.contextWindow(modelId)
    return contextWindow === undefined
      ? definition
      : defineLanguageModel({ ...definition, contextWindow })
  }

  list(): Promise<readonly LanguageModelDefinition[]> {
    return this.load()
  }

  refresh(): Promise<readonly LanguageModelDefinition[]> {
    this.loadPromise = undefined
    this.loadedAt = 0
    this.windows.clear()
    return this.load()
  }

  private load(): Promise<readonly LanguageModelDefinition[]> {
    if (this.loadPromise && this.loadedAt !== 0 && Date.now() - this.loadedAt >= CATALOG_TTL_MS) {
      this.loadPromise = undefined
      this.loadedAt = 0
    }
    this.loadPromise ??= this.fetchDefinitions()
      .then((definitions) => {
        this.loadedAt = Date.now()
        return definitions
      })
      .catch((error) => {
        this.loadPromise = undefined
        throw error
      })
    return this.loadPromise
  }

  private async fetchDefinitions(): Promise<readonly LanguageModelDefinition[]> {
    // Claude Code may not even be installed where the project runs.
    if (this.runtime.computersOnly) return [...this.supplied.values()]

    try {
      const models = await this.runtime.inspect(undefined, (session) => session.supportedModels())
      const listed = models
        // "default" names whichever model the account defaults to, which another entry also lists.
        .filter((info) => info.value !== "default")
        .map((info) => this.supplied.get(info.value) ?? modelInfoDefinition(info))
      const listedIds = new Set(listed.map((definition) => definition.modelId))

      return [...listed, ...[...this.supplied.values()].filter((d) => !listedIds.has(d.modelId))]
    } catch (error) {
      throw new ModelCatalogUnavailableError(
        `${ERROR_PREFIX} Claude Code could not list its models: ${errorMessage(error)}`,
        { cause: error }
      )
    }
  }

  /**
   * The window Claude Code sizes the model's context to for this account, which can be larger than
   * the model's default. Unknown when Claude Code cannot say: Sixb then assumes one.
   */
  private contextWindow(modelId: string): Promise<number | undefined> {
    const cached = this.windows.get(modelId)
    if (cached && Date.now() - cached.loadedAt < CATALOG_TTL_MS) return cached.window

    const window = this.runtime
      .inspect(modelId, async (session) => {
        // A summary answers from what Claude Code knows of the model, without a model call.
        const { rawMaxTokens } = await session.getContextUsage({ detail: "summary" })
        return Number.isSafeInteger(rawMaxTokens) && rawMaxTokens > 0 ? rawMaxTokens : undefined
      })
      .catch(() => {
        this.windows.delete(modelId)
        return undefined
      })
    this.windows.set(modelId, { window, loadedAt: Date.now() })
    return window
  }
}

export function modelInfoDefinition(info: ModelInfo): LanguageModelDefinition {
  const reasoning = modelInfoReasoning(info)

  return defineLanguageModel({
    kind: "language",
    providerId: PROVIDER_ID,
    modelId: info.value,
    ...(info.displayName.trim() ? { name: info.displayName.trim() } : {}),
    ...(info.description.trim() ? { description: info.description.trim() } : {}),
    publisher: ANTHROPIC,
    via: "Claude Code",
    capabilities: { ...CAPABILITIES, ...(reasoning === undefined ? {} : { reasoning }) },
  })
}

function modelInfoReasoning(info: ModelInfo): ModelReasoningCapabilities | undefined {
  const efforts = (info.supportsEffort === true ? (info.supportedEffortLevels ?? []) : []).filter(
    isReasoningEffort
  )
  // Newer than the SDK's types: Claude Code says whether a model's thinking can be turned off.
  const thinkingOff: unknown = Reflect.get(info, "supportsThinkingOff")
  if (efforts.length === 0 && typeof thinkingOff !== "boolean") return undefined

  return {
    canDisable: thinkingOff === true,
    ...(efforts.length === 0 ? {} : { efforts }),
  }
}

/** Names for the aliases Claude Code resolves to its latest models, before its list is read. */
const ALIAS_NAMES: Readonly<Record<string, string>> = {
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  fable: "Fable",
}

function fallbackDefinition(modelId: string): LanguageModelDefinition {
  const name = ALIAS_NAMES[modelId]
  return defineLanguageModel({
    kind: "language",
    providerId: PROVIDER_ID,
    modelId,
    ...(name === undefined ? {} : { name }),
    publisher: ANTHROPIC,
    via: "Claude Code",
    capabilities: CAPABILITIES,
  })
}

class ClaudeCodeLanguageModel implements LanguageModel {
  readonly providerId = PROVIDER_ID
  readonly modelId: string
  readonly definition: LanguageModelDefinition
  readonly defaultReasoning?: ModelReasoningLevel
  readonly rateCard = RATE_CARD
  readonly costEstimator = COST_ESTIMATOR
  /** A computer that runs a turn calls Claude Code itself, signed in as whoever runs it there. */
  readonly runsOnComputers = true

  constructor(
    private readonly runtime: ClaudeCodeRuntime,
    private readonly catalog: ClaudeCodeCatalog,
    modelId: string,
    private readonly options: ClaudeCodeModelOptions,
    private readonly configured: LanguageModelDefinition | undefined,
    private readonly resolved = false
  ) {
    this.modelId = modelId
    if (options.reasoning !== undefined) {
      if (!(MODEL_REASONING_LEVELS as readonly unknown[]).includes(options.reasoning)) {
        throw new TypeError(
          `${ERROR_PREFIX} reasoning must be one of: ${MODEL_REASONING_LEVELS.join(", ")}.`
        )
      }
      this.defaultReasoning = options.reasoning
    }
    this.definition = defineLanguageModel({
      ...(configured ?? fallbackDefinition(modelId)),
      ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
      ...defineLanguageModelLabel(options, ERROR_PREFIX),
    })
  }

  async resolve(options?: { readonly offline?: boolean }): Promise<LanguageModel> {
    if (this.resolved) return this
    const definition =
      options?.offline === true ? this.configured : await this.catalog.get(this.modelId)

    return new ClaudeCodeLanguageModel(
      this.runtime,
      this.catalog,
      this.modelId,
      this.options,
      definition ?? this.configured,
      true
    )
  }

  async stream(request: LanguageModelRequest): Promise<LanguageModelStream> {
    request.signal.throwIfAborted()
    if (this.runtime.computersOnly) {
      throw new ModelProviderError(
        `${ERROR_PREFIX} '${this.modelId}' runs on the computer of whoever runs the turn, through their Claude Code: run the thread on your computer, in the desktop app or with \`sixb agent\`.`,
        PROVIDER_ID,
        this.modelId,
        { code: "computers_only" }
      )
    }
    const issue = modelReasoningSupportIssue(
      this.definition.capabilities.reasoning,
      request.reasoning
    )
    if (issue) throw new UnsupportedModelFeatureError(`${ERROR_PREFIX} ${issue}.`)

    return { events: this.events(request) }
  }

  private async *events(request: LanguageModelRequest): AsyncIterable<LanguageModelStreamEvent> {
    const turn = planTurn(request.messages)
    yield { type: "stream-start" }

    if (turn.resume !== undefined) {
      let answered = false
      try {
        for await (const event of this.query(request, turn.systemPrompt, turn.resume.content, {
          session: turn.resume.session,
        })) {
          answered = true
          yield event
        }
        return
      } catch (error) {
        // A session Claude Code no longer has, such as one its cleanup removed, starts over.
        if (answered || request.signal.aborted || !isMissingSession(error)) throw error
      }
    }

    yield* this.query(request, turn.systemPrompt, turn.start)
  }

  /** One Claude Code query, ended as soon as the answer is complete. */
  private async *query(
    request: LanguageModelRequest,
    systemPrompt: string,
    content: readonly JsonObject[],
    resume?: { readonly session: ClaudeCodeSessionState }
  ): AsyncIterable<LanguageModelStreamEvent> {
    const released = new AbortController()
    const release = () => released.abort()
    request.signal.addEventListener("abort", release, { once: true })

    let stderr = ""
    const stream = new ClaudeCodeStream({
      modelId: this.modelId,
      structuredOutput: request.responseFormat !== undefined,
    })
    const conversation = query({
      prompt: waitFor(Promise.resolve(), userMessage(content)),
      options: {
        ...(await this.runtime.queryOptions()),
        abortController: released,
        model: this.modelId,
        // Rendered from Sixb's prompt on every call, which can change within a conversation.
        systemPrompt: { type: "custom", prompt: [RELAY_NOTE, systemPrompt], snapshot: false },
        includePartialMessages: true,
        // Only Sixb's tools exist, and each is allowed: nothing is left to ask about.
        permissionMode: "dontAsk",
        stderr: (data) => {
          stderr = (stderr + data).slice(-2_000)
        },
        ...(request.tools.length === 0
          ? {}
          : {
              mcpServers: { sixb: sixbToolServer(request.tools, released.signal) },
              allowedTools: request.tools.map((tool) => `${TOOL_PREFIX}${tool.name}`),
            }),
        ...(resume === undefined
          ? {}
          : {
              resume: resume.session.sessionId,
              resumeSessionAt: resume.session.at,
              // A copy of the session up to the answer. Stopping at Sixb's tool calls leaves
              // Claude Code's own record that they were refused in the session after it, and
              // Claude Code reads that record in place of Sixb's results on later calls.
              forkSession: true,
            }),
        ...reasoningOptions(request.reasoning),
        ...(request.responseFormat === undefined
          ? {}
          : { outputFormat: { type: "json_schema", schema: request.responseFormat.schema } }),
      },
    })

    try {
      for await (const message of conversation) {
        yield* stream.accept(message)

        if (stream.toolCallsReady) {
          // Sixb runs the tools. Claude Code has started them too, and would wait for them: stop it,
          // and the next call resumes the session at this answer with Sixb's results.
          await conversation.interrupt().catch(() => undefined)
          yield* stream.finish()
          return
        }
        if (stream.done) {
          yield* stream.finish()
          return
        }
      }

      request.signal.throwIfAborted()
      throw new ModelProviderError(
        `${ERROR_PREFIX} Claude Code ended without an answer.${stderr ? ` ${stderr.trim()}` : ""}`,
        PROVIDER_ID,
        this.modelId
      )
    } catch (error) {
      if (error instanceof ModelProviderError || request.signal.aborted) throw error
      const detail = errorMessage(error)
      throw new ModelProviderError(
        MISSING_EXECUTABLE.test(detail)
          ? `${ERROR_PREFIX} Claude Code is not installed here: install it and sign in with \`claude\`, then try again. (${detail})`
          : `${ERROR_PREFIX} Claude Code failed: ${detail}`,
        PROVIDER_ID,
        this.modelId,
        { cause: error }
      )
    } finally {
      request.signal.removeEventListener("abort", release)
      released.abort()
      conversation.close()
    }
  }
}

export function reasoningOptions(
  reasoning: ModelReasoning | undefined
): Pick<Options, "effort" | "thinking"> {
  if (reasoning === undefined || reasoning === "provider-default") return {}
  if (reasoning === "none") return { thinking: { type: "disabled" } }
  if (typeof reasoning === "object") {
    return { thinking: { type: "enabled", budgetTokens: reasoning.budgetTokens } }
  }
  // Claude has no effort below low.
  return { effort: reasoning === "minimal" ? "low" : reasoning }
}

function isReasoningEffort(value: string): value is ModelReasoningEffort {
  return (MODEL_REASONING_EFFORTS as readonly string[]).includes(value)
}

type UserContentBlock = Exclude<SDKUserMessage["message"]["content"], string>[number]

/** The block types `messagesInput` writes for user and tool messages. */
const USER_BLOCK_TYPES = new Set(["text", "image", "document", "tool_result"])

function userMessage(content: readonly JsonObject[]): SDKUserMessage {
  return {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: content.flatMap((block) => (isUserContentBlock(block) ? [block] : [])),
    },
  }
}

function isUserContentBlock(block: unknown): block is UserContentBlock {
  return isJsonObject(block) && typeof block.type === "string" && USER_BLOCK_TYPES.has(block.type)
}

/** Claude Code's input: these messages, then nothing more once `idle` settles. */
async function* waitFor(
  idle: Promise<void>,
  ...messages: SDKUserMessage[]
): AsyncIterable<SDKUserMessage> {
  yield* messages
  await idle
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  })
}

function isMissingSession(error: unknown): boolean {
  return error instanceof ModelProviderError && /no conversation found/i.test(error.message)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
