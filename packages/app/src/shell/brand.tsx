import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@sixb/ui/components"
import { type ReactNode, useState } from "react"
import { Link } from "react-router-dom"

export interface BrandProps {
  /** Defaults to the title from `metadata` in `app/layout.tsx`. */
  readonly title?: string
  /** Defaults to the app's favicon, then to the title's first letter. */
  readonly icon?: ReactNode
  readonly href?: string
}

/** The app's name and mark at the top of the sidebar, linking home. */
export function Brand({ title, icon, href = "/" }: BrandProps) {
  // The build writes `metadata` into the document head. Read it once, before any page changes the
  // document title.
  const [identity] = useState(readDocumentIdentity)
  const name = title ?? identity.title
  const mark =
    icon ??
    (identity.iconHref ? (
      <img src={identity.iconHref} alt="" className="size-5" />
    ) : (
      <span className="text-sm font-semibold">{name.slice(0, 1).toUpperCase()}</span>
    ))

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="lg" asChild tooltip={name}>
          <Link to={href}>
            <span className="flex aspect-square size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
              {mark}
            </span>
            <span className="truncate font-semibold">{name}</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

export function readDocumentIdentity(): { readonly title: string; readonly iconHref?: string } {
  if (typeof document === "undefined") return { title: "" }
  const icon = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')
  return { title: document.title, ...(icon?.href ? { iconHref: icon.href } : {}) }
}
