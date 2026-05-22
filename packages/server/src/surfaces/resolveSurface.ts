import {
  type AuthSessionAudience,
  DEFAULT_AUTH_SESSION_AUDIENCE,
  resolveAuthSessionAudience,
} from "@pario/core"
import type { ParioServerSurface } from "./types"

export interface ResolveServerSurfaceOptions {
  readonly surface?: ParioServerSurface
  readonly ui?: boolean
}

export function resolveServerSurface(options: ResolveServerSurfaceOptions): ParioServerSurface {
  if (options.surface && options.ui !== undefined) {
    throw new Error("[ParioServer] Use either `surface` or `ui`, not both.")
  }

  if (options.surface) {
    return options.surface
  }

  if (options.ui === false) {
    return { kind: "apiOnly" }
  }

  return { kind: "builtInUi" }
}

export function resolveDefaultSurfaceAudience(surface: ParioServerSurface): AuthSessionAudience {
  if (surface.kind === "apiOnly" && surface.audience) {
    return resolveAuthSessionAudience(surface.audience)
  }

  if (surface.kind === "customApp") {
    return "app"
  }

  return DEFAULT_AUTH_SESSION_AUDIENCE
}
