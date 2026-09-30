import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { shellQuote } from "./shell"

export interface RunOptions {
  /** Streamed to the script's standard input. The script itself then travels as an argument. */
  readonly stdin?: ReadableStream<Uint8Array>
  /**
   * Every line the script prints, and which stream it came from. Read results from `stdout`
   * only: a login script or a failed redirection can write to `stderr` first.
   */
  readonly onLine?: (line: string, stream: "stdout" | "stderr") => void
  /** Attach the terminal, so the remote command stops when you press Ctrl-C. */
  readonly terminal?: boolean
}

/** Runs bash scripts on a deployment's server. */
export interface RemoteShell {
  /** Rejects with the script's last output lines when it exits non-zero. */
  run(script: string, options?: RunOptions): Promise<void>
  close(): Promise<void>
}

export class RemoteScriptError extends Error {
  readonly exitCode: number

  constructor(message: string, exitCode: number) {
    super(message)
    this.name = "RemoteScriptError"
    this.exitCode = exitCode
  }
}

const OUTPUT_TAIL = 20

/**
 * One SSH connection, shared by every script a command runs through OpenSSH's connection
 * multiplexing. Never prompts: a password, passphrase, or unknown host key fails with a message
 * instead of hanging a deploy.
 */
export class SshShell implements RemoteShell {
  private constructor(
    private readonly destination: string,
    private readonly controlDir: string
  ) {}

  static async open(destination: string): Promise<SshShell> {
    // Kept short: a socket path longer than about 100 characters cannot be bound.
    const controlDir = await mkdtemp(join(tmpdir(), "sixb-ssh-"))
    const shell = new SshShell(destination, controlDir)
    try {
      await runProcess(["ssh", ...shell.options(), "-M", "-N", "-f", destination], {})
    } catch (error) {
      await rm(controlDir, { recursive: true, force: true })
      throw sshError(destination, error)
    }
    return shell
  }

  async run(script: string, options: RunOptions = {}): Promise<void> {
    const inline = options.stdin !== undefined || options.terminal === true
    const command = inline ? ["bash", "-c", shellQuote(script)] : ["bash", "-s"]
    try {
      await runProcess(
        [
          "ssh",
          ...this.options(),
          ...(options.terminal ? ["-tt"] : []),
          this.destination,
          command.join(" "),
        ],
        {
          ...options,
          ...(inline ? {} : { stdin: new Blob([script]).stream() }),
        }
      )
    } catch (error) {
      throw sshError(this.destination, error)
    }
  }

  async close(): Promise<void> {
    await runProcess(["ssh", ...this.options(), "-O", "exit", this.destination], {}).catch(() => {})
    await rm(this.controlDir, { recursive: true, force: true })
  }

  private options(): string[] {
    return [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      // Notices a dead connection during a long build instead of waiting forever.
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ControlMaster=auto",
      "-o",
      "ControlPersist=60",
      "-o",
      "LogLevel=ERROR",
      "-S",
      join(this.controlDir, "control"),
    ]
  }
}

/** Runs the scripts on this machine instead, with its own home. For tests. */
export class LocalShell implements RemoteShell {
  constructor(private readonly env: Readonly<Record<string, string>> = {}) {}

  async run(script: string, options: RunOptions = {}): Promise<void> {
    const inline = options.stdin !== undefined
    await runProcess(inline ? ["bash", "-c", script] : ["bash", "-s"], {
      ...options,
      ...(inline ? {} : { stdin: new Blob([script]).stream() }),
      env: this.env,
    })
  }

  async close(): Promise<void> {}
}

async function runProcess(
  command: readonly string[],
  options: RunOptions & { readonly env?: Readonly<Record<string, string>> }
): Promise<void> {
  if (options.terminal) {
    const child = Bun.spawn([...command], { stdio: ["inherit", "inherit", "inherit"] })
    const exitCode = await child.exited
    if (exitCode !== 0) throw new RemoteScriptError(`exited with code ${exitCode}`, exitCode)
    return
  }

  const child = Bun.spawn([...command], {
    stdin: options.stdin ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...options.env },
  })
  const tail: string[] = []
  const onLine = (stream: "stdout" | "stderr") => (line: string) => {
    tail.push(line)
    if (tail.length > OUTPUT_TAIL) tail.shift()
    options.onLine?.(line, stream)
  }

  const [exitCode] = await Promise.all([
    child.exited,
    options.stdin && child.stdin ? pump(options.stdin, child.stdin) : undefined,
    readLines(child.stdout, onLine("stdout")),
    readLines(child.stderr, onLine("stderr")),
  ])
  if (exitCode !== 0) {
    throw new RemoteScriptError(
      tail.length > 0 ? tail.join("\n") : `exited with code ${exitCode}`,
      exitCode
    )
  }
}

async function pump(source: ReadableStream<Uint8Array>, sink: Bun.FileSink): Promise<void> {
  const reader = source.getReader()
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      sink.write(chunk.value)
      await sink.flush()
    }
  } finally {
    await sink.end()
  }
}

async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    buffer += decoder.decode(chunk.value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ""
    for (const line of lines) onLine(line)
  }
  buffer += decoder.decode()
  if (buffer) onLine(buffer)
}

/** OpenSSH's own failures, which exit 255, reworded as what to do about them. */
export function sshError(destination: string, error: unknown): Error {
  if (!(error instanceof RemoteScriptError) || error.exitCode !== 255) {
    return error instanceof Error ? error : new Error(String(error))
  }
  const output = error.message
  const host = destination.split("@").at(-1) ?? destination
  const reason = /REMOTE HOST IDENTIFICATION HAS CHANGED/.test(output)
    ? `${host} answered with a host key other than the one on record. If the server was rebuilt, remove the old key with \`ssh-keygen -R ${host}\` and connect once to accept the new one; for CI, run \`sixb deploy ci\` again. Otherwise, something else is answering at that address: do not deploy to it.`
    : /Host key verification failed/.test(output)
      ? `The host key for ${host} is not trusted yet. Connect once with \`ssh ${destination}\`, check the fingerprint, and accept it.`
      : /Permission denied/.test(output)
        ? `The server refused your SSH key for ${destination}. Load it into your SSH agent, or ask someone with access to authorize it.`
        : /Could not resolve hostname/.test(output)
          ? `${host} does not resolve. Check the target's host.`
          : /Connection refused|timed out|No route to host/.test(output)
            ? `Could not reach ${host} over SSH.`
            : `SSH to ${destination} failed.`
  return new RemoteScriptError(`[SshTarget] ${reason}\n${output}`, error.exitCode)
}
