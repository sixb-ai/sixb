import { Hand, type LucideIcon, PencilLine, Zap } from "lucide-react"
import type { AgentApprovalMode } from "../approvals"

/** Each approval mode's icon, in the composer's permissions and in Settings. */
export const APPROVAL_MODE_ICONS: Readonly<Record<AgentApprovalMode, LucideIcon>> = {
  manual: Hand,
  "accept-edits": PencilLine,
  auto: Zap,
}
