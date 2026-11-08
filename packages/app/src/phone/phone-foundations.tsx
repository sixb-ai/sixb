import { SheetGestures, TouchViewport } from "@sixb/ui/components"

/**
 * What makes every Sixb app behave like an installed one on a phone, whatever its layout: the
 * keyboard handling and the sheets that pull down to close. The generated root renders it once,
 * inside the router; each part does nothing with a mouse or on a wide screen.
 */
export function PhoneFoundations() {
  return (
    <>
      <TouchViewport />
      <SheetGestures />
    </>
  )
}
