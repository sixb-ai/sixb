/** @jsxImportSource @opentui/react */
import { homedir } from "node:os"
import type { KeyEvent, ScrollBoxRenderable, SyntaxStyle } from "@opentui/core"
import {
  useKeyboard,
  useRenderer,
  useSelectionHandler,
  useTerminalDimensions,
} from "@opentui/react"
import {
  cancelAgentRun,
  createAgentActivitySocket,
  createAgentRunSocket,
  createAgentThread,
  decideAgentApproval,
  type GetAgentThreadResponses,
  getAgentThread,
  listAgentThreadApprovals,
  listAgentThreadMessages,
  listAgentThreadRuns,
  listAgentThreads,
  listModels,
  moveAgentThreadToComputer,
  postAgentThreadMessage,
  setAgentThreadApprovalMode,
} from "@sixb/client"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Logo } from "./brand"
import type { Connection } from "./connection"
import { conversationsIn, folderOf, rememberFolder } from "./folders"
import { shortPath } from "./format"
import { Palette, type PaletteItem } from "./palette"
import { type LiveRun, liveRun, reduceLive, type ShownMessage, shownMessage } from "./parts"
import { type LocalRunner, owns, runsOnThisComputer } from "./runner"
import {
  APPROVAL_MODES,
  type ApprovalMode,
  approvalLabel,
  type LanguageModel,
  messageSelection,
  modelLabel,
  placeLabel,
  type ReasoningLevel,
  type Settings,
  saveSettings,
} from "./settings"
import { pickSlash, type SlashCommand, slashMatches } from "./slash"
import type { TuiColors } from "./theme"
import { APPROVAL_CHOICES, type Approval, type Run, Transcript, Working } from "./transcript"
import { BOLD, Composer, ComposerDraft, KeyHints, type StatusItem } from "./ui"

type Thread = GetAgentThreadResponses[200]
type Screen = { readonly kind: "home" } | { readonly kind: "thread"; readonly threadId: string }
type Dialog = "commands" | "threads" | "models" | "permissions" | null

/** The person's mode in a conversation, as the server keeps it for them there. */
interface ThreadApproval {
  readonly threadId: string
  /** Unknown until the thread is read. */
  readonly mode?: ApprovalMode
  /** Chosen here and not the thread's yet: the next message carries it. */
  readonly chosen: boolean
}

export interface WorkspaceProps {
  readonly connection: Connection
  readonly runner: LocalRunner
  /** This computer's id: a conversation on a computer runs on one of its owner's. */
  readonly computerId: string
  readonly colors: TuiColors
  readonly syntax: SyntaxStyle
  readonly version: string
  readonly initialSettings: Settings
  readonly onExit: () => void
}

