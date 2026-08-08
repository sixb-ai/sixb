import {
  events,
  listProjectionRunsOptions,
  listSyncRunsOptions,
  objectQueryKeys,
  requestSyncRunMutation,
  useInvalidateOnEvent,
  useObjectsQuery,
} from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { Alert, AlertDescription, Badge, Button, Skeleton, Spinner } from "@sixb/ui/components"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
import {
  degreesLat,
  degreesLong,
  eciToGeodetic,
  gstime,
  propagate,
  twoline2satrec,
} from "satellite.js"
import { Satellite } from "../ontology/satellite"
import { MissionGlobe } from "./mission-globe"

const satelliteQuery = objects(Satellite).query().limit(1)
const satelliteEvents = events.object(Satellite)
const syncId = "sync-satellite-orbit"
type Position = { latitude: number; longitude: number; altitude: number; velocity: number }

const dateTime = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
})
const time = new Intl.DateTimeFormat("en", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "UTC",
})

function positionAt(orbit: ReturnType<typeof twoline2satrec> | null, at: Date): Position | null {
  if (!orbit) return null
  const state = propagate(orbit, at)
  if (!state || typeof state.position === "boolean" || typeof state.velocity === "boolean") {
    return null
  }

  const point = eciToGeodetic(state.position, gstime(at))
  const position = {
    latitude: degreesLat(point.latitude),
    longitude: degreesLong(point.longitude),
    altitude: point.height,
    velocity: Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z),
  }
  return Object.values(position).every(Number.isFinite) ? position : null
}

function coordinate(value: number, positive: string, negative: string): string {
  return `${Math.abs(value).toFixed(2)}° ${value >= 0 ? positive : negative}`
}

function Metric({ label, value, loading }: { label: string; value?: string; loading: boolean }) {
  return (
    <div className="bg-background px-5 py-6 sm:px-7">
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </p>
      {loading ? (
        <Skeleton className="mt-2 h-5 w-24 rounded-none" />
      ) : (
        <p className="mt-2 font-mono text-base font-medium tabular-nums text-foreground">
          {value ?? "—"}
        </p>
      )}
    </div>
  )
}

