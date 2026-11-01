import { cn } from "@sixb/ui/lib/utils"
import { Cable, CalendarClock } from "lucide-react"
import { MetaDot } from "../../section-ui"
import { useDataMessages } from "./messages"

// Keyed by the adapter `type` each `@sixb/connector-*` package declares; the files live in
// `assets/connector-icons/`. Any other type, such as a project's own connector, gets a plug.
const connectorIconFiles: Readonly<Record<string, string>> = {
  "ace-iot": "ace-iot.ico",
  companycam: "companycam.png",
  exa: "exa.png",
  github: "github.svg",
  google: "google.ico",
  "google-ads": "googleads.svg",
  linkedin: "linkedin.svg",
  mercury: "mercury.svg",
  meta: "meta.svg",
  microsoft: "microsoft.ico",
  notion: "notion.svg",
  pandadoc: "pandadoc.png",
  pennylane: "pennylane.ico",
  pipedrive: "pipedrive.png",
  plaud: "plaud.png",
  quickbooks: "quickbooks.svg",
  stripe: "stripe.svg",
  teamleader: "teamleader.ico",
  tiktok: "tiktok.svg",
  unipile: "unipile.png",
}

/**
 * A connector's brand mark on a white tile, in both themes since several marks are black. Unknown
 * types get a plug.
 */
export function ConnectorIcon({
  type,
  size = "md",
}: {
  readonly type: string
  readonly size?: "md" | "lg"
}) {
  const file = Object.hasOwn(connectorIconFiles, type) ? connectorIconFiles[type] : undefined
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center border border-border shadow-[0_1px_2px_0_rgb(0_0_0/0.04)]",
        size === "lg" ? "size-12 rounded-xl" : "size-9 rounded-lg",
        file ? "bg-white" : "bg-background text-muted-foreground"
      )}
    >
      {file ? (
        <img
          src={`/__sixb/assets/connector-icons/${file}`}
          alt=""
          draggable={false}
          className="size-[55%] object-contain"
        />
      ) : (
        <Cable className={size === "lg" ? "size-5" : "size-4"} />
      )}
    </span>
  )
}

/** The schedule that starts something, on a row's second line. */
export function ScheduleMeta({ id }: { readonly id: string }) {
  const messages = useDataMessages().common
  return (
    <>
      <MetaDot />
      <span className="inline-flex min-w-0 items-center gap-1" title={messages.schedule}>
        <CalendarClock className="size-3.5 shrink-0" />
        <span className="truncate">{id}</span>
      </span>
    </>
  )
}
