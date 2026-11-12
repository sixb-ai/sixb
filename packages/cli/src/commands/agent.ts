import { realpath } from "node:fs/promises"
import { createInterface } from "node:readline/promises"
import {
  type AgentRunStreamEvent,
  createAgentRunSocket,
  createAgentThread,
  decideAgentApproval,
  getAgentRun,
  getAgentThread,
  listAgentThreadApprovals,
  listAgentThreadMessages,
  listAgentThreadRuns,
  listModels,
  postAgentThreadMessage,
} from "@sixb/client"
import { type Connection, connect } from "../lib/connection"
import { errorMessage } from "../lib/errors"
import { thisComputer, thisComputerId } from "../runner/computer"
import { LocalRunner } from "../runner/local-runner"
import { askedInReply, pickedAnswer, toolLine } from "../tui/format"
import { liveRun, reduceLive, shownMessage } from "../tui/parts"
import {
  APPROVAL_MODES,
  type ApprovalMode,
  approvalLabel,
  loadSettings,
  messageSelection,
  placeLabel,
} from "../tui/settings"
import { glyph, paint, palette, tone } from "../ui/theme"

/** Exit status when the turn stopped on calls only the person can decide, and nobody could ask. */
const EXIT_WAITING = 4
/** Exit status when the turn waits for a computer that isn't connected. */
const EXIT_OFFLINE = 5
/** How often this checks that something still holds the folder of a turn it waits for. */
const HOLDER_CHECK_MS = 1_000

/**
 * `sixb agent "<message>"`: one message to the agent, answered in the terminal. The turn runs on
 * this computer in the current folder, or in the cloud with `--cloud`; its steps go to stderr and
 * its answer to stdout, so the answer can be piped. A conversation elsewhere, or a folder a
 * connected sixb holds, runs there, and this follows it.
 */
export async function runAgent(options: {
  readonly text: readonly string[]
  readonly thread?: string
  readonly cloud: boolean
  /** The turn's mode; without it, the person's in the thread applies, as for a message in the web. */
  readonly approvalMode?: string
  readonly json: boolean
  /** Send it and exit, without following the turn. */
  readonly detach: boolean
  readonly apiUrl?: string
  readonly profile?: string
}): Promise<void> {
  const approvalMode = parseApprovalMode(options.approvalMode)
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
  // As the project keeps it, and the local sandbox compares it: its real path.
  const folder = await realpath(process.cwd())
  const models = (await listModels({ client })).data?.language ?? []

  const threadId =
    options.thread ??
    (
      await createAgentThread({
        client,
        body: {
          title: text.split("\n")[0]?.slice(0, 72) ?? "Conversation",
          ...(options.cloud
            ? {}
            : { runsOn: "computer" as const, computer: { ...(await thisComputer()), folder } }),
        },
        throwOnError: true,
      })
    ).data.thread.id
  // Read as the person: it says the mode their turns run in there.
  const { data: thread } = await getAgentThread({ client, path: { threadId }, throwOnError: true })
  const onComputer = thread.runsOn === "computer"
  const place = thread.computer
  if (onComputer && !place) {
    throw new Error(
      "[SixbCLI] This conversation has no folder yet: open it with sixb in its folder, and press ctrl+f."
    )
  }
  const here = onComputer && place?.id === (await thisComputerId()) && place.folder === folder
  const runner = here
    ? new LocalRunner(connection, folder, (error) => step(tone.fail(errorMessage(error))))
    : null
  if (runner) runner.keepsAwake = settings.keepAwake
  if (!options.json) {
    const mode = approvalMode ?? thread.approvalMode
    step(
      `${tone.blue(glyph.mark)} ${tone.strong(placeLabel(onComputer ? "computer" : "cloud"))}` +
        tone.faint(`  ·  ${mode ? `${approvalLabel(mode)}  ·  ` : ""}${thread.id}`)
    )
  }

  // In a conversation that asked a question with choices, a number answers with that choice.
  const last = options.thread ? await lastMessage(connection, threadId) : null
  const sent = last ? pickedAnswer([last], text) : text

  const stop = new AbortController()
  process.once("SIGINT", () => stop.abort())
  try {
    const { data: posted } = await postAgentThreadMessage({
      client,
      path: { threadId: thread.id },
      body: {
        text: sent,
        ...(approvalMode ? { approvalMode } : {}),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        ...messageSelection(models, settings),
      },
      throwOnError: true,
    })
    let runId: string | null = posted.run.id
    if (options.detach) {
      if (onComputer && !thread.computer?.online) step(tone.faint(waitingNote(thread.computer)))
      printSent(thread.id, runId, options.json)
      return
    }

    let followed: Awaited<ReturnType<typeof follow>> = "finished"
    while (runId) {
      // Only while this follows: once it stops, nothing may start a turn nobody follows.
      const watching = new AbortController()
      const stopWatching = () => watching.abort()
      stop.signal.addEventListener("abort", stopWatching, { once: true })
      const nobody =
        onComputer && runnerUntilHeld(connection, thread.id, runId, runner, watching.signal)
      followed = await follow(connection, runId, options.json, stop.signal, nobody || undefined)
      stopWatching()
      stop.signal.removeEventListener("abort", stopWatching)
      if (followed === "offline") {
        const { data } = await getAgentThread({ client, path: { threadId: thread.id } })
        step(tone.faint(waitingNote(data?.computer ?? thread.computer)))
        printSent(thread.id, runId, options.json)
        process.exitCode = EXIT_OFFLINE
        return
      }
      if (followed === "unclaimed") {
        process.exitCode = 1
        step(tone.fail("This computer couldn't claim the turn."))
        return
      }
      if (followed !== "finished") break
      runId = await afterTurn(connection, thread.id, runId, options.json)
    }

    // A lost stream or Ctrl+C leaves a turn that may still run: its answer is not the turn's.
    if (followed !== "finished") {
      process.exitCode = 1
      if (followed === "stopped") step(tone.fail(`Stopped waiting for the turn in ${thread.id}.`))
    }

    await printAnswer(connection, thread.id, options.json)
  } finally {
    await runner?.stop()
  }
}

