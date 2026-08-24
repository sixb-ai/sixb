import {
  createSharedAccessClient,
  isSixbApiError,
  type SharedAccessActionInput,
  type SharedAccessActionResult,
  type SharedAccessContext,
  type SharedAccessResource,
} from "@sixb/client/shared"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  bootstrapSharedAppAccess,
  classifySharedAppFailure,
  SharedAppUnavailableError,
} from "./shared-runtime"

export interface SharedAppRuntimeConfig {
  readonly apiBaseUrl: string
}

export interface SharedAccessValue {
  readonly grantId: string
  readonly shareTypeId: string
  readonly grant: SharedAccessContext["grant"]
  readonly session: SharedAccessContext["session"]
  readonly resource: SharedAccessResource
  requestAction(
    actionId: string,
    input?: SharedAccessActionInput
  ): Promise<SharedAccessActionResult>
  refreshResource(): Promise<SharedAccessResource>
  signOut(): Promise<void>
}

export interface SharedAccessBoundaryProps {
  readonly apiBaseUrl: string
  readonly grantId: string
  readonly shareTypeId: string
  consumeFragmentSecret(): string | null
  readonly children: ReactNode
}

type SharedAccessState =
  | { readonly status: "loading" }
  | { readonly status: "retryable" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "ready"
      readonly access: SharedAccessContext
      readonly resource: SharedAccessResource
    }

const SharedAccessContextValue = createContext<SharedAccessValue | null>(null)

type SharedBootstrapOutcome = Exclude<SharedAccessState, { readonly status: "loading" }>

/** Reads only the API origin injected into the shared HTML entry. */
export function readSharedAppRuntimeConfig(): SharedAppRuntimeConfig {
  const runtime = (
    window as Window & {
      readonly __SIXB_RUNTIME__?: {
        readonly api?: { readonly baseUrl?: unknown }
      }
    }
  ).__SIXB_RUNTIME__
  const configuredBaseUrl = runtime?.api?.baseUrl
  return {
    apiBaseUrl:
      typeof configuredBaseUrl === "string" && configuredBaseUrl.trim()
        ? configuredBaseUrl
        : window.location.origin,
  }
}

/** Returns the exact grant-bound authority prepared by the generated shared shell. */
export function useSharedAccess(): SharedAccessValue {
  const value = useContext(SharedAccessContextValue)
  if (!value) {
    throw new Error("[SixbSharedApp] useSharedAccess() must be used inside a shared page.")
  }
  return value
}

