const runtime =
  typeof window === "undefined"
    ? undefined
    : (window as Window & { __SIXB_RUNTIME__?: { publicEnv?: Record<string, string> } })
        .__SIXB_RUNTIME__

/** Public environment captured at app-server startup. Missing values are undefined. */
export const publicEnv: Readonly<Record<string, string | undefined>> = Object.freeze(
  Object.assign(Object.create(null), runtime?.publicEnv)
)
