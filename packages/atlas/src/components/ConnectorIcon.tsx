/// <reference path="../images.d.ts" />
import { cn } from "@sixb/ui/lib/utils"
import { Cable } from "lucide-react"
import aceIot from "../connector-icons/ace-iot.ico"
import companycam from "../connector-icons/companycam.png"
import exa from "../connector-icons/exa.png"
import github from "../connector-icons/github.svg"
import google from "../connector-icons/google.ico"
import googleAds from "../connector-icons/googleads.svg"
import linkedin from "../connector-icons/linkedin.svg"
import mercury from "../connector-icons/mercury.svg"
import meta from "../connector-icons/meta.svg"
import microsoft from "../connector-icons/microsoft.ico"
import notion from "../connector-icons/notion.svg"
import pandadoc from "../connector-icons/pandadoc.png"
import pennylane from "../connector-icons/pennylane.ico"
import pipedrive from "../connector-icons/pipedrive.png"
import plaud from "../connector-icons/plaud.png"
import quickbooks from "../connector-icons/quickbooks.svg"
import stripe from "../connector-icons/stripe.svg"
import teamleader from "../connector-icons/teamleader.ico"
import tiktok from "../connector-icons/tiktok.svg"
import unipile from "../connector-icons/unipile.png"

// Keyed by the adapter `type` each `@sixb/connector-*` package declares. Any other type, such as a
// project's own connector, gets the generic icon.
const connectorIcons: Readonly<Record<string, string>> = {
  "ace-iot": aceIot,
  companycam,
  exa,
  github,
  google,
  "google-ads": googleAds,
  linkedin,
  mercury,
  meta,
  microsoft,
  notion,
  pandadoc,
  pennylane,
  pipedrive,
  plaud,
  quickbooks,
  stripe,
  teamleader,
  tiktok,
  unipile,
}

/**
 * Square tile with the connector's brand mark. Marks sit on white in both themes because several
 * are black monochrome. Size the tile with `className`; the mark scales with it.
 */
export function ConnectorIcon({ type, className }: { type: string; className?: string }) {
  const src = Object.hasOwn(connectorIcons, type) ? connectorIcons[type] : undefined

  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg",
        src ? "border border-border bg-white" : "bg-muted text-muted-foreground",
        className
      )}
    >
      {src ? (
        <img src={src} alt="" draggable={false} className="size-3/5 object-contain" />
      ) : (
        <Cable className="size-1/2" />
      )}
    </span>
  )
}