/** Framework-owned bootstrap boundary used by the generated shared entry point. */
export function SharedAccessBoundary(props: SharedAccessBoundaryProps) {
  const client = useMemo(
    () => createSharedAccessClient({ grantId: props.grantId, baseUrl: props.apiBaseUrl }),
    [props.apiBaseUrl, props.grantId]
  )
  const [queryClient] = useState(createSharedQueryClient)
  const [state, setState] = useState<SharedAccessState>({ status: "loading" })
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0)
  const fragmentSecret = useRef<string | null | undefined>(undefined)
  const bootstrap = useRef<{
    readonly attempt: number
    readonly promise: Promise<SharedBootstrapOutcome>
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    setState({ status: "loading" })

    let current = bootstrap.current
    if (!current || current.attempt !== bootstrapAttempt) {
      if (fragmentSecret.current === undefined) {
        fragmentSecret.current = props.consumeFragmentSecret()
      }

      const promise = bootstrapSharedAppAccess({
        expectedShareTypeId: props.shareTypeId,
        grantId: props.grantId,
        fragmentSecret: fragmentSecret.current,
        client,
        // Once exchange succeeds, the short-lived session is sufficient even
        // if loading the resource fails and the user retries.
        onAccessEstablished: () => {
          fragmentSecret.current = null
        },
      }).then<SharedBootstrapOutcome, SharedBootstrapOutcome>(
        (result) => {
          fragmentSecret.current = null
          return { status: "ready", ...result }
        },
        (error) => {
          const kind = classifySharedAppFailure(error)
          if (kind === "terminal") {
            fragmentSecret.current = null
            return { status: "unavailable" }
          }

          console.error("[SixbSharedApp] Could not open shared access; retry is available.", error)
          return { status: "retryable" }
        }
      )
      current = { attempt: bootstrapAttempt, promise }
      bootstrap.current = current
    }

    void current.promise.then((result) => {
      if (!cancelled) setState(result)
    })

    return () => {
      cancelled = true
    }
  }, [bootstrapAttempt, client, props.consumeFragmentSecret, props.grantId, props.shareTypeId])

  useEffect(() => {
    return () => queryClient.clear()
  }, [queryClient])

  useEffect(() => {
    if (state.status === "unavailable") queryClient.clear()
  }, [queryClient, state.status])

  useEffect(() => {
    if (state.status !== "ready") return
    const expiresAt = Math.min(
      Date.parse(state.access.grant.expiresAt),
      Date.parse(state.access.session.expiresAt)
    )
    if (!Number.isFinite(expiresAt)) {
      setState({ status: "unavailable" })
      return
    }

    const remaining = expiresAt - Date.now()
    if (remaining <= 0) {
      setState({ status: "unavailable" })
      return
    }

    const timeout = window.setTimeout(
      () => setState({ status: "unavailable" }),
      Math.min(remaining, 2_147_483_647)
    )
    return () => window.clearTimeout(timeout)
  }, [state])

  const value = useMemo<SharedAccessValue | null>(() => {
    if (state.status !== "ready") return null

    return {
      grantId: props.grantId,
      shareTypeId: props.shareTypeId,
      grant: state.access.grant,
      session: state.access.session,
      resource: state.resource,
      async requestAction(actionId, input) {
        try {
          return await client.requestAction(actionId, input)
        } catch (error) {
          if (isUnavailableError(error)) setState({ status: "unavailable" })
          throw error
        }
      },
      async refreshResource() {
        try {
          const resource = await client.getResource()
          assertExactResource(resource, state.access)
          setState({ status: "ready", access: state.access, resource })
          return resource
        } catch (error) {
          if (isUnavailableError(error)) setState({ status: "unavailable" })
          throw error
        }
      },
      async signOut() {
        await client.signOut()
        setState({ status: "unavailable" })
      },
    }
  }, [client, props.grantId, props.shareTypeId, state])

  const content =
    state.status === "loading"
      ? createElement(SharedAppFallback, {
          role: "status",
          title: "Opening shared access…",
          detail: "Please wait while this link is verified.",
        })
      : state.status === "retryable"
        ? createElement(SharedAppFallback, {
            role: "alert",
            title: "Unable to open this link",
            detail: "A temporary problem occurred. Please try again.",
            onRetry: () => setBootstrapAttempt((attempt) => attempt + 1),
          })
        : state.status === "unavailable" || !value
          ? createElement(SharedAppFallback, {
              role: "alert",
              title: "Link unavailable",
              detail: "This shared link is invalid, expired, or no longer available.",
            })
          : createElement(SharedAccessContextValue.Provider, { value }, props.children)

  return createElement(QueryClientProvider, { client: queryClient }, content)
}

function createSharedQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: false,
      },
    },
  })
}

function assertExactResource(resource: SharedAccessResource, access: SharedAccessContext): void {
  if (
    resource.objectTypeId !== access.grant.target.objectTypeId ||
    resource.primaryId !== access.grant.target.primaryId
  ) {
    throw new SharedAppUnavailableError()
  }
}

function isUnavailableError(error: unknown): boolean {
  if (error instanceof SharedAppUnavailableError) return true
  return (
    isSixbApiError(error) &&
    (error.code === "share.access_unavailable" || error.code === "share.resource_not_found")
  )
}

function SharedAppFallback(props: {
  readonly role: "alert" | "status"
  readonly title: string
  readonly detail: string
  readonly onRetry?: () => void
}) {
  return createElement(
    "main",
    {
      role: props.role,
      style: {
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.75rem",
        padding: "2rem",
        textAlign: "center",
        fontFamily:
          "var(--font-sans, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif)",
        background: "var(--background, #ffffff)",
        color: "var(--foreground, #1f2933)",
      },
    },
    createElement("h1", { style: { margin: 0, fontSize: "1.5rem" } }, props.title),
    createElement(
      "p",
      { style: { margin: 0, maxWidth: "32rem", color: "var(--muted-foreground, #52606d)" } },
      props.detail
    ),
    props.onRetry
      ? createElement(
          "button",
          {
            type: "button",
            onClick: props.onRetry,
            style: {
              marginTop: "0.25rem",
              padding: "0.625rem 1rem",
              border: "1px solid currentColor",
              borderRadius: "0.375rem",
              background: "transparent",
              color: "inherit",
              cursor: "pointer",
              font: "inherit",
            },
          },
          "Try again"
        )
      : null
  )
}
