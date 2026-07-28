import { listObjectsOptions, useActionRunMutation } from "@sixb/client/hooks"
import { useQuery } from "@tanstack/react-query"

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
  const { data: counters = [], isLoading } = useQuery(counterQueryOptions)
  const counter = counters[0]
  const currentValue = counter?.properties.value ?? 0
  const counterValue = formatCounterValue(currentValue)

  const incrementCounter = useActionRunMutation({
    actionId: "increment",
    invalidateOnCommit: true,
  })

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Sixb starter</p>
        <h1>Counter</h1>
        <p className="lede">
          This custom app reads from the Sixb API and sends an action back to the server to advance
          shared state.
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
            <span>{counter ? "Connected" : "Ready to create"}</span>
          </div>
        </div>

        <div className="details">
          <div>
            <p className="detail-label">Object</p>
            <p className="detail-value">{counter?.name ?? "My Counter"}</p>
          </div>

          <div>
            <p className="detail-label">Action</p>
            <p className="detail-value">increment</p>
          </div>
        </div>

        <button
          className="button"
          onClick={() => incrementCounter.mutate(undefined)}
          disabled={incrementCounter.isPending}
          type="button"
        >
          {incrementCounter.isPending ? "Incrementing..." : "Increment Counter"}
        </button>

        {incrementCounter.error ? (
          <p className="notice error">{incrementCounter.error.message}</p>
        ) : null}

        {!counter && !isLoading ? (
          <p className="notice">Run the increment action to create your first counter object.</p>
        ) : null}
      </section>
    </main>
  )
}
