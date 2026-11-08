import { AgentThreads } from "@sixb/app"
import { useNavigate } from "react-router-dom"
import { threadPath } from "../_lib/agent-threads"

/** Every conversation, inside the shell so the sidebar stays; a new one starts on Home. */
export default function NorthlineThreadsPage() {
  const navigate = useNavigate()
  return (
    <AgentThreads
      onSelectThread={(threadId) => navigate(threadPath(threadId))}
      onNewThread={() => navigate("/")}
    />
  )
}