/** Everything once connected: the home screen or a conversation, and the dialogs over them. */
export function Workspace(props: WorkspaceProps) {
  const { connection, colors } = props
  const [screen, setScreen] = useState<Screen>({ kind: "home" })
  const [settings, setSettingsState] = useState(props.initialSettings)
  const [models, setModels] = useState<readonly LanguageModel[]>([])
  const [dialog, setDialog] = useState<Dialog>(null)
  const [notice, setNotice] = useState<{
    readonly text: string
    readonly tone: "info" | "error"
  } | null>(null)
  const [quitArmed, setQuitArmed] = useState(false)
  const draft = useRef<(() => boolean) | null>(null)

  const setSettings = useCallback((change: (current: Settings) => Settings) => {
    setSettingsState((current) => {
      const next = change(current)
      void saveSettings(next)
      return next
    })
  }, [])
  const say = useCallback(
    (text: string, tone: "info" | "error" = "info") => setNotice({ text, tone }),
    []
  )
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 4_000)
    return () => clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    void listModels({ client: connection.client }).then(({ data }) =>
      setModels(data?.language ?? [])
    )
  }, [connection])

  // Selecting text copies it, as the terminal would without the app's mouse.
  const renderer = useRenderer()
  const copied = useRef<ReturnType<typeof setTimeout> | null>(null)
  useSelectionHandler((selection) => {
    const text = selection.getSelectedText()
    if (!text.trim()) return
    if (copied.current) clearTimeout(copied.current)
    copied.current = setTimeout(() => {
      void copy(text, renderer).then((done) => {
        if (done) say("Copied")
      })
    }, 300)
  })

  // This folder's conversations run here whatever screen is open: a message sent from the web app,
  // or a turn going on after approvals decided there, and those that queued while sixb was closed.
  const { runner } = props
  useEffect(() => {
    void conversationsIn(runner.folder).then((threadIds) => {
      for (const threadId of threadIds) void runner.claimIfHere(threadId)
    })
    const socket = createAgentActivitySocket({
      client: connection.client,
      onActivity: (event) => {
        if (event.status === "queued") void runner.claimIfHere(event.threadId, event.runId)
      },
    })
    return () => socket.close()
  }, [connection, runner])

  // In a conversation, the mode is the thread's, as the web reads it: "always" on a card raises it,
  // and a mode chosen in the app applies here too. New conversations start in the settings' mode.
  const [threadApproval, setThreadApproval] = useState<ThreadApproval | null>(null)
  const openThreadId = screen.kind === "thread" ? screen.threadId : null
  const approval = threadApproval?.threadId === openThreadId ? threadApproval : null
  const approvalMode = openThreadId === null ? settings.approvalMode : approval?.mode

  // A choice still on its way to the server keeps showing, except after "always", which raised
  // the mode there.
  const readApproval = useCallback((thread: Thread, raised: boolean) => {
    setThreadApproval((current) =>
      current?.threadId === thread.id && current.chosen && !raised
        ? current
        : {
            threadId: thread.id,
            ...(thread.approvalMode ? { mode: thread.approvalMode } : {}),
            chosen: false,
          }
    )
  }, [])

  const chooseApproval = useCallback(
    (mode: ApprovalMode) => {
      say(`Permissions: ${approvalLabel(mode)}`)
      // It is where the next new conversation starts, as the web makes it the person's default.
      setSettings((current) => ({ ...current, approvalMode: mode }))
      if (openThreadId === null) return

      // In a conversation, it becomes the person's mode there, on every device, as in the web.
      const threadId = openThreadId
      setThreadApproval({ threadId, mode, chosen: true })
      void setAgentThreadApprovalMode({
        client: connection.client,
        path: { threadId },
        body: { approvalMode: mode },
      }).then(({ data, error }) => {
        // Not kept there, the choice stays one the next message carries.
        if (error || !data) return say(errorText(error), "error")

        setThreadApproval((current) =>
          current?.threadId === threadId && current.chosen && current.mode === mode
            ? { threadId, mode: data.approvalMode ?? mode, chosen: false }
            : current
        )
      })
    },
    [connection, openThreadId, say, setSettings]
  )

  const cyclePermissions = useCallback(() => {
    // A conversation not read yet has no mode to step from.
    if (!approvalMode) return

    const at = APPROVAL_MODES.findIndex((entry) => entry.mode === approvalMode)
    chooseApproval(APPROVAL_MODES[(at + 1) % APPROVAL_MODES.length]?.mode ?? "manual")
  }, [approvalMode, chooseApproval])

  // Ctrl+t steps through the effort levels of the model in effect, then back to its default.
  const cycleEffort = useCallback(() => {
    setSettings((current) => {
      const model = effortModel(models, current)
      const levels: readonly ReasoningLevel[] = (model?.reasoningLevels ?? []).filter(
        (level) => level !== "provider-default"
      )
      const at = current.reasoning ? levels.indexOf(current.reasoning) : -1
      const next = levels[at + 1]
      const { reasoning: _reasoning, ...rest } = current
      say(`Effort: ${next ?? "default"}`)
      return next ? { ...rest, reasoning: next } : rest
    })
  }, [models, setSettings, say])

  useKeyboard((key: KeyEvent) => {
    if (key.ctrl && key.name === "c") {
      // A draft goes first; ctrl+c on an empty composer quits.
      if (draft.current?.()) return setQuitArmed(false)
      if (quitArmed) return props.onExit()
      setQuitArmed(true)
      setTimeout(() => setQuitArmed(false), 2_000)
      return
    }
    if (dialog) return
    if (key.ctrl && key.name === "p") return setDialog("commands")
    if (key.ctrl && key.name === "n") return setScreen({ kind: "home" })
    if (key.ctrl && key.name === "l") return setDialog("threads")
    if (key.ctrl && key.name === "o") return setDialog("models")
    if (key.ctrl && key.name === "t") return cycleEffort()
    if (key.shift && key.name === "tab") return cyclePermissions()
  })

  const status = (place: string): StatusItem[] => {
    const model = modelLabel(models, settings)
    return [
      { text: place, color: colors.blue, bold: true },
      { text: model.name, color: colors.text },
      ...(model.reasoning ? [{ text: model.reasoning, color: colors.muted }] : []),
      // Amber is for what deserves your attention: here, an agent that asks before nothing.
      ...(approvalMode
        ? [
            {
              text: approvalLabel(approvalMode),
              color:
                approvalMode === "auto"
                  ? colors.amber
                  : approvalMode === "accept-edits"
                    ? colors.text
                    : colors.muted,
            },
          ]
        : []),
    ]
  }

  const slashCommands: readonly SlashCommand[] = [
    {
      name: "new",
      description: "Start a new conversation",
      run: () => setScreen({ kind: "home" }),
    },
    { name: "conversations", description: "Open a conversation", run: () => setDialog("threads") },
    {
      name: "model",
      description: "Choose the model and its effort",
      run: () => setDialog("models"),
    },
    {
      name: "permissions",
      description: "What the agent may do without asking",
      run: () => setDialog("permissions"),
    },
    {
      name: "cloud",
      description: "Run new conversations in the cloud",
      run: () => setSettings((current) => ({ ...current, place: "cloud" })),
    },
    {
      name: "here",
      description: `Run new conversations on ${placeLabel("computer")}, in this folder`,
      run: () => setSettings((current) => ({ ...current, place: "computer" })),
    },
    { name: "quit", description: "Quit sixb", run: props.onExit },
  ]

  const common = {
    ...props,
    settings,
    models,
    status,
    say,
    slashCommands,
    dialogOpen: dialog !== null,
  }

  return (
    <ComposerDraft.Provider value={draft}>
      <box flexDirection="column" flexGrow={1} backgroundColor={colors.background}>
        {screen.kind === "home" ? (
          <Home
            {...common}
            onPlace={() =>
              setSettings((current) => {
                const place = current.place === "computer" ? "cloud" : "computer"
                say(
                  place === "cloud"
                    ? "New conversations run in the cloud"
                    : `New conversations run on ${placeLabel(place)}`
                )
                return { ...current, place }
              })
            }
            onOpen={(threadId) => setScreen({ kind: "thread", threadId })}
          />
        ) : (
          <ThreadView
            key={screen.threadId}
            {...common}
            threadId={screen.threadId}
            approval={approval}
            onThreadRead={readApproval}
          />
        )}
        {notice || quitArmed ? (
          <box
            position="absolute"
            right={2}
            top={1}
            backgroundColor={colors.surface}
            paddingLeft={2}
            paddingRight={2}
            zIndex={5}
          >
            <text
              fg={quitArmed ? colors.text : notice?.tone === "error" ? colors.red : colors.text}
            >
              {quitArmed ? "Press ctrl+c again to quit" : notice?.text}
            </text>
          </box>
        ) : null}
        {dialog === "commands" ? (
          <Palette
            colors={colors}
            title="Commands"
            placeholder="Search"
            onClose={() => setDialog(null)}
            items={commandItems({
              settings,
              approvalMode,
              models,
              newConversation: () => setScreen({ kind: "home" }),
              open: setDialog,
              setPlace: (place) => setSettings((current) => ({ ...current, place })),
              cycleEffort,
              quit: props.onExit,
            })}
          />
        ) : null}
        {dialog === "threads" ? (
          <ThreadsDialog
            connection={connection}
            colors={colors}
            onClose={() => setDialog(null)}
            onOpen={(threadId) => setScreen({ kind: "thread", threadId })}
          />
        ) : null}
        {dialog === "models" ? (
          <Palette
            colors={colors}
            title="Model"
            placeholder="Search models"
            onClose={() => setDialog(null)}
            items={modelItems(models, settings, (model, reasoning) =>
              setSettings((current) => {
                const { model: _model, reasoning: _reasoning, ...rest } = current
                return {
                  ...rest,
                  ...(model ? { model: { provider: model.provider, modelId: model.modelId } } : {}),
                  ...(reasoning ? { reasoning } : {}),
                }
              })
            )}
          />
        ) : null}
        {dialog === "permissions" ? (
          <Palette
            colors={colors}
            title="What can the agent do without asking?"
            placeholder="Search"
            onClose={() => setDialog(null)}
            items={APPROVAL_MODES.map((entry) => ({
              id: entry.mode,
              label: entry.label,
              detail: entry.description,
              current: entry.mode === approvalMode,
              run: () => chooseApproval(entry.mode),
            }))}
          />
        ) : null}
      </box>
    </ComposerDraft.Provider>
  )
}

