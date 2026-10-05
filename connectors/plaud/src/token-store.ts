import { randomUUID } from "node:crypto"
import { type FileHandle, mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { PlaudAuthError } from "./errors"
import type { PlaudConnectionOptions, PlaudTokenStore, PlaudTokens } from "./types"
import { isRecord, nonEmpty } from "./validation"

export function resolveTokenStore(options: PlaudConnectionOptions): PlaudTokenStore {
  if (options.tokenFile && options.tokenStore)
    throw new Error("[SixbPlaud] Supply tokenFile or tokenStore, not both.")
  return options.tokenStore ?? plaudFileTokenStore(options.tokenFile)
}

/** Atomic writes (0600) and a bounded cross-process lock. Defaults to a path outside the project. */
export function plaudFileTokenStore(
  filename = join(homedir(), ".plaud", "tokens-sixb.json")
): PlaudTokenStore {
  const path = resolve(nonEmpty(filename, "tokenFile"))
  return {
    async load() {
      let text: string
      try {
        text = await readFile(path, "utf8")
      } catch (error) {
        if (isRecord(error) && error.code === "ENOENT") return null
        throw new PlaudAuthError("storage", "Cannot read the token file.")
      }
      try {
        const value: unknown = JSON.parse(text)
        return validateTokens(value)
      } catch {
        throw new PlaudAuthError("storage", "Invalid token file. Run loginPlaud to reauthorize.")
      }
    },
    async save(tokens) {
      validateTokens(tokens)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const temporary = `${path}.${randomUUID()}.tmp`
      const file = await open(temporary, "wx", 0o600)
      try {
        await file.writeFile(JSON.stringify(tokens))
        await file.sync()
        await file.close()
        await rename(temporary, path)
        const directory = await open(dirname(path), "r")
        try {
          await directory.sync()
        } finally {
          await directory.close()
        }
      } finally {
        await file.close()
        await rm(temporary, { force: true })
      }
    },
    async withLock(operation, signal) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const lock = `${path}.lock`
      const deadline = Date.now() + 10_000
      let handle: FileHandle
      for (;;) {
        signal.throwIfAborted()
        try {
          handle = await open(lock, "wx", 0o600)
          break
        } catch (error) {
          if (!isRecord(error) || error.code !== "EEXIST") throw error
          if (Date.now() >= deadline)
            throw new PlaudAuthError(
              "storage",
              "Token file is locked. If its owner exited, remove the .lock file before retrying."
            )
          await delay(50, undefined, { signal })
        }
      }
      try {
        return await operation()
      } finally {
        await handle.close()
        await rm(lock, { force: true })
      }
    },
  }
}

export function validateTokens(value: unknown): PlaudTokens {
  if (
    !isRecord(value) ||
    typeof value.access_token !== "string" ||
    !value.access_token.trim() ||
    (value.refresh_token !== undefined &&
      (typeof value.refresh_token !== "string" || !value.refresh_token.trim())) ||
    (value.token_type !== undefined &&
      (typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer")) ||
    (value.expires_at !== undefined &&
      (typeof value.expires_at !== "number" ||
        !Number.isFinite(value.expires_at) ||
        value.expires_at <= 0)) ||
    (value.refresh_pending !== undefined && typeof value.refresh_pending !== "boolean")
  ) {
    throw new PlaudAuthError("storage", "Invalid Plaud credentials.")
  }
  return value as unknown as PlaudTokens
}
