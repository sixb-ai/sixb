import type * as React from "react"
import { useMemo } from "react"
import { encode } from "uqr"

// Light modules around the code. Scanners need the contrast, and the page around it may be dark.
const QUIET_ZONE = 3

interface QrCodeProps extends Omit<React.ComponentProps<"svg">, "children" | "viewBox" | "role"> {
  /** The text to encode, usually a link. */
  readonly value: string
  /** Read in place of the code, such as "QR code to sign in on another device". */
  readonly label: string
}

/**
 * A QR code as an SVG: dark modules on white, so it scans in either theme. It needs no stylesheet;
 * size it with `width` and `height` or a class.
 */
export function QrCode({ value, label, ...props }: QrCodeProps) {
  const { path, size } = useMemo(() => {
    const { data } = encode(value, { ecc: "M", border: QUIET_ZONE })
    let path = ""
    for (const [y, row] of data.entries()) {
      for (const [x, dark] of row.entries()) {
        if (dark) path += `M${x} ${y}h1v1h-1z`
      }
    }
    return { path, size: data.length }
  }, [value])

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      {...props}
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  )
}
