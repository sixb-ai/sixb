import { type TelemetryUpdate, useWebSocket } from "@pario/client"
import { getObjectOptions, getObjectTypeOptions, requestActionMutation } from "@pario/client/hooks"
import { encodeObjectId } from "@pario/client/models"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useCallback, useMemo, useState } from "react"
import { useParams } from "react-router-dom"
import { televisionObjectTypeId, televisionTwinProps } from "../../../lib/televisionTwin"

const KEYS = {
  dpad: ["Up", "Down", "Left", "Right", "Select"],
  nav: ["Back", "Home", "Info"],
  media: ["Rev", "Play", "Fwd"],
  volume: ["VolumeUp", "VolumeDown", "VolumeMute"],
  power: ["Power"],
} as const

type RokuKey = (typeof KEYS)[keyof typeof KEYS][number]

const KEY_LABELS: Partial<Record<RokuKey, string>> = {
  Back: "Back",
  Home: "Home",
  Info: "Info",
  Up: "^",
  Down: "v",
  Left: "<",
  Right: ">",
  Select: "OK",
  Rev: "<<",
  Play: "Play",
  Fwd: ">>",
  VolumeUp: "Vol+",
  VolumeDown: "Vol-",
  VolumeMute: "Mute",
  Power: "Power",
}

const APP_SHORTCUTS = ["Netflix", "Prime", "Hulu", "Disney+"] as const
const noop = () => undefined

function RemoteButton({
  label,
  onClick,
  variant = "default",
  active = false,
  disabled = false,
}: {
  label: string
  onClick: () => void
  variant?: "default" | "power" | "small" | "ok" | "shortcut"
  active?: boolean
  disabled?: boolean
}) {
  const baseClasses = `remote-btn${active ? " is-active" : ""}`
  const variants = {
    default: "",
    power: " power",
    small: " slim",
    ok: " ok",
    shortcut: " shortcut",
  }

  return (
    <button
      type="button"
      className={`${baseClasses}${variants[variant]}`}
      onClick={onClick}
      disabled={disabled}
    >
      {label}
    </button>
  )
}

