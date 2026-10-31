import { getDatasetVersionLineageOptions } from "@sixb/client/hooks"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@sixb/ui/components"
import { useIsMobile } from "@sixb/ui/hooks"
import { useQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { ValueTree } from "../../values"
import { useLineageMessages } from "./messages"
import type { ExplainedProperty, ObjectLineage } from "./model"
import { PropertyTrail, type ValueDisplay } from "./trail"

/** The property the panel explains, as the page shows it. */
export interface ExplainedValue {
  readonly propertyId: string
  readonly label: string
  readonly value: unknown
  readonly explained: ExplainedProperty
  readonly display: ValueDisplay
}

/**
 * Where one property's value comes from, beside the page: a sheet from the right, or a drawer from
 * the bottom on a phone. Opening it moves focus into it; closing it, with Escape too, gives focus
 * back to the property that opened it.
 */
export function ValueLineagePanel({
  lineage,
  objectName,
  open,
  shown,
  onClose,
  returnFocus,
}: {
  readonly lineage: ObjectLineage
  readonly objectName: string
  readonly open: boolean
  /** The property explained, kept while the panel slides closed. */
  readonly shown: ExplainedValue | null
  readonly onClose: () => void
  /** Focuses the control that opened the panel, once it has closed. */
  readonly returnFocus: () => void
}) {
  const messages = useLineageMessages()
  const mobile = useIsMobile()
  const changeOpen = (next: boolean) => (next ? undefined : onClose())
  const description = shown ? messages.propertyOf(shown.label, objectName) : ""

  // Without a trigger inside the dialog, it would leave focus where it was: on nothing.
  const focus = {
    onOpenAutoFocus: (event: Event) => {
      event.preventDefault()
      if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus()
    },
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault()
      returnFocus()
    },
  }

  const body = shown ? <PanelBody lineage={lineage} shown={shown} /> : null

  if (mobile) {
    return (
      <Drawer open={open} onOpenChange={changeOpen}>
        <DrawerContent className="max-h-[85dvh] outline-none" {...focus}>
          <div className="px-4 pt-3 pb-4">
            <DrawerTitle className="text-lg tracking-[-0.01em]">{messages.title}</DrawerTitle>
            <DrawerDescription className="mt-0.5 truncate">{description}</DrawerDescription>
          </div>
          <div className="min-h-0 overflow-y-auto px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
            {body}
          </div>
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <Sheet open={open} onOpenChange={changeOpen}>
      <SheetContent side="right" className="w-full gap-0 p-0 outline-none sm:max-w-md" {...focus}>
        <div className="border-b border-border p-6 pr-12">
          <SheetTitle className="text-lg tracking-[-0.01em]">{messages.title}</SheetTitle>
          <SheetDescription className="mt-0.5 truncate">{description}</SheetDescription>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-6">{body}</div>
      </SheetContent>
    </Sheet>
  )
}

function PanelBody({
  lineage,
  shown,
}: {
  readonly lineage: ObjectLineage
  readonly shown: ExplainedValue
}) {
  const { source } = shown.explained
  const applied = source.kind === "projection" ? source.datasetVersion : undefined

  // Read when the panel opens, not with the page: the walk is only this trail's.
  const upstream = useQuery({
    ...getDatasetVersionLineageOptions({
      path: { datasetId: applied?.datasetId ?? "", versionId: applied?.versionId ?? "" },
    }),
    enabled: applied !== undefined,
    retry: false,
  })

  return (
    <div className="flex flex-col gap-8">
      <ValueCard>
        <ValueTree
          value={shown.value}
          schema={shown.display.schema}
          fileLinks={shown.display.fileLinks}
          path={[shown.propertyId]}
        />
      </ValueCard>

      <PropertyTrail
        lineage={lineage}
        explained={shown.explained}
        upstream={upstream.data}
        upstreamPending={applied !== undefined && upstream.isPending}
        display={shown.display}
      />
    </div>
  )
}

function ValueCard({ children }: { readonly children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-card px-4 py-3.5 text-[0.9375rem] font-medium break-words shadow-[0_1px_2px_0_rgb(0_0_0/0.04)]">
      {children}
    </div>
  )
}
