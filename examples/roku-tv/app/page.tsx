import { events, listObjectsOptions, useLatestByObject } from "@sixb/client/hooks"
import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"
import { televisionObjectTypeId, televisionTwinProps } from "../lib/televisionTwin"
import { Television } from "../ontology/television"

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

export default function DevicePicker() {
  const objectsQuery = useQuery(
    listObjectsOptions({
      query: {
        objectTypeId: televisionObjectTypeId,
        limit: "200",
        orderBy: "updatedAt",
        order: "desc",
      },
    })
  )
  const objects = objectsQuery.data ?? []
  const { byObject: liveState, connected } = useLatestByObject(events(Television).telemetry())

  const deviceCount = objects.length
  const sortedObjects = useMemo(() => objects, [objects])

  if (objectsQuery.isLoading) {
    return (
      <div className="page-root page-center">
        <div className="panel-glass loading-panel fade-slide">
          <p className="eyebrow">Sixb Twin Grid</p>
          <p className="loading-title">Discovering Roku devices...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="page-root">
      <div className="twin-shell">
        <section className="panel-glass hero-panel fade-slide">
          <div className="hero-top">
            <div>
              <div className="hero-chip">
                <span
                  className={`status-dot ${connected ? "status-online pulse-live" : "status-offline"}`}
                />
                <span>{connected ? "Live Telemetry Stream" : "No Live Stream"}</span>
              </div>
              <h1 className="hero-title">Television Digital Twin Command Center</h1>
              <p className="hero-subtitle">
                Pick a twin to open its remote, inspect latest telemetry, and enqueue keypress
                commands.
              </p>
            </div>
            <div className="count-block">
              <p className="eyebrow">Devices</p>
              <p className="count-value">{deviceCount}</p>
            </div>
          </div>
        </section>

        {sortedObjects.length === 0 ? (
          <div className="panel-glass empty-state fade-slide stagger-1">
            <p className="empty-title">No televisions found.</p>
            <p className="empty-subtitle">
              Devices are discovered by pipelines. Wait for the next scan minute.
            </p>
          </div>
        ) : (
          <div className="device-grid">
            {sortedObjects.map((object) => {
              const live = liveState[object.primaryId] ?? {}
              const props = object.properties ?? {}
              const powerState =
                live[televisionTwinProps.powerState]?.value ?? props[televisionTwinProps.powerState]
              const activeApp =
                live[televisionTwinProps.activeApp]?.value ?? props[televisionTwinProps.activeApp]
              const isPoweredOn = powerState === "PowerOn"
              const name = asString(props[televisionTwinProps.name]) ?? object.primaryId
              const platform = asString(props[televisionTwinProps.platform]) ?? "unknown-platform"

              return (
                <a
                  key={object.primaryId}
                  href={`/remote/${encodeURIComponent(object.primaryId)}`}
                  className="device-card panel-glass fade-slide stagger-2"
                >
                  <div className="card-header">
                    <p className="card-kicker">Television Twin</p>
                    <span
                      className={`status-dot ${isPoweredOn ? "status-online pulse-live" : "status-offline"}`}
                    />
                  </div>
                  <h2 className="card-title">{name}</h2>
                  <div className="card-meta">
                    <p>{platform}</p>
                    <p>Power: {isPoweredOn ? "On" : "Standby"}</p>
                    <p>App: {activeApp && isPoweredOn ? String(activeApp) : "Idle"}</p>
                  </div>
                  <div className="card-cta">Open Remote {"->"}</div>
                </a>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