interface ScreenProps extends WorkspaceProps {
  readonly settings: Settings
  readonly models: readonly LanguageModel[]
  readonly status: (place: string) => StatusItem[]
  readonly say: (text: string, tone?: "info" | "error") => void
  readonly slashCommands: readonly SlashCommand[]
  readonly dialogOpen: boolean
}

/** The commands matching what is typed, listed above the composer. */
function SlashMenu({
  colors,
  menu,
  above,
}: {
  readonly colors: TuiColors
  readonly menu: SlashMenuState
  /** How many rows below the menu the composer and its hints take. */
  readonly above: number
}) {
  const { matches, selected } = menu
  if (matches.length === 0) return null
  const width = Math.max(...matches.map((command) => command.name.length)) + 4
  return (
    <box
      position="absolute"
      left={0}
      right={0}
      bottom={above}
      zIndex={5}
      backgroundColor={colors.surface}
      flexDirection="column"
    >
      {matches.map((command, index) => {
        const chosen = index === selected
        return (
          <box
            key={command.name}
            backgroundColor={chosen ? colors.raised : colors.surface}
            paddingLeft={3}
            paddingRight={3}
          >
            <text>
              <span fg={chosen ? colors.blue : colors.text} attributes={chosen ? BOLD : 0}>
                {`/${command.name}`.padEnd(width)}
              </span>
              <span fg={chosen ? colors.text : colors.muted}>{command.description}</span>
            </text>
          </box>
        )
      })}
    </box>
  )
}