/**
 * Watch a queued turn until something runs it. While a sixb holds its folder that's whose it is, even
 * if busy: it runs one at a time, and taking the turn would run two. Once nothing does, which a
 * crashed sixb's session reaches within a minute, this computer runs it if it's the place to, and
 * otherwise it waits for a computer nobody has open. Null when the turn left the queue by itself.
 * Rejects with the API's answer once it refuses these reads for good.
 */
async function runnerUntilHeld(
  connection: Connection,
  threadId: string,
  runId: string,
  runner: LocalRunner | null,
  signal: AbortSignal
): Promise<"unclaimed" | "offline" | null> {
  const { client } = connection
  const readRun = () => getAgentRun({ client, path: { runId } })
  while (!signal.aborted) {
    const [threadRead, runRead] = await Promise.all([
      getAgentThread({ client, path: { threadId } }),
      readRun(),
    ])
    if (signal.aborted) return null
    if (refusedForGood(threadRead)) throw threadRead.error
    if (refusedForGood(runRead)) throw runRead.error
    const thread = threadRead.data
    const status = runRead.data?.status
    // Any other read that failed says nothing about who holds the folder: only a later one can.
    if (thread && status) {
      if (status !== "queued") return null
      if (!thread.computer?.online) {
        if (!runner) return "offline"
        if (await runner.claim(runId)) return null
        // A read that fails here can't say it left the queue, and nothing else here will run it.
        const after = (await readRun()).data?.status
        return after === undefined || after === "queued" ? "unclaimed" : null
      }
    }
    await Bun.sleep(HOLDER_CHECK_MS)
  }
  return null
}

/** An answer that won't change by asking again: signed out, no access, or nothing there now. */
function refusedForGood(read: { readonly response?: Response }): boolean {
  return [401, 403, 404].includes(read.response?.status ?? 0)
}

/** Where a turn waits, for a person reading why nothing is happening yet. */
function waitingNote(computer: { readonly name: string; readonly folder: string } | undefined) {
  return computer
    ? `It waits until ${computer.folder} is connected on ${computer.name}: sixb connect there, or sixb with messages from the web on.`
    : "It waits for its computer."
}

/** A turn asked for and not followed: what a script needs to find it again. */
function printSent(threadId: string, runId: string, json: boolean): void {
  process.stdout.write(
    json ? `${JSON.stringify({ threadId, runId, status: "queued" })}\n` : `${threadId}\n`
  )
}

/**
 * Show a turn's steps as they finish, until it ends, the stream fails, the person stops waiting,
 * or `nobody` says nothing will run it. Rejects when `nobody` does.
 */
