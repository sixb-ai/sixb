"use client"

import type * as React from "react"
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import type {
  AddressCoordinates,
  AddressProvider,
  AddressSearchOptions,
  AddressSuggestion,
} from "../lib/address"
import { createPhotonProvider } from "../lib/address"
import { useDebouncedValue } from "./use-debounced-value"

const DEFAULT_MIN_LENGTH = 3
const DEFAULT_DEBOUNCE_MS = 300
const DEFAULT_ERROR_MESSAGE = "Address lookup is unavailable right now."

const AddressProviderContext = createContext<AddressProvider | null>(null)

let sharedPhotonProvider: AddressProvider | null = null

/** Keyless Photon provider used when an app has not configured one. */
function defaultAddressProvider(): AddressProvider {
  sharedPhotonProvider ??= createPhotonProvider()
  return sharedPhotonProvider
}

/**
 * Configures the address provider for a subtree. Optional — without it, lookups
 * fall back to a shared Photon provider.
 */
export function AddressLookupProvider({
  provider,
  children,
}: {
  provider?: AddressProvider
  children: React.ReactNode
}) {
  const value = useMemo(() => provider ?? defaultAddressProvider(), [provider])
  return <AddressProviderContext.Provider value={value}>{children}</AddressProviderContext.Provider>
}

/** Resolves the provider to use: an explicit override, the context one, or the default. */
export function useAddressProvider(override?: AddressProvider): AddressProvider {
  const fromContext = useContext(AddressProviderContext)
  return override ?? fromContext ?? defaultAddressProvider()
}

export type UseAddressLookupOptions = {
  readonly query: string
  /** Set false to suspend lookups, e.g. while a field is closed or disabled. */
  readonly enabled?: boolean
  /** Overrides the provider from context. */
  readonly provider?: AddressProvider
  readonly minLength?: number
  readonly debounceMs?: number
  readonly limit?: number
  readonly lang?: string
  readonly countries?: readonly string[]
  readonly proximity?: AddressCoordinates
  readonly bbox?: readonly [number, number, number, number]
  readonly errorMessage?: string
}

export type UseAddressLookupResult = {
  readonly suggestions: readonly AddressSuggestion[]
  readonly loading: boolean
  /** Set only for real failures; an empty result is not an error. */
  readonly error: string | null
  /** Required credit for the provider's data, when it has one. */
  readonly attribution: string | null
  /**
   * Finalizes a choice. For providers with a two-phase flow this performs the
   * follow-up details request and returns the completed suggestion; otherwise it
   * returns the suggestion unchanged.
   */
  readonly select: (suggestion: AddressSuggestion) => Promise<AddressSuggestion>
  readonly reset: () => void
}

/**
 * Debounced, abortable address search over any {@link AddressProvider}.
 *
 * Keeps the provider's two-phase and per-session details out of call sites, so
 * swapping Photon for a keyed provider later is a configuration change.
 */
export function useAddressLookup(options: UseAddressLookupOptions): UseAddressLookupResult {
  const {
    query,
    enabled = true,
    minLength = DEFAULT_MIN_LENGTH,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    errorMessage = DEFAULT_ERROR_MESSAGE,
    lang,
  } = options

  const provider = useAddressProvider(options.provider)
  const [suggestions, setSuggestions] = useState<readonly AddressSuggestion[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trimmedQuery = query.trim()
  const debouncedQuery = useDebouncedValue(trimmedQuery, debounceMs)
  const active = enabled && trimmedQuery.length >= minLength

  // Object and array options would break effect identity every render, so the
  // effect reads them through a ref and re-runs on their serialized value.
  const searchOptions: AddressSearchOptions = {
    limit: options.limit,
    lang,
    countries: options.countries,
    proximity: options.proximity,
    bbox: options.bbox,
  }
  const searchOptionsKey = JSON.stringify(searchOptions)
  const searchOptionsRef = useRef(searchOptions)
  searchOptionsRef.current = searchOptions

  const sessionRef = useRef<string | null>(null)
  const ensureSession = useCallback((): string | undefined => {
    if (!provider.createSession) return undefined
    sessionRef.current ??= provider.createSession()
    return sessionRef.current
  }, [provider])

  // biome-ignore lint/correctness/useExhaustiveDependencies: searchOptionsKey re-runs the search when the option objects change by value, not because the body reads it
  useEffect(() => {
    if (!active) {
      setSuggestions([])
      setLoading(false)
      setError(null)
      return
    }

    // Show progress from the first keystroke rather than after the debounce.
    if (debouncedQuery !== trimmedQuery) {
      setLoading(true)
      return
    }

    const controller = new AbortController()
    setLoading(true)
    setError(null)

    provider
      .search(debouncedQuery, {
        ...searchOptionsRef.current,
        signal: controller.signal,
        sessionToken: ensureSession(),
      })
      .then((next) => {
        if (controller.signal.aborted) return
        setSuggestions(next)
        setLoading(false)
      })
      .catch((searchError: unknown) => {
        if (controller.signal.aborted || isAbortError(searchError)) return
        setSuggestions([])
        setError(errorMessage)
        setLoading(false)
      })

    return () => controller.abort()
  }, [
    active,
    debouncedQuery,
    trimmedQuery,
    provider,
    ensureSession,
    errorMessage,
    searchOptionsKey,
  ])

  const select = useCallback(
    async (suggestion: AddressSuggestion): Promise<AddressSuggestion> => {
      if (!provider.retrieve) {
        sessionRef.current = null
        return suggestion
      }

      try {
        return await provider.retrieve(suggestion, {
          lang,
          sessionToken: sessionRef.current ?? undefined,
        })
      } catch (retrieveError: unknown) {
        if (isAbortError(retrieveError)) throw retrieveError
        // Keep the partial suggestion: losing the user's choice is worse than
        // filling in fewer fields, and the error surfaces alongside it.
        setError(errorMessage)
        return suggestion
      } finally {
        // A lookup session ends with its details request.
        sessionRef.current = null
      }
    },
    [provider, lang, errorMessage]
  )

  const reset = useCallback(() => {
    sessionRef.current = null
    setSuggestions([])
    setLoading(false)
    setError(null)
  }, [])

  return {
    suggestions,
    loading,
    error,
    attribution: provider.attribution ?? null,
    select,
    reset,
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}