/** The slash menu over a composer: what the text names, and which of it up and down chose. */
interface SlashMenuState {
  readonly matches: readonly SlashCommand[]
  readonly selected: number
  /** Move the choice; false when no menu is open, so the key does what it otherwise would. */
  move(step: number): boolean
  /** Run the chosen command when the text is one; false sends the text to the agent. */
  run(text: string): boolean
}

function useSlashMenu(commands: readonly SlashCommand[], typed: string): SlashMenuState {
  const matches = slashMatches(commands, typed)
  // A choice belongs to the text it was made for: typing more starts again at the top.
  const [pick, setPick] = useState({ typed: "", index: 0 })
  const selected = pick.typed === typed ? Math.min(pick.index, Math.max(0, matches.length - 1)) : 0
  return {
    matches,
    selected,
    move(step) {
      if (matches.length === 0) return false
      setPick({ typed, index: (selected + step + matches.length) % matches.length })
      return true
    },
    run(text) {
      const command = pickSlash(commands, text, selected)
      if (!command) return false
      command.run()
      return true
    },
  }
}

/** Where every conversation starts: the mark, the composer, and where it will run. */
function Home(
  props: ScreenProps & { readonly onPlace: () => void; readonly onOpen: (threadId: string) => void }
) {
  const { connection, runner, colors, settings, models, version } = props
  const { width } = useTerminalDimensions()
  const composerWidth = Math.min(76, width - 8)
  // The hints that fit beside the folder, the most useful kept.
  // Tab is a switch: its hint names where it switches to.
  const tabTo = settings.place === "computer" ? "cloud" : placeLabel("computer").toLowerCase()
  const hints: (readonly [string, string])[] =
    composerWidth >= 72
      ? [
          ["tab", tabTo],
          ["shift+tab", "permissions"],
          ["ctrl+p", "commands"],
        ]
      : [
          ["tab", tabTo],
          ["ctrl+p", "commands"],
        ]
  const hintsWidth = hints.reduce((sum, [key, label]) => sum + key.length + label.length + 3, 0)
  // Where it runs, beside the hints, in the room they leave.
  const room = composerWidth - hintsWidth - 2
  const where =
    settings.place === "computer" ? shortPath(runner.folder, homedir(), room) : "Runs in the cloud"
  const [sending, setSending] = useState(false)
  const [typed, setTyped] = useState("")
  const slash = useSlashMenu(props.slashCommands, typed)
  // Which instance this is matters most when it isn't this computer's: it reads brighter then.
  const host = new URL(connection.apiUrl).host
  const remote = !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)
  const shownVersion = version.replace(/^sixb v/, "")
  const instance = fitted(
    [connection.project.id, host, ...(connection.user ? [connection.user.name] : [])],
    width - shownVersion.length - 6
  )
  const instanceTones = remote ? [colors.text, colors.muted] : [colors.muted]

  useKeyboard((key: KeyEvent) => {
    if (props.dialogOpen) return
    if (key.name === "up" && slash.move(-1)) return
    if (key.name === "down" && slash.move(1)) return
    if (key.name === "tab" && !key.shift && !key.ctrl) props.onPlace()
  })

  const send = async (text: string): Promise<boolean> => {
    if (slash.run(text)) return true
    if (sending) return false
    setSending(true)
    try {
      const { data: created } = await createAgentThread({
        client: connection.client,
        body: {
          title: clip(text.split("\n")[0]?.trim() || "Conversation", 72),
          ...(settings.place === "computer" ? { runsOn: "computer" as const } : {}),
        },
        throwOnError: true,
      })

      // It starts in the mode chosen here, the person's in it from then on: its next messages
      // carry none, as the web keeps a mode chosen before the thread existed.
      await setAgentThreadApprovalMode({
        client: connection.client,
        path: { threadId: created.thread.id },
        body: { approvalMode: settings.approvalMode },
        throwOnError: true,
      })

      const { data: posted } = await postAgentThreadMessage({
        client: connection.client,
        path: { threadId: created.thread.id },
        body: {
          text,
          ...requesterSettings(),
          ...messageSelection(models, settings),
        },
        throwOnError: true,
      })
      if (created.thread.runsOn === "computer") {
        await rememberFolder(created.thread.id, runner.folder)
        void runner.claim(posted.run.id)
      }
      props.onOpen(created.thread.id)
      return true
    } catch (error) {
      props.say(errorText(error), "error")
      return false
    } finally {
      setSending(false)
    }
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
        <Logo colors={colors} />
        <box height={2} flexShrink={0} />
        <box width={composerWidth} flexDirection="column">
          <SlashMenu colors={colors} menu={slash} above={6} />
          <Composer
            colors={colors}
            focused={!props.dialogOpen}
            onChange={setTyped}
            placeholder="Ask anything…"
            status={props.status(placeLabel(settings.place))}
            onSubmit={send}
          />
          <box flexDirection="row" justifyContent="space-between">
            <text fg={colors.faint} wrapMode="none">
              {where.length <= room ? where : ""}
            </text>
            <KeyHints colors={colors} items={hints} />
          </box>
        </box>
      </box>
      <box
        flexDirection="row"
        justifyContent="space-between"
        paddingLeft={2}
        paddingRight={2}
        paddingBottom={1}
      >
        <text wrapMode="none">
          {instance.map((item, index) => (
            <span key={item} fg={instanceTones[index] ?? colors.faint}>
              {index > 0 ? ` · ${item}` : item}
            </span>
          ))}
        </text>
        <text fg={colors.faint}>{shownVersion}</text>
      </box>
    </box>
  )
}

