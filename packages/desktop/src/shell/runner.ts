import { spawn } from "node:child_process"
import { delimiter } from "node:path"

/** The program `writeDesktopApp` compiles, in the runner's directory. */
export const RUNNER_BINARY = "sixb-runner"

/** How long a person's shell gets to say what their PATH is. */
const LOGIN_SHELL_WAIT_MS = 3_000
/** How long a page waits to hear which folders are allowed, before asking for one instead. */
const FOLDERS_WAIT_MS = 10_000
/** How long the runner gets to end a running turn and close its sessions. */
const STOP_WAIT_MS = 12_000
const RESTART_WAIT_MS = { first: 2_000, longest: 60_000 } as const
/** Running this long, the runner wasn't what failed quickly: the next restart waits the least again. */
const STEADY_MS = 60_000
/** Exit status of a runner whose sign-in ended. */
const EXIT_SIGNED_OUT = 3

export interface RunnerProcess {
  /** One line of JSON from the runner. */
  onLine(listener: (line: string) => void): void
  readonly exited: Promise<number>
  write(line: string): void
  /** Close its stdin, which it ends with. */
  end(): void
  kill(): void
}

export interface DesktopComputer {
  readonly id: string
  readonly name: string
}

type RunnerCommand = {
  readonly type: "allow" | "forget"
  readonly folder: string
}

/**
 * The main process's hold on the program that runs the agent on this computer: it starts it, keeps it
 * started while the app is open, and stops it on quit. It holds no sign-in: the program does, and
 * only says where to send the person to approve one.
 */
export class DesktopRunner {
  private process: RunnerProcess | null = null
  private computer: DesktopComputer | null = null
  private folderList: readonly string[] = []
  private waitingForComputer: {
    readonly resolve: (computer: DesktopComputer) => void
    readonly reject: (error: Error) => void
  }[] = []
  private foldersKnown = false
  private waitingForFolders: ((folders: readonly string[]) => void)[] = []
  private unsent: RunnerCommand[] = []
  private restart: ReturnType<typeof setTimeout> | null = null
  private restartWait: number = RESTART_WAIT_MS.first
  private stopping = false

  constructor(
    private readonly options: {
      readonly start: () => RunnerProcess
      /** A page in the system browser to approve this computer's sign-in on. */
      readonly onSignIn: (url: string) => void
      readonly onProblem: (message: string) => void
    }
  ) {}

  start(): void {
    if (this.stopping) return
    const started = Date.now()
    const process = this.options.start()
    this.process = process
    process.onLine((line) => this.hear(line))
    for (const command of this.unsent.splice(0)) process.write(JSON.stringify(command))
    void process.exited.then((code) => {
      this.process = null
      if (this.stopping) return
      if (Date.now() - started >= STEADY_MS) this.restartWait = RESTART_WAIT_MS.first
      // A sign-in that ended is no problem to report: started again, it waits for a new one.
      if (code !== EXIT_SIGNED_OUT) {
        this.options.onProblem(`What runs the agent quit with exit code ${code}.`)
      }
      // Told it failed, not that there's nothing to run on: a message mustn't go elsewhere on a guess.
      for (const { reject } of this.waitingForComputer.splice(0)) {
        reject(new Error("[SixbDesktop] What runs the agent on this computer couldn't start."))
      }
      this.answerFolders()
      this.restart = setTimeout(() => this.start(), this.restartWait)
      this.restartWait = Math.min(this.restartWait * 2, RESTART_WAIT_MS.longest)
    })
  }

  /** This computer, once the runner has said. Rejects if it quits before it does. */
  about(): Promise<DesktopComputer> {
    if (this.computer) return Promise.resolve(this.computer)
    return new Promise((resolve, reject) => this.waitingForComputer.push({ resolve, reject }))
  }

  /** The folders allowed, once the runner knows: a page asking early mustn't take them for none. */
  folders(): Promise<readonly string[]> {
    if (this.foldersKnown) return Promise.resolve(this.folderList)
    return new Promise((resolve) => {
      // A runner that can't read its config keeps trying, and a message mustn't wait on that for good.
      const timer = setTimeout(() => this.answerFolders(), FOLDERS_WAIT_MS)
      this.waitingForFolders.push((folders) => {
        clearTimeout(timer)
        resolve(folders)
      })
    })
  }

  allow(folder: string): void {
    this.send({ type: "allow", folder })
    // A page asking right after choosing finds it there, before the runner has said so.
    if (!this.folderList.includes(folder)) this.folderList = [...this.folderList, folder]
  }

  forget(folder: string): void {
    this.send({ type: "forget", folder })
    this.folderList = this.folderList.filter((known) => known !== folder)
  }