async function follow(
  connection: Connection,
  runId: string,
  json: boolean,
  signal: AbortSignal,
  nobody?: Promise<"unclaimed" | "offline" | null>
): Promise<"finished" | "stopped" | "failed" | "unclaimed" | "offline"> {
  let live = liveRun(runId)
  const shown = new Set<string>()
  return new Promise((resolve, reject) => {
    let settled = false
    const end = (answer: () => void) => {
      if (settled) return
      settled = true
      socket.close()
      signal.removeEventListener("abort", onAbort)
      answer()
    }
    const settle = (outcome: "finished" | "stopped" | "failed" | "unclaimed" | "offline") =>
      end(() => resolve(outcome))
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
            // A question's choices are what the person answers with: they read under its line.
            if (part.name === "ask") {
              for (const row of line.preview ?? []) step(tone.faint(`  ${row}`))
            }
          }
        }
        if (event.type === "agent.run.finished") settle("finished")
      },
    })
    signal.addEventListener("abort", onAbort)
    void nobody?.then(
      (outcome) => {
        if (outcome) settle(outcome)
      },
      (error: unknown) => end(() => reject(error))
    )
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
    step(tone.faint("Decide in the app, or open the conversation with sixb in its folder."))
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

/** The thread's last message, as the TUI shows it. */
async function lastMessage(connection: Connection, threadId: string) {
  const { data } = await listAgentThreadMessages({
    client: connection.client,
    path: { threadId },
    query: { order: "desc", limit: "1" },
  })
  const last = data?.messages[0]
  return last ? shownMessage(last) : null
}

/**
 * The turn's answer: its last message's text, or as JSON. A turn that ended on a question gives
 * the questions, each with its choices, and how to answer.
 */
async function printAnswer(connection: Connection, threadId: string, json: boolean) {
  const { client } = connection
  const [shown, { data: runs }] = await Promise.all([
    lastMessage(connection, threadId),
    listAgentThreadRuns({ client, path: { threadId }, query: { order: "desc", limit: "1" } }),
  ])
  const questions = askedInReply(shown)
  const answer =
    shown?.role === "assistant"
      ? shown.parts.flatMap((part) => (part.kind === "text" ? [part.text.trim()] : [])).join("\n\n")
      : ""
  const run = runs?.runs[0]

  // Set before the JSON goes out: a script reads the code, not the status in the answer.
  if (run?.status === "failed" || run?.status === "cancelled") process.exitCode = 1

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ threadId, runId: run?.id, status: run?.status, finishReason: run?.finishReason, text: answer, ...(questions.length > 0 ? { questions } : {}) })}\n`
    )
    return
  }
  if (answer) process.stdout.write(`\n${process.stdout.isTTY ? styled(answer) : answer}\n`)
  if (questions.length > 0) {
    process.stdout.write(`\n${questionsText(questions)}\n`)
    const byNumber = questions.length === 1 && (questions[0]?.choices.length ?? 0) > 0
    step(
      tone.faint(
        `Answer with: sixb agent --thread ${threadId} "<answer>"${byNumber ? ", or a choice's number" : ""}`
      )
    )
  }
  if (run?.status === "failed") step(tone.fail(run.error?.message ?? "The turn failed."))
  if (run?.status === "cancelled") step(tone.fail("The turn was stopped."))
}

/** The questions a turn ended on, each with its choices numbered, as plain text. */
export function questionsText(
  questions: readonly { readonly question: string; readonly choices: readonly string[] }[]
): string {
  return questions
    .map((question, index) =>
      [
        questions.length > 1 ? `${index + 1}. ${question.question}` : question.question,
        ...question.choices.map(
          (choice, at) => `${questions.length > 1 ? "     " : "  "}${at + 1}. ${choice}`
        ),
      ].join("\n")
    )
    .join("\n\n")
}

function parseApprovalMode(value: string | undefined): ApprovalMode | undefined {
  if (value === undefined) return undefined

  const mode = APPROVAL_MODES.find((entry) => entry.mode === value)?.mode
  if (!mode) {
    throw new Error(
      `[SixbCLI] --approval-mode takes ${APPROVAL_MODES.map((entry) => entry.mode).join(", ")}; got '${value}'.`
    )
  }
  return mode
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

/**
 * The answer as a terminal shows it: bold and inline code styled, their markers gone. Piped, the
 * answer stays the markdown it is.
 */
function styled(markdown: string): string {
  return markdown
    .replace(/\*\*([^*\n]+)\*\*/g, (_, text: string) => tone.strong(text))
    .replace(/`([^`\n]+)`/g, (_, text: string) => tone.blue(text))
}
