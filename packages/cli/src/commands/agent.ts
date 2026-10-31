import { createInterface } from "node:readline/promises"
import {
  type AgentRunStreamEvent,
  createAgentRunSocket,
  createAgentThread,
  decideAgentApproval,
  getAgentThread,
  listAgentThreadApprovals,
  listAgentThreadMessages,
  listAgentThreadRuns,
  listModels,
  postAgentThreadMessage,
} from "@sixb/client"
import { type Connection, connect } from "../tui/connection"
import { folderOf, rememberFolder } from "../tui/folders"
import { toolLine } from "../tui/format"
import { liveRun, reduceLive, shownMessage } from "../tui/parts"
import { LocalRunner } from "../tui/runner"
import { approvalLabel, loadSettings, messageSelection, placeLabel } from "../tui/settings"
import { glyph, paint, palette, tone } from "../ui/theme"

/** Exit status when the turn stopped on calls only the person can decide, and nobody could ask. */
const EXIT_WAITING = 4

/**
 * `sixb agent "<message>"`: one message to the agent, answered in the terminal. The turn runs on
 * this computer in the current folder, or in the cloud with `--cloud`; its steps go to stderr and
 * its answer to stdout, so the answer can be piped.
 */
export async function runAgent(options: {
  readonly text: readonly string[]
  readonly thread?: string
  readonly cloud: boolean
  readonly json: boolean
  readonly apiUrl?: string
  readonly profile?: string
}): Promise<void> {
  const text = options.text.join(" ").trim() || (await readStdin())
  if (!text) throw new Error('[SixbCLI] Give the agent a message: sixb agent "<message>".')

  const connection = await connect(options)
  if ("reason" in connection) {
    throw new Error(
      connection.reason === "unreachable"
        ? `[SixbCLI] Sixb isn't answering at ${connection.apiUrl}.`
        : `[SixbCLI] Sign in first: sixb login ${connection.apiUrl || "<api-url>"}.`
    )
  }
  const { client } = connection
  const settings = await loadSettings()
  const models = (await listModels({ client })).data?.language ?? []

  const thread = options.thread
    ? (await getAgentThread({ client, path: { threadId: options.thread }, throwOnError: true }))
        .data
    : (
        await createAgentThread({
          client,
          body: {
            title: text.split("\n")[0]?.slice(0, 72) ?? "Conversation",
            ...(options.cloud ? {} : { runsOn: "computer" as const }),
          },
          throwOnError: true,
        })
      ).data.thread
  const onComputer = thread.runsOn === "computer"
  if (onComputer) {
    const folder = await folderOf(thread.id)
    if (options.thread && folder !== process.cwd()) {
      throw new Error(
        folder
          ? `[SixbCLI] This conversation works in ${folder}: run sixb agent there.`
          : "[SixbCLI] This conversation started on another computer: open it with sixb there."
      )
    }
    if (!options.thread) await rememberFolder(thread.id, process.cwd())
  }
  const runner = onComputer
    ? new LocalRunner(connection, process.cwd(), (error) => step(tone.fail(errorText(error))))
    : null
  if (!options.json) {
    step(
      `${tone.blue(glyph.mark)} ${tone.strong(placeLabel(onComputer ? "computer" : "cloud"))}` +
        tone.faint(`  ·  ${approvalLabel(settings.approvalMode)}  ·  ${thread.id}`)
    )
  }

  const stop = new AbortController()
  process.once("SIGINT", () => stop.abort())
  try {
    const { data: posted } = await postAgentThreadMessage({
      client,
      path: { threadId: thread.id },
      body: {
        text,
        approvalMode: settings.approvalMode,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        ...messageSelection(models, settings),
      },
      throwOnError: true,
    })
    let runId: string | null = posted.run.id
    while (runId) {
      // A turn this computer could not claim would wait here for nobody.
      const unclaimed = runner?.claim(runId).then((claimed) => !claimed)
      const followed = await follow(connection, runId, options.json, stop.signal, unclaimed)
      if (followed === "unclaimed") {
        process.exitCode = 1
        step(
          tone.fail("This computer couldn't claim the turn: another runner holds it, or it ended.")
        )
        return
      }
      if (followed !== "finished") break
      runId = await afterTurn(connection, thread.id, runId, options.json)
    }
    await printAnswer(connection, thread.id, options.json)
  } finally {
    await runner?.stop()
  }
}

/**
 * Show a turn's steps as they finish, until it ends, the stream fails, the person stops waiting,
 * or `unclaimed` says this computer could not run it.
 */
