import { cn } from "@sixb/ui/lib/utils"
import { Loader2Icon } from "lucide-react"
import { useUiMessages } from "../../lib/i18n/ui"

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  const messages = useUiMessages()
  return (
    <Loader2Icon
      role="status"
      aria-label={messages.status.loading}
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  )
}

export { Spinner }
