import { assertAuthorized } from "../authorization"
import type { SixbRuntimeContext } from "../runtime/types"
import type { DefinitionsManifest } from "./types"

/** A request's view of its runtime's manifest: the Console's, so whoever may observe it. */
export interface DefinitionsManifestReader {
  read(): Promise<DefinitionsManifest>
}

export function createDefinitionsManifestReader(
  runtime: SixbRuntimeContext,
  manifest: () => Promise<DefinitionsManifest>
): DefinitionsManifestReader {
  return {
    read() {
      assertAuthorized(runtime, { kind: "console.observe" })
      return manifest()
    },
  }
}

const definitionsManifestReaderKey: unique symbol = Symbol("sixb.definitionsManifestReader")

interface DefinitionsManifestReaderOwner {
  readonly [definitionsManifestReaderKey]?: DefinitionsManifestReader
}

export function registerDefinitionsManifestReader(
  owner: object,
  reader: DefinitionsManifestReader
): void {
  Object.defineProperty(owner, definitionsManifestReaderKey, {
    configurable: false,
    enumerable: false,
    value: reader,
    writable: false,
  })
}

export function getDefinitionsManifestReader(owner: object): DefinitionsManifestReader {
  const reader = (owner as DefinitionsManifestReaderOwner)[definitionsManifestReaderKey]
  if (!reader) {
    throw new Error("[Sixb] The definitions manifest is not registered for this execution.")
  }
  return reader
}