/** The first of `items` that fit in `room` columns joined by ` · `, the rest dropped. */
function fitted(items: readonly string[], room: number): string[] {
  const kept = [...items]
  while (kept.length > 1 && kept.join(" · ").length > room) kept.pop()
  return kept
}

/** The model whose effort the person sets: the one chosen, else the project's default without tiers. */
function effortModel(
  models: readonly LanguageModel[],
  settings: Settings
): LanguageModel | undefined {
  const tiers = models.some((model) => model.tier !== undefined)
  return settings.model
    ? models.find(
        (model) =>
          model.provider === settings.model?.provider && model.modelId === settings.model.modelId
      )
    : tiers
      ? undefined
      : (models.find((model) => model.isDefault) ?? models[0])
}

/** How long a card that just appeared ignores its keys, so typing that was under way doesn't decide it. */
const APPROVAL_GRACE_MS = 700

/** A conversation: its transcript, the turn at work, what waits on you, and the composer. */
function ThreadView(
  props: ScreenProps & {
    readonly threadId: string
    readonly approval: ThreadApproval | null
    /** The thread as read; `raised` after "always", which raised its mode there. */
    readonly onThreadRead: (thread: Thread, raised: boolean) => void
  }
) {
  const { connection, runner, colors, syntax, settings, models, threadId } = props
  const { client } = connection
  const { width } = useTerminalDimensions()
  const [thread, setThread] = useState<Thread | null>(null)
  const [messages, setMessages] = useState<readonly ShownMessage[]>([])
  const [runs, setRuns] = useState<readonly Run[]>([])
  const [approvals, setApprovals] = useState<readonly Approval[]>([])
  const [live, setLive] = useState<LiveRun | null>(null)
  const [stopArmed, setStopArmed] = useState(false)
  const [typed, setTyped] = useState("")
  const slash = useSlashMenu(props.slashCommands, typed)
  const scroll = useRef<ScrollBoxRenderable>(null)

  const mine = thread !== null && owns(connection, thread)
  const onComputer = thread?.runsOn === "computer"

  const { onThreadRead } = props
  const reload = useCallback(async () => {
    const [threadResult, messageResult, runResult, approvalResult] = await Promise.all([
      getAgentThread({ client, path: { threadId } }),
      listAgentThreadMessages({
        client,
        path: { threadId },
        query: { limit: "200", order: "asc" },
      }),
      listAgentThreadRuns({ client, path: { threadId }, query: { limit: "200", order: "asc" } }),
      listAgentThreadApprovals({ client, path: { threadId }, query: { status: "pending" } }),
    ])
    if (threadResult.data) {
      setThread(threadResult.data)
      onThreadRead(threadResult.data, false)
    }
    if (messageResult.data) {
      setMessages(messageResult.data.messages.flatMap((message) => shownMessage(message) ?? []))
    }
    if (runResult.data) setRuns(runResult.data.runs)
    if (approvalResult.data) setApprovals(approvalResult.data.approvals)
    return threadResult.data
  }, [client, threadId, onThreadRead])

  const activeRunId = thread?.activeRunId ?? null

  // The folder its turns work in on this computer; null until read.
  const [workFolder, setWorkFolder] = useState<string | undefined | null>(null)
  useEffect(() => {
    void folderOf(threadId).then(setWorkFolder)
  }, [threadId])
  // Another of the owner's computers runs it: its folder here, if any, is where it worked before.
  const otherComputer = thread !== null && !runsOnThisComputer(thread, props.computerId)
  const here = workFolder === runner.folder && !otherComputer
  // This computer runs the conversation's turns when it is the owner's, and this its folder.
  const runsHere = onComputer && mine && here
  // Only a queued turn: a running one is another sixb's, or one whose sixb closed, which the API
  // ends interrupted rather than running its commands again.
  const queued = runs.find((run) => run.id === activeRunId)?.status === "queued"
  useEffect(() => {
    if (activeRunId && runsHere && queued) void runner.claim(activeRunId)
  }, [activeRunId, runsHere, queued, runner])
  // Its turns move to this computer, which alone claims them from now on, and to this folder.
  const moveHere = async () => {
    const { error } = await moveAgentThreadToComputer({
      client,
      path: { threadId },
      body: { computerId: props.computerId },
    })
    if (error) return props.say(errorText(error), "error")
    await rememberFolder(threadId, runner.folder)
    setWorkFolder(runner.folder)
    void reload()
    props.say("Its turns now run in this folder")
  }

  useEffect(() => {
    void reload()
    const socket = createAgentActivitySocket({
      client,
      onActivity: (event) => {
        if (event.threadId === threadId) void reload()
      },
      onApprovalActivity: (event) => {
        if (event.threadId === threadId) void reload()
      },
    })
    return () => socket.close()
  }, [client, threadId, reload])

  // The running turn streams in as it works; its stored answer replaces it once it ends.
  useEffect(() => {
    if (!activeRunId) return
    setLive((current) => (current?.runId === activeRunId ? current : liveRun(activeRunId)))
    const socket = createAgentRunSocket({
      client,
      runId: activeRunId,
      onEvent: (event) => {
        setLive((current) =>
          reduceLive(current?.runId === activeRunId ? current : liveRun(activeRunId), event)
        )
        if (event.type === "agent.message.finalized" || event.type === "agent.run.finished")
          void reload()
      },
    })
    return () => socket.close()
  }, [client, activeRunId, reload])

  const pending = approvals[0]
  const working =
    activeRunId !== null &&
    runs.find((run) => run.id === activeRunId)?.finishReason !== "awaiting_approval"

  const stop = async () => {
    if (!activeRunId) return
    if (!stopArmed) {
      setStopArmed(true)
      setTimeout(() => setStopArmed(false), 2_000)
      return
    }
    setStopArmed(false)
    await cancelAgentRun({ client, path: { threadId }, body: { runId: activeRunId } })
    runner.hearStop(activeRunId)
  }

  // A card that appears mid-sentence must not take the next letters typed as its answer: its keys
  // count once it has been seen, and once per decision.
  const [choice, setChoice] = useState(0)
  const [deciding, setDeciding] = useState(false)
  const shownAt = useRef(0)
  const pendingId = pending?.id
  useEffect(() => {
    if (pendingId === undefined) return
    shownAt.current = Date.now()
    setChoice(0)
  }, [pendingId])

  const decide = async (index: number) => {
    const option = APPROVAL_CHOICES[index]
    if (!pending || !option || deciding) return
    setDeciding(true)
    try {
      const { error } = await decideAgentApproval({
        client,
        path: { threadId, approvalId: pending.id },
        body: { decision: option.decision, ...(option.always ? { always: true as const } : {}) },
      })
      if (error) props.say(errorText(error), "error")
      const read = await reload()
      // "Always" raised the mode there: the thread's wins over a choice still on its way.
      if (read && option.always) onThreadRead(read, true)
    } finally {
      setDeciding(false)
    }
  }

  useKeyboard((key: KeyEvent) => {
    if (props.dialogOpen) return
    if (pending && !key.ctrl && !key.meta) {
      const settled = Date.now() - shownAt.current > APPROVAL_GRACE_MS
      if (key.name === "left" || key.name === "up") {
        return setChoice((value) => (value + APPROVAL_CHOICES.length - 1) % APPROVAL_CHOICES.length)
      }
      if (key.name === "right" || key.name === "down" || key.name === "tab") {
        return setChoice((value) => (value + 1) % APPROVAL_CHOICES.length)
      }
      if (key.name === "return" && settled) return void decide(choice)
      const shortcut = APPROVAL_CHOICES.findIndex((option) => option.key === key.name)
      if (shortcut >= 0 && settled) return void decide(shortcut)
      if (shortcut >= 0 || key.name === "return") return
    }
    if (key.name === "up" && slash.move(-1)) return
    if (key.name === "down" && slash.move(1)) return
    if (key.name === "escape") return void stop()
    if (key.ctrl && key.name === "f" && onComputer && mine && !here && workFolder !== null) {
      return void moveHere()
    }
    if (key.name === "pageup") scroll.current?.scrollBy(-10)
    if (key.name === "pagedown") scroll.current?.scrollBy(10)
  })

  const send = async (text: string): Promise<boolean> => {
    if (slash.run(text)) return true
    if (!thread) return false
    if (onComputer && mine && !here) {
      props.say("It works in another folder: press ctrl+f to move it here first.")
      return false
    }
    if (activeRunId) {
      props.say("The agent is still working. Press esc twice to stop it.")
      return false
    }
    const { data, error } = await postAgentThreadMessage({
      client,
      path: { threadId },
      body: {
        text,
        // The thread's mode applies, unless one chosen here has not reached it yet.
        ...(props.approval?.chosen && props.approval.mode
          ? { approvalMode: props.approval.mode }
          : {}),
        ...requesterSettings(),
        ...messageSelection(models, settings),
      },
    })
    if (error || !data) {
      props.say(errorText(error), "error")
      return false
    }
    if (runsHere) void runner.claim(data.run.id)
    setLive(liveRun(data.run.id))
    void reload()
    return true
  }

  const modelNames = useMemo(
    () => new Map(models.map((model) => [`${model.provider}:${model.modelId}`, model.name])),
    [models]
  )
  const elsewhere = onComputer && thread && !mine
  const runningSince = runs.find((run) => run.id === activeRunId)?.startedAt

  return (
    <box flexDirection="column" flexGrow={1} paddingTop={1}>
      <box
        flexDirection="row"
        justifyContent="space-between"
        paddingLeft={3}
        paddingRight={3}
        paddingBottom={1}
      >
        <text wrapMode="none" flexGrow={1} flexShrink={1}>
          <span fg={colors.blue}>{"▰ "}</span>
          <span fg={colors.text} attributes={BOLD}>
            {clip(thread?.title ?? "Conversation", width - connection.project.id.length - 16)}
          </span>
        </text>
        <text fg={colors.faint} flexShrink={0}>
          {connection.project.id}
        </text>
      </box>
      <scrollbox
        ref={scroll}
        flexGrow={1}
        flexShrink={1}
        stickyScroll
        stickyStart="bottom"
        paddingLeft={2}
        paddingRight={2}
        backgroundColor={colors.background}
        verticalScrollbarOptions={{ visible: false }}
        horizontalScrollbarOptions={{ visible: false }}
      >
        <Transcript
          colors={colors}
          syntax={syntax}
          messages={messages}
          runs={runs}
          live={live}
          approvals={approvals}
          modelNames={modelNames}
          computerRuns={onComputer}
          width={width}
          approvalChoice={choice}
          {...(onComputer ? { folder: runner.folder } : {})}
        />
        {working && live?.working !== false ? (
          <box paddingTop={1}>
            <Working
              colors={colors}
              since={runningSince ? Date.parse(runningSince) : Date.now()}
              stopping={stopArmed}
              label={
                stopArmed
                  ? "Press esc again to stop"
                  : live?.compacting
                    ? "Condensing earlier turns"
                    : queuedLabel(runs, activeRunId, {
                        onComputer,
                        mine,
                        runsHere: activeRunId !== null && runner.runs(activeRunId),
                      })
              }
            />
          </box>
        ) : null}
        <box height={1} />
      </scrollbox>
      <box flexDirection="column" flexShrink={0} paddingLeft={2} paddingRight={2} paddingBottom={1}>
        {elsewhere ? (
          <text fg={colors.amber} paddingBottom={1}>
            {"This conversation runs on its owner's computer: you can read it here."}
          </text>
        ) : onComputer && mine && workFolder !== null && !here ? (
          <text paddingBottom={1}>
            <span fg={colors.amber}>
              {otherComputer
                ? "It works on another computer."
                : workFolder
                  ? `It works in ${shortPath(workFolder, homedir(), 48)}.`
                  : "It started on another computer."}
            </span>
            <span fg={colors.muted}>{"  Its turns run there: "}</span>
            <span fg={colors.text}>ctrl+f</span>
            <span fg={colors.muted}> moves it to this folder</span>
          </text>
        ) : null}
        <SlashMenu colors={colors} menu={slash} above={8} />
        <Composer
          colors={colors}
          focused={!props.dialogOpen && !pending && !elsewhere}
          onChange={setTyped}
          accent={pending ? colors.amber : undefined}
          placeholder={pending ? "Decide on the request above first" : "Ask anything…"}
          status={props.status(onComputer ? placeLabel("computer") : placeLabel("cloud"))}
          onSubmit={send}
        />
        <box flexDirection="row" justifyContent="space-between" paddingTop={1}>
          <text fg={colors.faint}>
            {onComputer ? shortPath(runner.folder, homedir(), 40) : "Runs in the cloud"}
          </text>
          <text>
            <span fg={colors.text}>ctrl+p</span>
            <span fg={colors.muted}> commands</span>
          </text>
        </box>
      </box>
    </box>
  )
}

