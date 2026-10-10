import { getAuthSession, getProjectInfo } from "@sixb/client"
import { useQuery } from "@tanstack/react-query"
import { hostOf } from "./workspace-address"
import { useConnectedWorkspace } from "./workspace-context"

/** Who and where: the open workspace's name, and the signed-in user when there is one. */
export function useWorkspaceIdentity() {
  const { workspace, client } = useConnectedWorkspace()
  const project = useQuery({
    queryKey: ["project"],
    queryFn: async () => (await getProjectInfo({ client, throwOnError: true })).data,
  })
  const session = useQuery({
    queryKey: ["session"],
    enabled: workspace.signIn,
    queryFn: async () => (await getAuthSession({ client, throwOnError: true })).data,
  })
  return {
    workspace,
    user: session.data?.authenticated ? session.data.user : null,
    // Projects carry only an id; it is the name Atlas shows too.
    name: project.data?.id ?? hostOf(workspace.baseUrl),
  }
}
