import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native"
import Animated, { FadeIn } from "react-native-reanimated"
import { localImageFor, type PickedFile, useFileHeaders } from "../lib/agent/attachments"
import { isImage, messageFileUrl } from "../lib/agent/files"
import type { AgentFileRef } from "../lib/agent/types"
import { formatBytes } from "../lib/format"
import { makeStyles, usePalette } from "../lib/theme"
import { useConnectedWorkspace } from "../lib/workspace-context"
import { AlertIcon, CloseIcon, FileIcon } from "./icons"

// Spinners and icons on the dark overlay over a photo, white in either appearance.
const ON_OVERLAY = "#FFFFFF"

/** A file picked for the next message, as the composer shows it while it uploads. */
export interface DraftAttachment {
  readonly key: string
  readonly file: PickedFile
  readonly status: "uploading" | "ready" | "failed"
  readonly fileRef?: AgentFileRef
  /** Why the upload failed, for the person to read. */
  readonly error?: string
}

export function DraftAttachmentChip({
  draft,
  onRemove,
}: {
  readonly draft: DraftAttachment
  readonly onRemove: () => void
}) {
  const styles = useStyles()
  const c = usePalette()
  const image = isImage(draft.file.mediaType)
  return (
    <Animated.View entering={FadeIn.duration(180)} style={styles.draft}>
      {image ? (
        <Image
          source={{ uri: draft.file.uri }}
          style={styles.draftImage}
          accessibilityIgnoresInvertColors
        />
      ) : (
        <View style={styles.draftFile}>
          <FileIcon color={c.muted} />
          <Text style={styles.draftFileName} numberOfLines={2}>
            {draft.file.name}
          </Text>
        </View>
      )}
      {draft.status === "uploading" ? (
        <View style={styles.draftCover}>
          <ActivityIndicator color={ON_OVERLAY} />
        </View>
      ) : null}
      {draft.status === "failed" ? (
        <View style={[styles.draftCover, styles.draftFailed]}>
          <AlertIcon color={ON_OVERLAY} size={20} />
        </View>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove ${draft.file.name}`}
        onPress={onRemove}
        hitSlop={8}
        style={styles.remove}
      >
        <CloseIcon color={c.onInverse} size={11} />
      </Pressable>
    </Animated.View>
  )
}

/** The files on a user's message: photos as images, anything else as a named chip. */
export function UserFiles({
  message,
  files,
}: {
  readonly message: { readonly threadId: string; readonly id: string }
  readonly files: readonly { readonly fileRef: AgentFileRef; readonly partIndex: number }[]
}) {
  const styles = useStyles()
  if (files.length === 0) return null
  return (
    <View style={styles.userFiles}>
      {files.map(({ fileRef, partIndex }) => (
        <MessageFile key={partIndex} message={message} fileRef={fileRef} partIndex={partIndex} />
      ))}
    </View>
  )
}

/** The files on the message just sent, from this device's copies. */
export function PendingFiles({ files }: { readonly files: readonly PickedFile[] }) {
  const styles = useStyles()
  if (files.length === 0) return null
  return (
    <View style={styles.userFiles}>
      {files.map((file) =>
        isImage(file.mediaType) ? (
          <Image
            key={file.uri}
            source={{ uri: file.uri }}
            style={styles.image}
            accessibilityLabel={file.name}
            accessibilityIgnoresInvertColors
          />
        ) : (
          <FileChip key={file.uri} name={file.name} />
        )
      )}
    </View>
  )
}

/** One file of a saved message: an image loaded with the session, or a named chip. */
export function MessageFile({
  message,
  fileRef,
  partIndex,
}: {
  readonly message: { readonly threadId: string; readonly id: string }
  readonly fileRef: AgentFileRef
  readonly partIndex: number
}) {
  if (!isImage(fileRef.mediaType)) {
    return <FileChip name={fileRef.fileName ?? "File"} sizeBytes={fileRef.sizeBytes} />
  }
  return <MessageImage message={message} fileRef={fileRef} partIndex={partIndex} />
}

function MessageImage({
  message,
  fileRef,
  partIndex,
}: {
  readonly message: { readonly threadId: string; readonly id: string }
  readonly fileRef: AgentFileRef
  readonly partIndex: number
}) {
  const styles = useStyles()
  const { workspace } = useConnectedWorkspace()
  const headers = useFileHeaders()
  const local = localImageFor(fileRef.blobId)
  const label = fileRef.fileName ?? "Image"
  if (!local && !headers) return <View style={[styles.image, styles.imageLoading]} />
  return (
    <Image
      source={
        local
          ? { uri: local }
          : { uri: messageFileUrl(workspace.baseUrl, message, partIndex), headers: headers ?? {} }
      }
      style={styles.image}
      accessibilityLabel={label}
      accessibilityIgnoresInvertColors
    />
  )
}

function FileChip({ name, sizeBytes }: { readonly name: string; readonly sizeBytes?: number }) {
  const styles = useStyles()
  const c = usePalette()
  return (
    <View style={styles.fileChip}>
      <FileIcon color={c.muted} />
      <View style={styles.fileChipText}>
        <Text style={styles.fileChipName} numberOfLines={1}>
          {name}
        </Text>
        {sizeBytes !== undefined ? (
          <Text style={styles.fileChipSize}>{formatBytes(sizeBytes)}</Text>
        ) : null}
      </View>
    </View>
  )
}

const useStyles = makeStyles((c) =>
  StyleSheet.create({
    draft: { width: 64, height: 64, marginTop: 6, marginRight: 8 },
    draftImage: { width: 64, height: 64, borderRadius: 14, backgroundColor: c.well },
    draftFile: {
      width: 64,
      height: 64,
      padding: 6,
      gap: 4,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.well,
    },
    draftFileName: { fontSize: 10, lineHeight: 12, color: c.secondary, textAlign: "center" },
    draftCover: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "rgba(12,12,13,0.35)",
    },
    draftFailed: { backgroundColor: "rgba(180,35,24,0.75)" },
    remove: {
      position: "absolute",
      top: -6,
      right: -6,
      width: 22,
      height: 22,
      borderRadius: 11,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 2,
      borderColor: c.card,
      backgroundColor: c.inverse,
    },
    userFiles: {
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "flex-end",
      gap: 6,
      marginTop: 18,
      marginBottom: -12,
    },
    image: { width: 148, height: 148, borderRadius: 18, backgroundColor: c.well },
    imageLoading: { opacity: 0.6 },
    fileChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      maxWidth: 260,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 16,
      backgroundColor: c.card,
    },
    fileChipText: { flexShrink: 1 },
    fileChipName: { fontSize: 15, fontWeight: "500", color: c.ink },
    fileChipSize: { fontSize: 13, color: c.muted },
  })
)