export default function HomePage() {
  const [now, setNow] = useState(() => new Date())
  const [runId, setRunId] = useState<string>()
  const [requestedAt, setRequestedAt] = useState<number>()
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1_000)
    return () => clearInterval(timer)
  }, [])

  useInvalidateOnEvent(satelliteEvents, () => [objectQueryKeys.all()])
  const query = useObjectsQuery(satelliteQuery)
  const satellite = query.data?.objects[0]
  const refresh = useMutation({
    ...requestSyncRunMutation(),
    onMutate: () => {
      setRunId(undefined)
      setRequestedAt(Date.now())
    },
    onSuccess: (result) => setRunId(result.runId),
  })
  const runs = useQuery({
    ...listSyncRunsOptions({ query: { syncId, limit: "10", order: "desc" } }),
    enabled: Boolean(runId),
    refetchInterval: ({ state }) => {
      if (state.status === "error" || (requestedAt && Date.now() - requestedAt > 30_000)) {
        return false
      }
      const run = state.data?.runs.find((candidate) => candidate.id === runId)
      return !run || run.status === "running" ? 500 : false
    },
  })
  const run = runs.data?.runs.find((candidate) => candidate.id === runId)
  const versionId = run?.output?.versionId
  const projections = useQuery({
    ...listProjectionRunsOptions({
      query: { projectionId: "satellite", datasetVersionId: versionId, limit: "1" },
    }),
    enabled: Boolean(versionId),
    refetchInterval: ({ state }) => {
      if (state.status === "error" || (requestedAt && Date.now() - requestedAt > 30_000)) {
        return false
      }
      const projection = state.data?.runs[0]
      return !projection || projection.status === "running" ? 500 : false
    },
  })
  const projection = projections.data?.runs[0]
  const syncPending =
    refresh.isPending || (Boolean(runId) && !runs.isError && (!run || run.status === "running"))
  const materializing =
    run?.status === "succeeded" &&
    Boolean(versionId) &&
    !projections.isError &&
    (!projection || projection.status === "running")
  const awaiting = syncPending || materializing
  const timedOut = Boolean(awaiting && requestedAt && now.getTime() - requestedAt > 30_000)
  const missingVersion = run?.status === "succeeded" && !versionId
  const syncing = awaiting && !timedOut
  const failed =
    refresh.isError ||
    (Boolean(runId) && runs.isError) ||
    (Boolean(versionId) && projections.isError) ||
    run?.status === "failed" ||
    run?.status === "cancelled" ||
    projection?.status === "failed" ||
    projection?.status === "cancelled" ||
    missingVersion ||
    timedOut

  useEffect(() => {
    if (!projection?.id || projection.status !== "succeeded") return
    void query.refetch()
  }, [projection?.id, projection?.status, query.refetch])

  const line1 = satellite?.properties.tleLine1
  const line2 = satellite?.properties.tleLine2
  const orbit = useMemo(
    () => (line1 && line2 ? twoline2satrec(line1, line2) : null),
    [line1, line2]
  )
  const position = positionAt(orbit, now)
  const epoch = satellite ? new Date(satellite.properties.elementEpoch) : null
  const stale = epoch ? now.getTime() - epoch.getTime() > 48 * 60 * 60 * 1_000 : false
  const error = failed
    ? (projection?.error?.message ??
      run?.error?.message ??
      (timedOut
        ? "The refresh did not finish within 30 seconds."
        : missingVersion
          ? "The sync did not produce an orbital snapshot."
          : "Could not refresh orbital data. Try again."))
    : query.isError
      ? "Could not load local mission data."
      : satellite && !position
        ? "These orbital elements could not be propagated."
        : null
  const status = query.isLoading
    ? "Loading local state"
    : query.isError
      ? "Local state unavailable"
      : failed
        ? "Refresh failed"
        : syncing
          ? materializing
            ? "Materializing object"
            : "Syncing orbit"
          : satellite
            ? "In orbit"
            : "Ready to locate"
  const location: [number, number] | undefined = position
    ? [position.latitude, position.longitude]
    : undefined
  const requestRefresh = () =>
    refresh.mutate({
      path: { syncId },
      body: { commitMessage: "Refresh Sentinel-6B orbital elements" },
    })
  const requestAction = () => {
    if (query.isError) void query.refetch()
    else requestRefresh()
  }
  const actionLabel = query.isLoading
    ? "Loading"
    : query.isError
      ? "Retry"
      : satellite
        ? "Refresh"
        : "Locate"
  const actionPending = query.isLoading || query.isFetching || syncing
  const positionLoading = query.isLoading || (syncing && !satellite)

  return (
    <main className="min-h-screen bg-background px-0 sm:px-5">
      <div className="mx-auto flex min-h-screen w-full max-w-[1280px] flex-col overflow-hidden border-x border-border">
        <header className="flex h-14 items-stretch border-b border-border">
          <div className="flex items-center border-r border-border px-5 sm:px-7">
            <img src="/sixb-wordmark.svg" alt="Sixb" className="h-[15px] w-auto" />
          </div>
          <div className="flex flex-1 items-center px-4 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground sm:px-6">
            <span className="hidden sm:inline">Sentinel-6B&nbsp; / &nbsp;</span>Mission tracker
          </div>
          <Button
            type="button"
            className="h-full rounded-none px-5 hover:bg-[#007aff] sm:px-7"
            onClick={requestAction}
            disabled={actionPending}
          >
            {actionPending ? <Spinner /> : null}
            {actionLabel}
          </Button>
        </header>

        <section className="grid flex-1 grid-cols-1 border-b border-border lg:grid-cols-[minmax(320px,0.82fr)_minmax(0,1.18fr)]">
          <div className="flex min-h-[380px] min-w-0 flex-col border-border px-6 py-10 sm:min-h-[420px] lg:border-r lg:px-10 lg:py-14">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              Live mission position
            </p>
            <h1 className="mt-5 max-w-[470px] text-[clamp(40px,5.5vw,68px)] font-semibold leading-[0.98] tracking-[-0.045em] text-balance">
              Where is Sentinel-6B?
            </h1>
            <p className="mt-6 max-w-[440px] text-[clamp(15px,1.3vw,18px)] leading-7 text-muted-foreground">
              One public orbital snapshot becomes a position calculated locally in real time.
            </p>

            <div className="mt-7 flex items-center gap-3">
              <Badge variant="outline" className="rounded-none border-border px-2 py-1">
                <span className="size-1.5 bg-[#007aff]" />
                {status}
              </Badge>
              {position ? (
                <time
                  dateTime={now.toISOString()}
                  className="font-mono text-xs text-muted-foreground"
                >
                  {time.format(now)} UTC
                </time>
              ) : null}
              <span className="sr-only" aria-live="polite">
                {status}
              </span>
            </div>

            {error ? (
              <Alert variant="destructive" className="mt-6 rounded-none">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <div className="mt-auto pt-10">
              {satellite && epoch ? (
                <div className="border-t border-border pt-5 text-sm leading-6 text-muted-foreground">
                  <p className="font-mono text-xs text-foreground">
                    Elements {dateTime.format(epoch)} UTC
                  </p>
                  <p className="mt-1">
                    {stale ? "Epoch over 48 hours old" : "Epoch under 48 hours old"}
                  </p>
                </div>
              ) : (
                <p className="border-t border-border pt-5 text-sm leading-6 text-muted-foreground">
                  {query.isLoading
                    ? "Loading local mission data."
                    : query.isError
                      ? "Local state is unavailable. Retry from the header."
                      : syncing
                        ? "Building the first Satellite object."
                        : "Select Locate to create the first Satellite object. No account or API key required."}
                </p>
              )}
            </div>
          </div>

          <div className="relative grid min-h-[340px] min-w-0 place-items-center overflow-hidden bg-[radial-gradient(circle_at_center,#eef4ff_0%,#ffffff_62%)] p-5 sm:min-h-[480px] sm:p-8">
            <div className="aspect-square w-full max-w-[620px]">
              <MissionGlobe location={location} />
            </div>
            <p className="absolute bottom-5 right-5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground sm:bottom-7 sm:right-7">
              Position / calculated
            </p>
          </div>
        </section>

        <section
          className="grid grid-cols-2 gap-px bg-border lg:grid-cols-4"
          aria-busy={positionLoading}
        >
          <Metric
            label="Latitude"
            value={position ? coordinate(position.latitude, "N", "S") : undefined}
            loading={positionLoading}
          />
          <Metric
            label="Longitude"
            value={position ? coordinate(position.longitude, "E", "W") : undefined}
            loading={positionLoading}
          />
          <Metric
            label="Altitude"
            value={position ? `${Math.round(position.altitude).toLocaleString()} km` : undefined}
            loading={positionLoading}
          />
          <Metric
            label="Velocity"
            value={position ? `${position.velocity.toFixed(2)} km/s` : undefined}
            loading={positionLoading}
          />
        </section>

        <footer className="flex flex-col gap-3 border-t border-border px-6 py-5 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-7">
          <p>
            <span className="mr-3 font-semibold uppercase tracking-[0.14em] text-foreground">
              Data path
            </span>
            <a
              href="https://celestrak.org/"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-4"
            >
              CelesTrak connector
            </a>{" "}
            <span className="px-1.5 text-[#007aff]">→</span> sync
            <span className="px-1.5 text-[#007aff]">→</span> satellite-orbit dataset
            <span className="px-1.5 text-[#007aff]">→</span> Satellite projection/object
            <span className="px-1.5 text-[#007aff]">→</span> local calculation
          </p>
          <a
            className="text-foreground underline underline-offset-4"
            href="https://science.nasa.gov/mission/sentinel-6b/"
            target="_blank"
            rel="noreferrer"
          >
            Explore the mission at NASA
          </a>
        </footer>
      </div>
    </main>
  )
}
