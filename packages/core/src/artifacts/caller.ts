import type { ArtifactsRuntime } from "./execution"

/**
 * The artifacts a bound SDK's caller reaches, kept on its runtime context. An Action run reaches
 * artifacts as whoever requested it, so a request reads them here: a person's request reaches what
 * that person reaches, never every artifact of the project.
 */
const callerArtifactsKey: unique symbol = Symbol("sixb.callerArtifacts")

interface CallerArtifactsOwner {
  readonly [callerArtifactsKey]?: ArtifactsRuntime
}

export function registerCallerArtifacts(owner: object, artifacts: ArtifactsRuntime): void {
  const registered = (owner as CallerArtifactsOwner)[callerArtifactsKey]
  if (registered && registered !== artifacts) {
    throw new Error("[Sixb] The caller's artifacts are already registered for this owner.")
  }

  Object.defineProperty(owner, callerArtifactsKey, {
    configurable: false,
    enumerable: true,
    value: artifacts,
    writable: false,
  })
}

export function getCallerArtifacts(owner: object): ArtifactsRuntime {
  const artifacts = (owner as CallerArtifactsOwner)[callerArtifactsKey]
  if (artifacts) return artifacts
  throw new Error("[Sixb] The caller's artifacts are not registered for this runtime context.")
}

/**
 * Copies the caller's artifacts, when there are any, onto an internal runtime context being
 * reconstructed: what reaches them asks with `getCallerArtifacts`, which refuses where there are
 * none.
 */
export function shareCallerArtifacts(source: object, target: object): void {
  const artifacts = (source as CallerArtifactsOwner)[callerArtifactsKey]
  if (artifacts) registerCallerArtifacts(target, artifacts)
}
