import { useRouter } from "expo-router"
import { Alert, Pressable, StyleSheet, Text, View } from "react-native"
import { initials } from "../lib/format"
import { makeStyles, usePalette } from "../lib/theme"
import { hostOf } from "../lib/workspace-address"
import { useWorkspace } from "../lib/workspace-context"
import { useWorkspaceIdentity } from "../lib/workspace-identity"
import { Glass, GlassButton } from "./Glass"
import { ChevronDownIcon, HistoryIcon } from "./icons"

/** Today's top bar: the workspace on the left; history and the account on the right. */
export function WorkspaceHeader() {
  const styles = useStyles()
  const c = usePalette()
  const router = useRouter()
  const { leave } = useWorkspace()
  const { workspace, user, name } = useWorkspaceIdentity()

  const confirmLeave = () =>
    Alert.alert(name, [user?.email, hostOf(workspace.baseUrl)].filter(Boolean).join("\n"), [
      { text: "Cancel", style: "cancel" },
      {
        text: workspace.signIn ? "Sign out" : "Disconnect",
        style: "destructive",
        onPress: () => void leave(),
      },
    ])

  return (
    <View style={styles.header}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Workspace ${name}`}
        accessibilityHint="Shows the workspace and signs out"
        onPress={confirmLeave}
        style={({ pressed }) => [styles.workspaceButton, pressed && styles.pressed]}
      >
        <Glass style={styles.workspaceCapsule}>
          <View style={styles.workspaceBadge}>
            <Text style={styles.workspaceBadgeText}>{initials(name).slice(0, 1)}</Text>
          </View>
          <Text style={styles.workspaceName} numberOfLines={1}>
            {name}
          </Text>
          <ChevronDownIcon color={c.muted} />
        </Glass>
      </Pressable>
      <View style={styles.headerActions}>
        <GlassButton accessibilityLabel="Chat history" onPress={() => router.push("/history")}>
          <HistoryIcon color={c.ink} />
        </GlassButton>
        {user ? (
          <GlassButton accessibilityLabel="Account" onPress={confirmLeave}>
            <Text style={styles.avatarText}>{initials(user.displayName ?? user.email)}</Text>
          </GlassButton>
        ) : null}
      </View>
    </View>
  )
}

const useStyles = makeStyles((c) =>
  StyleSheet.create({
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      height: 52,
      paddingTop: 8,
      paddingHorizontal: 16,
    },
    workspaceButton: { flexShrink: 1, marginRight: 12 },
    workspaceCapsule: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      height: 40,
      paddingLeft: 6,
      paddingRight: 14,
      borderRadius: 20,
    },
    workspaceBadge: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.badge,
    },
    workspaceBadgeText: { fontSize: 15, fontWeight: "700", color: "#FFFFFF" },
    workspaceName: { flexShrink: 1, fontSize: 16, fontWeight: "600", color: c.ink },
    headerActions: { flexDirection: "row", alignItems: "center", gap: 10 },
    pressed: { transform: [{ scale: 0.97 }], opacity: 0.85 },
    avatarText: { fontSize: 13, fontWeight: "600", letterSpacing: 0.3, color: c.ink },
  })
)
