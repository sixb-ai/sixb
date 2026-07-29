import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { z } from "zod"

const mutations = new Map<string, Promise<void>>()

export class AtomicJsonStore<T> {
  constructor(
    readonly path: string,
    private readonly schema: z.ZodType<T>
  ) {}

  async read(): Promise<T> {
    try {
      const source = await readFile(this.path, "utf8")
      return this.schema.parse(JSON.parse(source))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`[NorthlineSource] Cannot read '${this.path}': ${message}`)
    }
  }

  async write(value: T): Promise<void> {
    const parsed = this.schema.parse(value)
    await mkdir(dirname(this.path), { recursive: true })
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8")
    await rename(temporaryPath, this.path)
  }

  async update<TResult>(mutate: (current: T) => TResult | Promise<TResult>): Promise<TResult> {
    const previous = mutations.get(this.path) ?? Promise.resolve()
    let release = () => {}
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise
    })
    const queued = previous.then(() => current)
    mutations.set(this.path, queued)

    await previous
    try {
      const state = await this.read()
      const result = await mutate(state)
      await this.write(state)
      return result
    } finally {
      release()
      if (mutations.get(this.path) === queued) mutations.delete(this.path)
    }
  }
}

export function sourceDirectory(): string {
  return resolve(
    process.env.NORTHLINE_SOURCE_DIR ?? resolve(import.meta.dir, "../..", ".sixb/demo-sources")
  )
}