function queuedLabel(
  runs: readonly Run[],
  runId: string | null,
  where: { readonly onComputer: boolean; readonly mine: boolean; readonly runsHere: boolean }
): string {
  const run = runs.find((entry) => entry.id === runId)
  if (run?.status === "queued") {
    return where.onComputer && !where.mine ? "Waiting for its owner's computer" : "Starting"
  }
  // Yours, running, and not here: another sixb runs it, or one that closed, whose turn ends
  // interrupted once its lease lapses.
  if (where.onComputer && where.mine && !where.runsHere) return "Working in another sixb"
  return "Working"
}

function ThreadsDialog({
  connection,
  colors,
  onClose,
  onOpen,
}: {
  readonly connection: Connection
  readonly colors: TuiColors
  readonly onClose: () => void
  readonly onOpen: (threadId: string) => void
}) {
  const [threads, setThreads] = useState<readonly Thread[] | null>(null)
  useEffect(() => {
    void listAgentThreads({
      client: connection.client,
      query: { limit: "100", order: "desc" },
    }).then(({ data }) => setThreads(data?.threads ?? []))
  }, [connection])
  return (
    <Palette
      colors={colors}
      title="Conversations"
      placeholder={threads === null ? "Loading…" : "Search conversations"}
      onClose={onClose}
      items={(threads ?? [])
        .filter((thread) => thread.kind === "conversation")
        .map((thread) => ({
          id: thread.id,
          label: thread.title ?? "Untitled",
          detail: [
            thread.runsOn === "computer" ? placeLabel("computer") : "Cloud",
            ago(thread.lastMessageAt ?? thread.createdAt),
          ].join("  ·  "),
          run: () => onOpen(thread.id),
        }))}
    />
  )
}

