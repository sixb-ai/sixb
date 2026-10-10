import { useRef, useState } from "react"
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import {
  type AttachmentSource,
  MAX_ATTACHMENTS,
  pickFiles,
  uploadPickedFile,
} from "../lib/agent/attachments"
import type { Attachment } from "../lib/agent/use-conversation"
import { errorMessage } from "../lib/format"
import { makeStyles, usePalette, useScheme } from "../lib/theme"
import { useConnectedWorkspace } from "../lib/workspace-context"
import { AttachSheet } from "./AttachSheet"
import { type DraftAttachment, DraftAttachmentChip } from "./attachments"
import { Glass } from "./Glass"
import { ArrowUpIcon, PlusIcon, StopIcon } from "./icons"

interface ComposerProps {
  readonly placeholder: string
  readonly responding: boolean
  readonly disabled?: boolean
  readonly onSend: (text: string, attachments: readonly Attachment[]) => Promise<boolean>
  readonly onStop: () => void
}

/**
 * The floating message bar: frosted glass over whatever scrolls beneath it. Files picked with "+"
 * upload straight away; the message sends once they are all up.
 */
export function Composer({ placeholder, responding, disabled, onSend, onStop }: ComposerProps) {
  const scheme = useScheme()
  const styles = useStyles()
  const c = usePalette()
  const { client } = useConnectedWorkspace()
  const [text, setText] = useState("")
  const [drafts, setDrafts] = useState<readonly DraftAttachment[]>([])
  const [sheetOpen, setSheetOpen] = useState(false)
  const nextKey = useRef(0)
  const uploading = drafts.some((draft) => draft.status === "uploading")
  const failedDraft = drafts.find((draft) => draft.status === "failed")
  const failed = failedDraft !== undefined
  const canSend = !disabled && !responding && text.trim().length > 0 && !uploading && !failed

  const update = (key: string, change: Partial<DraftAttachment>) =>
    setDrafts((current) =>
      current.map((draft) => (draft.key === key ? { ...draft, ...change } : draft))
    )

  const attach = async (source: AttachmentSource) => {
    let files: Awaited<ReturnType<typeof pickFiles>>
    try {
      files = await pickFiles(source, MAX_ATTACHMENTS - drafts.length)
    } catch (cause) {
      Alert.alert("Couldn't add that", errorMessage(cause))
      return
    }
    const added = files.map((file) => ({
      key: String(nextKey.current++),
      file,
      status: "uploading" as const,
    }))
    setDrafts((current) => [...current, ...added])
    for (const draft of added) {
      uploadPickedFile(client, draft.file).then(
        (fileRef) => update(draft.key, { status: "ready", fileRef }),
        (cause: unknown) => update(draft.key, { status: "failed", error: errorMessage(cause) })
      )
    }
  }

  const chooseSource = () => {
    if (drafts.length >= MAX_ATTACHMENTS) {
      Alert.alert(`A message can carry ${MAX_ATTACHMENTS} files.`)
      return
    }
    setSheetOpen(true)
  }

  const submit = async () => {
    if (!canSend) return
    const value = text
    const sent = drafts
    setText("")
    setDrafts([])
    const attachments = sent.flatMap((draft) =>
      draft.fileRef ? [{ fileRef: draft.fileRef, file: draft.file }] : []
    )
    // Give everything back when the send fails, so nothing typed or attached is lost.
    if (!(await onSend(value, attachments))) {
      setText(value)
      setDrafts(sent)
    }
  }

  return (
    <View style={styles.composerShadow}>
      <AttachSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onSelect={(source) => void attach(source)}
      />
      <Glass style={styles.composer}>
        {drafts.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.drafts}
            keyboardShouldPersistTaps="handled"
          >
            {drafts.map((draft) => (
              <DraftAttachmentChip
                key={draft.key}
                draft={draft}
                onRemove={() =>
                  setDrafts((current) => current.filter((entry) => entry.key !== draft.key))
                }
              />
            ))}
          </ScrollView>
        ) : null}
        {failedDraft ? (
          <Text style={styles.draftError}>
            Couldn't upload {failedDraft.file.name}
            {failedDraft.error ? `: ${failedDraft.error}` : "."} Remove it to send.
          </Text>
        ) : null}
        <View style={styles.composerRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add photos or files"
            onPress={chooseSource}
            disabled={disabled}
            style={styles.plusButton}
            hitSlop={6}
          >
            <PlusIcon color={disabled ? c.faint : c.ink} />
          </Pressable>
          <TextInput
            accessibilityLabel="Message"
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholder={drafts.length > 0 ? "Add a message" : placeholder}
            placeholderTextColor={c.muted}
            multiline
            editable={!disabled}
            keyboardAppearance={scheme}
          />
          {responding ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Stop"
              onPress={onStop}
              style={[styles.sendButton, styles.sendButtonOn]}
              hitSlop={6}
            >
              <StopIcon color={c.onInverse} />
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send"
              accessibilityState={{ disabled: !canSend, busy: uploading }}
              onPress={submit}
              disabled={!canSend}
              style={[styles.sendButton, canSend ? styles.sendButtonOn : styles.sendButtonOff]}
              hitSlop={6}
            >
              {uploading ? (
                <ActivityIndicator size="small" color={c.muted} />
              ) : (
                <ArrowUpIcon color={canSend ? c.onInverse : c.faint} />
              )}
            </Pressable>
          )}
        </View>
      </Glass>
    </View>
  )
}

const useStyles = makeStyles((c) =>
  StyleSheet.create({
    // The shadow sits on an outer view: the glass clips to its corners, which would clip a shadow.
    composerShadow: {
      borderRadius: 28,
      shadowColor: "#000000",
      shadowOpacity: 0.08,
      shadowRadius: 16,
      shadowOffset: { width: 0, height: 10 },
      elevation: 4,
    },
    composer: {
      minHeight: 56,
      paddingHorizontal: 8,
      paddingVertical: 8,
      borderRadius: 28,
    },
    composerRow: { flexDirection: "row", alignItems: "flex-end", gap: 4 },
    drafts: { paddingHorizontal: 8, paddingTop: 4, paddingBottom: 6 },
    draftError: { paddingHorizontal: 12, paddingBottom: 4, fontSize: 13, color: c.danger },
    plusButton: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
    },
    input: {
      flex: 1,
      minHeight: 40,
      maxHeight: 140,
      paddingTop: 9,
      paddingBottom: 9,
      fontSize: 17,
      lineHeight: 22,
      color: c.ink,
    },
    sendButton: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
    },
    sendButtonOn: { backgroundColor: c.inverse },
    sendButtonOff: { backgroundColor: c.well },
  })
)
