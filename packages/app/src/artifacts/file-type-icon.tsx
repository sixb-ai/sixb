import { cn } from "@sixb/ui/lib/utils"

export type FileTypeName = "xlsx" | "csv" | "md" | "pdf" | "image" | "file"

/**
 * Each type's badge color and the lines drawn on its page: a workbook's grid, a CSV's rows, a
 * text's lines. The colors read as the formats do elsewhere, green for spreadsheets, red for PDF,
 * on light and dark surfaces alike.
 */
const FILE_TYPES: Record<FileTypeName, { readonly label: string; readonly color: string }> = {
  xlsx: { label: "XLSX", color: "#107C41" },
  csv: { label: "CSV", color: "#0E7C6B" },
  md: { label: "MD", color: "#2563EB" },
  pdf: { label: "PDF", color: "#D93025" },
  image: { label: "IMG", color: "#7C3AED" },
  file: { label: "FILE", color: "#64748B" },
}

/** A file's type, read from its name's extension. */
export function fileTypeOf(name: string): FileTypeName {
  const extension = name.split(".").at(-1)?.toLowerCase() ?? ""
  if (extension === "xlsx" || extension === "xls") return "xlsx"
  if (extension === "csv" || extension === "tsv") return "csv"
  if (extension === "md" || extension === "markdown") return "md"
  if (extension === "pdf") return "pdf"
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"].includes(extension)) return "image"
  return "file"
}

/**
 * A file's icon as a document page with its type on a colored badge, as file managers draw them:
 * what a download gives the reader, at a glance.
 */
export function FileTypeIcon({
  type,
  height = 28,
  className,
}: {
  readonly type: FileTypeName
  /** Its height in pixels; the width follows the page's shape. */
  readonly height?: number
  readonly className?: string
}) {
  const { label, color } = FILE_TYPES[type]
  return (
    <svg
      viewBox="0 0 32 40"
      aria-hidden="true"
      // Sized inline: menus size their items' icons by class, and this one keeps its own.
      style={{ height, width: (height * 32) / 40 }}
      className={cn("shrink-0", className)}
    >
      <path
        d="M5 1.5h15.5L29.5 10.5V35A3.5 3.5 0 0 1 26 38.5H5A3.5 3.5 0 0 1 1.5 35V5A3.5 3.5 0 0 1 5 1.5Z"
        fill="var(--card)"
        stroke="color-mix(in oklab, var(--foreground) 22%, transparent)"
        strokeWidth="1.25"
      />
      <path
        d="M20.5 1.5V8A2.5 2.5 0 0 0 23 10.5h6.5"
        fill="color-mix(in oklab, var(--foreground) 6%, var(--card))"
        stroke="color-mix(in oklab, var(--foreground) 22%, transparent)"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <PageMarks type={type} color={color} />
      <rect x="0" y="22" width={label.length > 3 ? 26 : 22} height="11" rx="2.5" fill={color} />
      <text
        x={label.length > 3 ? 13 : 11}
        y="30"
        textAnchor="middle"
        fontSize="7.4"
        fontWeight="700"
        letterSpacing="0.2"
        fill="#fff"
        fontFamily="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
      >
        {label}
      </text>
    </svg>
  )
}

/** What the page shows above the badge: a grid, rows, or lines of text, in the type's color. */
function PageMarks({ type, color }: { readonly type: FileTypeName; readonly color: string }) {
  if (type === "xlsx") {
    return (
      <g stroke={color} strokeWidth="1" opacity="0.55">
        <rect x="7" y="7" width="12" height="10" rx="1" fill="none" />
        <path d="M7 10.4h12M7 13.7h12M11.5 7v10M15 7v10" />
      </g>
    )
  }
  if (type === "csv") {
    return (
      <g fill={color} opacity="0.5">
        {[7, 10.5, 14].map((y) => (
          <g key={y}>
            <rect x="7" y={y} width="4" height="2" rx="1" />
            <rect x="12.5" y={y} width="4" height="2" rx="1" />
            <rect x="18" y={y} width="4" height="2" rx="1" />
          </g>
        ))}
      </g>
    )
  }
  return (
    <g fill="color-mix(in oklab, var(--foreground) 22%, transparent)">
      <rect x="7" y="7" width="12" height="2" rx="1" />
      <rect x="7" y="11" width="16" height="2" rx="1" />
      <rect x="7" y="15" width="10" height="2" rx="1" />
    </g>
  )
}