function commandItems(input: {
  readonly settings: Settings
  readonly approvalMode: ApprovalMode | undefined
  readonly models: readonly LanguageModel[]
  readonly newConversation: () => void
  readonly open: (dialog: Dialog) => void
  readonly setPlace: (place: Settings["place"]) => void
  readonly cycleEffort: () => void
  readonly quit: () => void
}): PaletteItem[] {
  const { settings } = input
  return [
    {
      id: "new",
      group: "Conversation",
      label: "New conversation",
      keys: "ctrl+n",
      run: input.newConversation,
    },
    {
      id: "threads",
      group: "Conversation",
      label: "Open a conversation",
      keys: "ctrl+l",
      run: () => input.open("threads"),
    },
    {
      id: "model",
      group: "Agent",
      label: "Model",
      detail: modelLabel(input.models, settings).name,
      keys: "ctrl+o",
      run: () => input.open("models"),
    },
    {
      id: "effort",
      group: "Agent",
      label: "Effort",
      detail: modelLabel(input.models, settings).reasoning ?? "default",
      keys: "ctrl+t",
      run: input.cycleEffort,
    },
    {
      id: "permissions",
      group: "Agent",
      label: "Permissions",
      ...(input.approvalMode ? { detail: approvalLabel(input.approvalMode) } : {}),
      keys: "shift+tab",
      run: () => input.open("permissions"),
    },
    {
      id: "place",
      group: "Agent",
      label:
        settings.place === "computer"
          ? "Run new conversations in the cloud"
          : `Run new conversations on ${placeLabel("computer")}`,
      keys: "tab",
      run: () => input.setPlace(settings.place === "computer" ? "cloud" : "computer"),
    },
    { id: "quit", group: "Sixb", label: "Quit", keys: "ctrl+c", run: input.quit },
  ]
}

