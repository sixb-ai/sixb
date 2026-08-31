interface SandboxReadinessGuard {
  readonly signal: AbortSignal
  throwIfFailed(): void
}

/** Observe concurrent sandbox provisioning without putting healthy boot on the model's critical path. */
export function monitorSandboxReadiness(
  ready: Promise<unknown> | undefined
): SandboxReadinessGuard {
  const abort = new AbortController()
  let failure: { readonly error: unknown } | undefined
  ready?.catch((error) => {
    failure = { error }
    abort.abort()
  })
  return {
    signal: abort.signal,
    throwIfFailed() {
      if (failure) throw failure.error
    },
  }
}
