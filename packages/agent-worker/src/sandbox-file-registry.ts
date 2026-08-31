import { posix } from "node:path"
import type { FileRef } from "@sixb/core"
import { fileRefKey } from "./file-ref"

/** Track durable files materialized in the current run sandbox. */
export class AgentSandboxFileRegistry {
  readonly #byAbsolutePath = new Map<string, FileRef>()
  readonly #pathByFileRef = new Map<string, string>()

  register(absolutePath: string, fileRef: FileRef): void {
    const normalizedPath = posix.normalize(absolutePath)
    this.#byAbsolutePath.set(normalizedPath, fileRef)
    const key = fileRefKey(fileRef)
    if (!this.#pathByFileRef.has(key)) {
      this.#pathByFileRef.set(key, normalizedPath)
    }
  }

  get(absolutePath: string): FileRef | undefined {
    return this.#byAbsolutePath.get(posix.normalize(absolutePath))
  }

  pathFor(fileRef: FileRef): string | undefined {
    return this.#pathByFileRef.get(fileRefKey(fileRef))
  }
}