  /** Let it end a running turn and close its sessions, within a limit. */
  async stop(): Promise<void> {
    this.stopping = true
    if (this.restart) clearTimeout(this.restart)
    const process = this.process
    if (!process) return
    process.end()
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), STOP_WAIT_MS)
    })
    if ((await Promise.race([process.exited, late])) === "late") process.kill()
    clearTimeout(timer)
  }

  private send(command: RunnerCommand): void {
    if (this.process) this.process.write(JSON.stringify(command))
    else this.unsent.push(command)
  }

  private answerFolders(): void {
    this.foldersKnown = true
    for (const answer of this.waitingForFolders.splice(0)) answer(this.folderList)
  }

  private hear(line: string): void {
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line)
    } catch {
      return
    }
    switch (event.type) {
      case "computer":
        if (typeof event.id === "string" && typeof event.name === "string") {
          const computer = { id: event.id, name: event.name }
          this.computer = computer
          for (const { resolve } of this.waitingForComputer.splice(0)) resolve(computer)
        }
        return
      case "folders":
        if (Array.isArray(event.folders)) this.folderList = event.folders.map(String)
        this.answerFolders()
        return
      // Nothing runs in the list on file until it's signed in: none, so the next message asks, and
      // answering signs in. It would otherwise wait on a sign-in nobody was asked for.
      case "signed-out":
      case "signed-out-waiting":
        this.folderList = []
        this.answerFolders()
        return
      // It can't say which until the project answers: the last it said, for now.
      case "unreachable":
        this.answerFolders()
        return
      case "sign-in":
        if (typeof event.url === "string") this.options.onSignIn(event.url)
        return
      case "sign-in-failed":
        this.folderList = []
        if (typeof event.message === "string") this.options.onProblem(event.message)
        return
      case "session.lost":
      case "error":
        if (typeof event.message === "string") this.options.onProblem(event.message)
    }
  }
}

/** The runner as a child process of this one, its stderr for the app's own log. */
export function startRunnerProcess(
  command: readonly [string, ...string[]],
  env: NodeJS.ProcessEnv
): RunnerProcess {
  const [file, ...args] = command
  const child = spawn(file, args, { env, stdio: ["pipe", "pipe", "inherit"] })
  // A runner that's gone by the time this writes: its restart is what answers that.
  child.stdin.on("error", () => {})
  const exited = new Promise<number>((resolve) => {
    child.once("error", () => resolve(-1))
    child.once("exit", (code) => resolve(code ?? -1))
  })
  return {
    onLine(listener) {
      let rest = ""
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        rest += chunk
        const lines = rest.split("\n")
        rest = lines.pop() ?? ""
        for (const line of lines) listener(line)
      })
    },
    exited,
    write: (line) => void child.stdin.write(`${line}\n`),
    end: () => void child.stdin.end(),
    kill: () => void child.kill("SIGKILL"),
  }
}

/**
 * The environment the runner, and the agent's commands, run in. An app opened from the Dock gets a
 * bare PATH, so the person's shell says what theirs is: the agent uses the tools they do. The `bun`
 * beside the runner comes last, for someone with neither Bun nor Node.
 */
export async function runnerEnvironment(
  runnerDir: string,
  base: NodeJS.ProcessEnv
): Promise<NodeJS.ProcessEnv> {
  const shell = await readLoginShell(base.SHELL).catch(() => null)
  const env = Object.fromEntries(
    // What a terminal `sixb dev` was told about its own project is no business of this one.
    Object.entries(base).filter(([name]) => !name.startsWith("SIXB_"))
  )
  return {
    ...env,
    PATH: [shell?.path ?? base.PATH ?? "", runnerDir].join(delimiter),
    // Where `sixb` keeps its sign-in, and so what the agent's commands are kept from.
    ...(shell?.configHome ? { XDG_CONFIG_HOME: shell.configHome } : {}),
  }
}

/**
 * Between markers, as a shell's startup files may print whatever they like.
 *
 * In a session of its own, with no terminal: an interactive shell takes over the one it inherits. Under
 * `sixb dev --desktop` that's the person's, and whatever reads a key or a mouse move there meanwhile is
 * stopped by it, for good, leaving the terminal as it was.
 *
 * A limit of its own, and a kill that can't be ignored: an interactive shell ignores `execFile`'s, and
 * what it started can hold the pipe open long after it's gone. A startup file that waits on a person
 * mustn't stop the agent.
 */
function readLoginShell(
  shell: string | undefined
): Promise<{ readonly path: string; readonly configHome: string } | null> {
  if (!shell) return Promise.resolve(null)
  return new Promise((resolve) => {
    // `spawn`, not `execFile`, which ignores `detached`.
    const child = spawn(
      shell,
      ["-ilc", 'printf "__SIXB_SHELL__%s\\n%s__SIXB_SHELL__" "$PATH" "$XDG_CONFIG_HOME"'],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] }
    )
    let printed = ""
    const said = () => {
      const [path, configHome] =
        /__SIXB_SHELL__(.*)__SIXB_SHELL__/s.exec(printed)?.[1]?.split("\n") ?? []
      return path ? { path, configHome: configHome ?? "" } : null
    }
    const timer = setTimeout(() => {
      // The whole group: it's alone in it, with whatever its startup files began.
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch {
          // Gone already.
        }
      }
      // What it said counts, whatever it left holding the pipe.
      resolve(said())
    }, LOGIN_SHELL_WAIT_MS)
    child.stdout.on("data", (chunk) => {
      printed += String(chunk)
    })
    child.once("error", () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.once("close", () => {
      clearTimeout(timer)
      resolve(said())
    })
  })
}