function modelItems(
  models: readonly LanguageModel[],
  settings: Settings,
  choose: (
    model: LanguageModel | null,
    reasoning?: LanguageModel["reasoningLevels"][number]
  ) => void
): PaletteItem[] {
  const tiers = models.some((model) => model.tier !== undefined)
  const chosen = settings.model
  const items: PaletteItem[] = tiers
    ? [
        {
          id: "auto",
          group: "Models",
          label: "Auto",
          detail: "the best model for each message",
          current: !chosen,
          run: () => choose(null),
        },
      ]
    : []
  for (const model of models) {
    const current = chosen
      ? chosen.provider === model.provider && chosen.modelId === model.modelId
      : !tiers && model.isDefault
    items.push({
      id: `${model.provider}:${model.modelId}`,
      group: "Models",
      label: model.name,
      detail: [model.tier, model.publisher.name].filter(Boolean).join("  ·  "),
      current,
      run: () => choose(model),
    })
  }
  // How hard the model in effect thinks, when it lets you choose.
  const inEffect = models.find((model) =>
    chosen
      ? chosen.provider === model.provider && chosen.modelId === model.modelId
      : !tiers && model.isDefault
  )
  for (const level of inEffect?.reasoningLevels ?? []) {
    if (level === "provider-default" || !inEffect) continue
    items.push({
      id: `effort:${level}`,
      group: "Effort",
      label: level,
      current: settings.reasoning === level,
      run: () => choose(inEffect, level),
    })
  }
  return items
}

/** The person's own time zone and language, as the app's composer sends them. */
function requesterSettings(): { readonly timeZone: string; readonly locale: string } {
  const { timeZone, locale } = Intl.DateTimeFormat().resolvedOptions()
  return { timeZone, locale }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "error" in error) return String(error.error)
  return String(error)
}

function ago(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1_000)
  if (seconds < 60) return "just now"
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}

/** Text cut to `max` characters at a word, with an ellipsis. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, Math.max(1, max - 1))
  const space = cut.lastIndexOf(" ")
  return `${space > max / 2 ? cut.slice(0, space) : cut}…`
}

/** Put text on the clipboard: pbcopy on macOS, whose Terminal ignores OSC 52; OSC 52 elsewhere. */
async function copy(
  text: string,
  renderer: { copyToClipboardOSC52(text: string): boolean }
): Promise<boolean> {
  if (process.platform === "darwin") {
    const child = Bun.spawn(["pbcopy"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" })
    child.stdin.write(text)
    child.stdin.end()
    return (await child.exited) === 0
  }
  return renderer.copyToClipboardOSC52(text)
}