async function follow(
  connection: Connection,
  runId: string,
  json: boolean,
  signal: AbortSignal,
  unclaimed?: Promise<boolean>
): Promise<"finished" | "stopped" | "failed" | "unclaimed"> {
  let live = liveRun(runId)
  const shown = new Set<string>()
  return new Promise((resolve) => {
    let settled = false
    const settle = (outcome: "finished" | "stopped" | "failed" | "unclaimed") => {
      if (settled) return
      settled = true
      socket.close()
      signal.removeEventListener("abort", onAbort)
      resolve(outcome)
    }
    const onAbort = () => settle("stopped")
    const socket = createAgentRunSocket({
      client: connection.client,
      runId,
      // A turn that ended before the stream opened: its snapshot says so.
      onRunSnapshot: (run) => {
        if (run.status !== "queued" && run.status !== "running") settle("finished")
      },
      onError: (message) => {
        step(tone.fail(message))
        settle("failed")
      },
      onEvent: (event: AgentRunStreamEvent) => {
        live = reduceLive(live, event)
        if (!json) {
          for (const part of live.parts) {
            if (part.kind !== "tool" || part.state === "running" || shown.has(part.id)) continue
            shown.add(part.id)
            const line = toolLine(part)
            const mark = line.held
              ? tone.warn(glyph.live)
              : line.failed || part.state === "error"
                ? tone.fail(glyph.live)
                : tone.ok(glyph.live)
            step(
              `${mark} ${tone.strong(line.verb)}  ${tone.muted(line.detail)}${line.note ? tone.faint(`  ${line.note}`) : ""}`
            )
          }
        }
        if (event.type === "agent.run.finished") settle("finished")
      },
    })
    signal.addEventListener("abort", onAbort)
    void unclaimed?.then((refused) => {
      if (refused) settle("unclaimed")
    })
  })
}

/**
 * What follows a turn's end: the turn that resumes once its held calls are decided, asked here
 * when a person is at the terminal. Null when nothing follows.
 */
async function afterTurn(
  connection: Connection,
  threadId: string,
  runId: string,
  json: boolean
): Promise<string | null> {
  const { client } = connection
  const { data: runs } = await listAgentThreadRuns({ client, path: { threadId } })
  const run = runs?.runs.find((entry) => entry.id === runId)
  if (run?.finishReason !== "awaiting_approval") return null

  const { data } = await listAgentThreadApprovals({
    client,
    path: { threadId },
    query: { status: "pending", runId },
  })
  const approvals = data?.approvals ?? []
  if (approvals.length === 0 || json || !process.stdin.isTTY) {
    for (const approval of approvals) step(tone.warn(`? ${describe(approval.call)}`))
    step(tone.faint(`Decide in the app, or run sixb in this folder and open the conversation.`))
    process.exitCode = EXIT_WAITING
    return null
  }

  const prompt = createInterface({ input: process.stdin, output: process.stderr })
  try {
    for (const approval of approvals) {
      const answer = (
        await prompt.question(
          `${paint("?", { color: palette.amber })} ${tone.strong(describe(approval.call))}  ${tone.muted("[y] allow  [a] always in this thread  [n] deny ")}`
        )
      )
        .trim()
        .toLowerCase()
      await decideAgentApproval({
        client,
        path: { threadId, approvalId: approval.id },
        body:
          answer === "a"
            ? { decision: "approve", always: true }
            : { decision: answer === "y" ? "approve" : "deny" },
        throwOnError: true,
      })
    }
  } finally {
    prompt.close()
  }
  // Deciding the last one resumes the turn as a new run.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { data: thread } = await getAgentThread({ client, path: { threadId } })
    if (thread?.activeRunId && thread.activeRunId !== runId) return thread.activeRunId
    await Bun.sleep(250)
  }
  return null
}

/** The turn's answer: its last message's text, or as JSON. */
async function printAnswer(connection: Connection, threadId: string, json: boolean) {
  const { client } = connection
  const [{ data: messages }, { data: runs }] = await Promise.all([
    listAgentThreadMessages({ client, path: { threadId }, query: { order: "desc", limit: "1" } }),
    listAgentThreadRuns({ client, path: { threadId }, query: { order: "desc", limit: "1" } }),
  ])
  const last = messages?.messages[0]
  const shown = last ? shownMessage(last) : null
  const answer =
    shown?.role === "assistant"
      ? shown.parts.flatMap((part) => (part.kind === "text" ? [part.text.trim()] : [])).join("\n\n")
      : ""
  const run = runs?.runs[0]
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ threadId, runId: run?.id, status: run?.status, finishReason: run?.finishReason, text: answer })}\n`
    )
    return
  }
  if (answer) process.stdout.write(`\n${process.stdout.isTTY ? styled(answer) : answer}\n`)
  if (run?.status === "failed") {
    process.exitCode = 1
    step(tone.fail(run.error?.message ?? "The turn failed."))
  }
}

function describe(
  call:
    | { readonly kind: "action"; readonly actionId: string }
    | { readonly kind: "workflow"; readonly workflowId: string }
): string {
  return call.kind === "action" ? `Run ${call.actionId}?` : `Start the ${call.workflowId} workflow?`
}

function step(line: string): void {
  process.stderr.write(`  ${line}\n`)
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ""
  let text = ""
  for await (const chunk of process.stdin) text += chunk.toString()
  return text.trim()
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The answer as a terminal shows it: bold and inline code styled, their markers gone. Piped, the
 * answer stays the markdown it is.
 */
function styled(markdown: string): string {
  return markdown
    .replace(/\*\*([^*\n]+)\*\*/g, (_, text: string) => tone.strong(text))
    .replace(/`([^`\n]+)`/g, (_, text: string) => tone.blue(text))
}
