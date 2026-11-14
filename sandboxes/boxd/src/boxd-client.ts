import {
  Boxd,
  ConflictError,
  Machine,
  type MachineSize,
  type MachineSpecBuilder,
  NotFoundError,
} from "@boxd-sh/sdk"

/** What the provider reads from a machine. */
export interface BoxdMachineRecord {
  readonly id: string
  readonly name: string
  readonly status: string
  readonly labels?: Readonly<Record<string, string>>
}

/** One running command. Iterate both streams while waiting; `close()` kills what it started. */
export interface BoxdCommandStream {
  readonly stdout: AsyncIterable<Uint8Array>
  readonly stderr: AsyncIterable<Uint8Array>
  wait(): Promise<number>
  close(): void
}

export interface BoxdCreateMachineRequest {
  readonly name: string
  readonly org?: string
  readonly size?: MachineSize
  readonly snapshot?: string
  /** Hostnames the machine may reach. `["none"]` reaches nothing; omitted is unrestricted. */
  readonly egress?: readonly string[]
  readonly labels: Readonly<Record<string, string>>
}

/**
 * The boxd calls the provider makes, bound to one client and region. Tests replace it with a
 * fake; {@link createBoxdClient} implements it with `@boxd-sh/sdk`.
 */
export interface BoxdClient {
  create(request: BoxdCreateMachineRequest): Promise<BoxdMachineRecord>
  get(nameOrId: string): Promise<BoxdMachineRecord>
  waitUntilReady(id: string, timeoutMs: number): Promise<BoxdMachineRecord>
  /** A shell command line, run as the machine's default user. */
  exec(id: string, command: string): BoxdCommandStream
  upload(id: string, path: string, contents: string | Uint8Array): Promise<void>
  setEgress(id: string, entries: readonly string[]): Promise<void>
  hibernate(id: string): Promise<void>
  wake(id: string): Promise<void>
  start(id: string): Promise<void>
  delete(id: string): Promise<void>
}

export interface BoxdClientOptions {
  readonly apiKey?: string
  readonly baseURL?: string
  readonly region?: string
}

/** A {@link BoxdClient} on `@boxd-sh/sdk`. The SDK reads `BOXD_API_KEY` when `apiKey` is unset. */
export function createBoxdClient(options: BoxdClientOptions): BoxdClient {
  const boxd = new Boxd({
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.region === undefined ? {} : { region: options.region }),
  })
  const machines = boxd.machines
  return {
    async create(request) {
      const spec = machineSpec(request)
      const org = request.org === undefined ? {} : { org: request.org }
      return record(
        await machines.create(
          request.snapshot === undefined
            ? { name: request.name, spec, ...org }
            : { name: request.name, fromSnapshot: request.snapshot, spec, ...org }
        )
      )
    },
    get: async (nameOrId) => record(await machines.get(nameOrId)),
    waitUntilReady: async (id, timeoutMs) =>
      record(await machines.waitUntilReady(id, { timeout: timeoutMs })),
    exec: (id, command) => machines.streamExec(id, { command, closeStdin: true }),
    async upload(id, path, contents) {
      await machines.files.upload(id, path, contents)
    },
    async setEgress(id, entries) {
      await machines.setEgressAllow(id, [...entries])
    },
    hibernate: (id) => machines.hibernate(id),
    wake: (id) => machines.wake(id),
    start: (id) => machines.start(id),
    delete: (id) => machines.delete(id),
  }
}

/**
 * The spec a sandbox machine is created from: isolated, so it has no peers and no boxd
 * credentials inside it, and with its egress allowlist in force from its first boot.
 */
export function machineSpec(request: BoxdCreateMachineRequest): MachineSpecBuilder {
  let spec = Machine.spec()
    .isolated()
    .label({ ...request.labels })
  if (request.size !== undefined) spec = spec.size(request.size)
  if (request.egress !== undefined) spec = spec.egress(...request.egress)
  return spec
}

/** Whether boxd said no such machine exists. */
export function isNotFound(error: unknown): boolean {
  return error instanceof NotFoundError
}

/** Whether boxd refused because the name is taken. */
export function isConflict(error: unknown): boolean {
  return error instanceof ConflictError
}

function record(machine: {
  readonly id: string
  readonly name: string
  readonly status: string
  readonly labels?: Readonly<Record<string, string>>
}): BoxdMachineRecord {
  return {
    id: machine.id,
    name: machine.name,
    status: machine.status,
    ...(machine.labels === undefined ? {} : { labels: machine.labels }),
  }
}
