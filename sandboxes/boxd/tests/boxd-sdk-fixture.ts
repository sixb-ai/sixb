import { NotFoundError } from "@boxd-sh/sdk"
import type {
  BoxdClient,
  BoxdCommandStream,
  BoxdCreateMachineRequest,
  BoxdMachineRecord,
} from "../src/boxd-client"

/** What a scripted command does: its output and exit code, or `"hang"` until it is closed. */
export type FakeCommand =
  | { readonly stdout?: string; readonly stderr?: string; readonly exitCode?: number }
  | "hang"
  | Error

interface FakeMachine {
  id: string
  name: string
  status: string
  labels: Record<string, string>
}

/**
 * An in-memory boxd: machines, the calls made on them in order, and command lines answered by a
 * script. Unscripted commands exit 0 with no output.
 */
export class FakeBoxd implements BoxdClient {
  readonly machines = new Map<string, FakeMachine>()
  readonly calls: string[] = []
  readonly commands: string[] = []
  readonly uploads: { readonly id: string; readonly path: string; readonly contents: string }[] = []
  readonly egress = new Map<string, readonly string[]>()
  readonly creates: BoxdCreateMachineRequest[] = []
  private readonly settling = new Set<string>()
  /** The streams `close()` was called on, by command line. */
  readonly closed: string[] = []
  /** Answer a command line; the first matching rule wins. */
  script: (commandLine: string) => FakeCommand | undefined = () => undefined
  failCreate: Error | undefined
  failGet: Error | undefined
  failDelete: Error | undefined
  failHibernate: Error | undefined
  failUpload: Error | undefined
  private nextId = 1

  async create(request: BoxdCreateMachineRequest): Promise<BoxdMachineRecord> {
    this.calls.push(`create ${request.name}`)
    this.creates.push(request)
    if (this.failCreate) throw this.failCreate
    const machine = {
      id: `machine-${this.nextId++}`,
      name: request.name,
      status: "running",
      labels: { ...request.labels },
    }
    this.machines.set(machine.id, machine)
    if (request.egress) this.egress.set(machine.id, request.egress)
    return { ...machine }
  }

  async get(nameOrId: string): Promise<BoxdMachineRecord> {
    this.calls.push(`get ${nameOrId}`)
    if (this.failGet) throw this.failGet
    const machine = [...this.machines.values()].find(
      (candidate) => candidate.id === nameOrId || candidate.name === nameOrId
    )
    if (!machine) throw notFound(nameOrId)
    const seen = { ...machine }
    if (this.settling.delete(machine.id)) machine.status = "hibernated"
    return seen
  }

  async waitUntilReady(id: string): Promise<BoxdMachineRecord> {
    this.calls.push(`ready ${id}`)
    return { ...this.machine(id) }
  }

  exec(id: string, commandLine: string): BoxdCommandStream {
    this.calls.push(`exec ${id}`)
    this.commands.push(commandLine)
    const answer = this.script(commandLine) ?? {}
    return new FakeStream(answer, () => this.closed.push(commandLine))
  }

  async upload(id: string, path: string, contents: string | Uint8Array): Promise<void> {
    this.calls.push(`upload ${id} ${path}`)
    if (this.failUpload) throw this.failUpload
    this.uploads.push({
      id,
      path,
      contents: typeof contents === "string" ? contents : Buffer.from(contents).toString("utf8"),
    })
  }

  async setEgress(id: string, entries: readonly string[]): Promise<void> {
    this.calls.push(`egress ${id} ${JSON.stringify(entries)}`)
    this.egress.set(id, entries)
  }

  async hibernate(id: string): Promise<void> {
    this.calls.push(`hibernate ${id}`)
    if (this.failHibernate) throw this.failHibernate
    // boxd answers before the machine is down: the next read still sees it running.
    const machine = this.machine(id)
    machine.status = "hibernating"
    this.settling.add(id)
  }

  async wake(id: string): Promise<void> {
    this.calls.push(`wake ${id}`)
    this.machine(id).status = "running"
  }

  async start(id: string): Promise<void> {
    this.calls.push(`start ${id}`)
    this.machine(id).status = "running"
  }

  async delete(id: string): Promise<void> {
    this.calls.push(`delete ${id}`)
    if (this.failDelete) throw this.failDelete
    if (!this.machines.delete(id)) throw notFound(id)
  }

  /** Add a machine as if an earlier execution had created it. */
  seed(machine: FakeMachine): void {
    this.machines.set(machine.id, machine)
  }

  private machine(id: string): FakeMachine {
    const machine = this.machines.get(id)
    if (!machine) throw notFound(id)
    return machine
  }
}

function notFound(nameOrId: string): NotFoundError {
  return new NotFoundError(`machine ${nameOrId} not found`, 5)
}

class FakeStream implements BoxdCommandStream {
  readonly stdout: AsyncIterable<Uint8Array>
  readonly stderr: AsyncIterable<Uint8Array>
  private readonly exit: Promise<number>
  private onClose: (() => void) | undefined

  constructor(answer: FakeCommand, closed: () => void) {
    if (answer === "hang") {
      let release: (error: Error) => void = () => {}
      this.exit = new Promise<number>((_, reject) => {
        release = reject
      })
      this.stdout = once("partial out\n", this.exit)
      this.stderr = once("partial err\n", this.exit)
      this.onClose = () => {
        closed()
        release(new Error("Cancelled on client"))
      }
      return
    }
    this.onClose = closed
    if (answer instanceof Error) {
      this.exit = Promise.reject(answer)
      this.exit.catch(() => {})
      this.stdout = once("", this.exit)
      this.stderr = once("", this.exit)
      return
    }
    this.exit = Promise.resolve(answer.exitCode ?? 0)
    this.stdout = once(answer.stdout ?? "", this.exit)
    this.stderr = once(answer.stderr ?? "", this.exit)
  }

  wait(): Promise<number> {
    return this.exit
  }

  close(): void {
    this.onClose?.()
    this.onClose = undefined
  }
}

/** Yield `text`, then end with the command: as the SDK's queue does. */
async function* once(text: string, exit: Promise<number>): AsyncIterable<Uint8Array> {
  if (text) yield new TextEncoder().encode(text)
  await exit
}
