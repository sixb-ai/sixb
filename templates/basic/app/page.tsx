import { executeAction, useSixbEvents } from "@sixb/client"
import { listObjectsOptions } from "@sixb/client/hooks"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { startTransition } from "react"

const counterQueryOptions = listObjectsOptions({
  query: {
    objectTypeId: "Counter",
    limit: "1",
  },
})

function formatCounterValue(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toLocaleString()
  }

  if (typeof value === "string") {
    return value
  }

  return "0"
}

export default function HomePage() {
  const queryClient = useQueryClient()
  const { data: counters = [], isLoading } = useQuery(counterQueryOptions)
  const counter = counters[0]
  const currentValue = counter?.telemetry.value?.currentValue ?? counter?.properties.value ?? 0
  const counterValue = formatCounterValue(currentValue)

  useSixbEvents({
    topic: "telemetry",
    types: ["telemetry.appended"],
    onEvent() {
      startTransition(() => {
        void queryClient.invalidateQueries({ queryKey: counterQueryOptions.queryKey })
      })
    },
  })

  const resetCounter = useMutation({
    mutationFn: async () => {
      if (!counter) {
        throw new Error("Counter is not ready yet.")
      }

      return await executeAction({
        path: {
          objectId: counter.id,
          actionId: "reset",
        },
        body: {},
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: counterQueryOptions.queryKey })
    },
  })

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Sixb starter</p>
        <h1>Counter</h1>
        <p className="lede">
          The runtime is ticking in the background. This custom app reads from the Sixb API and can
          send actions back to the server.
        </p>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="label">Live value</p>
            <p className="value">{isLoading ? "..." : counterValue}</p>
          </div>

          <div className="status">
            <span className={`status-dot ${counter ? "online" : "idle"}`} />
            <span>{counter ? "Connected" : "Waiting for first tick"}</span>
          </div>
        </div>

        <div className="details">
          <div>
            <p className="detail-label">Object</p>
            <p className="detail-value">{counter?.name ?? "My Counter"}</p>
          </div>

          <div>
            <p className="detail-label">Action</p>
            <p className="detail-value">reset</p>
          </div>
        </div>

        <button
          className="button"
          onClick={() => resetCounter.mutate()}
          disabled={!counter || resetCounter.isPending}
          type="button"
        >
          {resetCounter.isPending ? "Resetting..." : "Reset Counter"}
        </button>

        {resetCounter.error ? <p className="notice error">{resetCounter.error.message}</p> : null}

        {!counter && !isLoading ? (
          <p className="notice">
            The template&apos;s <code>tick</code> function will create the counter automatically.
          </p>
        ) : null}
      </section>
    </main>
  )
}