function decodeKey(input: string | undefined): string | null {
  if (!input) {
    return null
  }

  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

export default function RemoteControl() {
  const { id } = useParams<{ id: string }>()
  const objectKey = decodeKey(id)

  const objectId = objectKey ? encodeObjectId(televisionObjectTypeId, objectKey) : ""
  const objectQuery = useQuery({
    ...getObjectOptions({
      path: {
        objectId,
      },
    }),
    enabled: !!objectKey,
  })
  const object = objectQuery.data

  const objectTypeQuery = useQuery(
    getObjectTypeOptions({
      path: {
        objectTypeId: televisionObjectTypeId,
      },
    })
  )

  const [liveState, setLiveState] = useState<Record<string, TelemetryUpdate>>({})

  const handleUpdate = useCallback(
    (update: TelemetryUpdate) => {
      if (update.objectTypeId !== televisionObjectTypeId || update.objectId !== objectKey) {
        return
      }
      setLiveState((prev) => ({ ...prev, [update.propertyId]: update }))
    },
    [objectKey]
  )

  const { connected } = useWebSocket(handleUpdate)

  const { mutate: sendAction } = useMutation(requestActionMutation())
  const [lastPressedKey, setLastPressedKey] = useState<RokuKey | null>(null)

  const pressKey = useCallback(
    (key: RokuKey) => {
      if (!objectKey) {
        return
      }

      setLastPressedKey(key)
      sendAction({
        path: {
          objectTypeId: televisionObjectTypeId,
          objectId: objectKey,
          actionId: "pressButton",
        },
        body: { params: { button: key } },
      })
      setTimeout(() => {
        setLastPressedKey((current) => (current === key ? null : current))
      }, 170)
    },
    [objectKey, sendAction]
  )

  const powerState =
    liveState[televisionTwinProps.powerState]?.value ??
    object?.properties[televisionTwinProps.powerState]
  const activeApp =
    liveState[televisionTwinProps.activeApp]?.value ??
    object?.properties[televisionTwinProps.activeApp]
  const mediaState =
    liveState[televisionTwinProps.mediaState]?.value ??
    object?.properties[televisionTwinProps.mediaState]
  const availableActions = objectTypeQuery.data?.actions?.map((a) => a.id) ?? []
  const isPoweredOn = powerState === "PowerOn"

  const title = useMemo(() => {
    return asString(object?.properties[televisionTwinProps.name]) ?? objectKey ?? "Television"
  }, [objectKey, object?.properties])

  return (
    <div className="page-root">
      <div className="twin-shell">
        <header className="panel-glass remote-header fade-slide">
          <div className="remote-header-row">
            <a href="/" className="back-link">
              {"<- Back to twins"}
            </a>
            <div className="hero-chip">
              <span
                className={`status-dot ${connected ? "status-online pulse-live" : "status-offline"}`}
              />
              <span>{connected ? "Realtime Telemetry Link" : "Telemetry Link Offline"}</span>
            </div>
          </div>
        </header>

        <div className="remote-layout">
          <section className="panel-glass telemetry-panel fade-slide stagger-1">
            <p className="eyebrow">Twin Telemetry</p>
            <h1 className="telemetry-title">{title}</h1>
            <div className="telemetry-grid">
              <div className="panel-glass telemetry-card">
                <p className="telemetry-label">Power</p>
                <p className={`telemetry-value ${isPoweredOn ? "is-ok" : "is-warn"}`}>
                  {isPoweredOn ? "On" : "Standby"}
                </p>
              </div>
              <div className="panel-glass telemetry-card">
                <p className="telemetry-label">Active App</p>
                <p className="telemetry-value">{activeApp ? String(activeApp) : "Idle"}</p>
              </div>
              <div className="panel-glass telemetry-card">
                <p className="telemetry-label">Media State</p>
                <p className="telemetry-value">{mediaState ? String(mediaState) : "None"}</p>
              </div>
            </div>
            <div className="telemetry-footnote">
              Actions: {availableActions.join(", ") || "(none)"}
            </div>
          </section>

          <section className="device-remote fade-slide stagger-2">
            <div className="remote-side-controls" aria-hidden="true">
              <div className="side-key" />
              <div className="side-key small" />
            </div>
            <div className="remote-ir-window" aria-hidden="true" />
            <div className="remote-speaker" aria-hidden="true" />
            <div className="remote-meta">
              <h1>{title}</h1>
              <p>{televisionObjectTypeId}</p>
            </div>

            <div className="remote-row">
              <RemoteButton
                label={KEY_LABELS.Power ?? "Power"}
                onClick={() => pressKey("Power")}
                variant="power"
                active={lastPressedKey === "Power"}
              />
              <RemoteButton
                label={KEY_LABELS.Home ?? "Home"}
                onClick={() => pressKey("Home")}
                active={lastPressedKey === "Home"}
              />
            </div>

            <div className="dpad">
              <div />
              <RemoteButton
                label={KEY_LABELS.Up ?? "Up"}
                onClick={() => pressKey("Up")}
                active={lastPressedKey === "Up"}
              />
              <div />
              <RemoteButton
                label={KEY_LABELS.Left ?? "Left"}
                onClick={() => pressKey("Left")}
                active={lastPressedKey === "Left"}
              />
              <RemoteButton
                label={KEY_LABELS.Select ?? "OK"}
                onClick={() => pressKey("Select")}
                variant="ok"
                active={lastPressedKey === "Select"}
              />
              <RemoteButton
                label={KEY_LABELS.Right ?? "Right"}
                onClick={() => pressKey("Right")}
                active={lastPressedKey === "Right"}
              />
              <div />
              <RemoteButton
                label={KEY_LABELS.Down ?? "Down"}
                onClick={() => pressKey("Down")}
                active={lastPressedKey === "Down"}
              />
              <div />
            </div>

            <div className="remote-row">
              {KEYS.nav.map((key) => (
                <RemoteButton
                  key={key}
                  label={KEY_LABELS[key] ?? key}
                  onClick={() => pressKey(key)}
                  variant="small"
                  active={lastPressedKey === key}
                />
              ))}
            </div>

            <div className="remote-row">
              {KEYS.media.map((key) => (
                <RemoteButton
                  key={key}
                  label={KEY_LABELS[key] ?? key}
                  onClick={() => pressKey(key)}
                  active={lastPressedKey === key}
                />
              ))}
            </div>

            <div className="remote-row">
              {KEYS.volume.map((key) => (
                <RemoteButton
                  key={key}
                  label={KEY_LABELS[key] ?? key}
                  onClick={() => pressKey(key)}
                  variant="small"
                  active={lastPressedKey === key}
                />
              ))}
            </div>

            <div className="remote-brand" aria-hidden="true">
              roku
            </div>

            <div className="remote-row shortcuts-row">
              {APP_SHORTCUTS.map((shortcut) => (
                <RemoteButton
                  key={shortcut}
                  label={shortcut}
                  onClick={noop}
                  variant="shortcut"
                  disabled
                />
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
