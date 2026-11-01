import { TooltipProvider } from "@sixb/ui/components"
import { useEffect, useRef, useState } from "react"
import { type FileLinksAt, ValuePanel, type ValueSchema } from "../../../values"
import { explainProperty, type ObjectLineage } from "./model"
import { PropertySourceLabel } from "./property-source"
import { ValueLineagePanel } from "./value-lineage-panel"

/**
 * An object's properties, each name marked with where its value comes from and opening the trail
 * behind it. Until the lineage arrives, and for the primary key, names read as plain labels.
 */
export function PropertiesPanel({
  title,
  objectName,
  properties,
  schema,
  propertySchema,
  labels,
  fileLinks,
  lineage,
}: {
  readonly title: string
  readonly objectName: string
  readonly properties: Readonly<Record<string, unknown>>
  readonly schema?: ValueSchema
  readonly propertySchema: (propertyId: string) => ValueSchema | undefined
  readonly labels?: Readonly<Record<string, string>>
  readonly fileLinks?: FileLinksAt
  readonly lineage: ObjectLineage | undefined
}) {
  const [open, setOpen] = useState(false)
  const [propertyId, setPropertyId] = useState<string | null>(null)
  const opener = useRef<HTMLElement | null>(null)

  const explained = propertyId ? explainProperty(lineage, propertyId) : null
  const label = propertyId ? (labels?.[propertyId] ?? propertyId) : ""

  // A live refresh can leave the property with nothing to explain; the panel then closes for good
  // rather than open again by itself when it comes back.
  const unexplained = explained === null
  useEffect(() => {
    if (unexplained) setOpen(false)
  }, [unexplained])

  return (
    <>
      <TooltipProvider delayDuration={400}>
        <ValuePanel
          title={title}
          value={properties}
          schema={schema}
          labels={labels}
          fileLinks={fileLinks}
          renderLabel={(key, text) => {
            const property = explainProperty(lineage, key)
            if (!property) return text

            return (
              <PropertySourceLabel
                label={text}
                explained={property}
                onOpen={(event) => {
                  opener.current = event.currentTarget
                  setPropertyId(key)
                  setOpen(true)
                }}
              />
            )
          }}
        />
      </TooltipProvider>

      {lineage ? (
        <ValueLineagePanel
          lineage={lineage}
          objectName={objectName}
          open={open && explained !== null}
          shown={
            propertyId && explained
              ? {
                  propertyId,
                  label,
                  value: properties[propertyId],
                  explained,
                  display: { schema: propertySchema(propertyId), fileLinks },
                }
              : null
          }
          onClose={() => setOpen(false)}
          returnFocus={() => opener.current?.focus()}
        />
      ) : null}
    </>
  )
}
