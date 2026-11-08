import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { useOptionalTheme } from "../../hooks/useTheme"

const Toaster = ({ ...props }: ToasterProps) => {
  // Outside a ThemeProvider the toasts follow the system theme.
  const theme = useOptionalTheme()

  return (
    <Sonner
      theme={theme?.resolvedTheme ?? "system"}
      className="toaster group"
      // On a phone a toast drops in below the status bar, where banners appear natively.
      mobileOffset={{ top: "calc(env(safe-area-inset-top, 0px) + 8px)", left: 12, right: 12 }}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
