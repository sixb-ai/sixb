import {
  getSixbSessionAccessToken,
  type SixbClient,
  type UploadFileRawData,
  uploadFileRaw,
} from "@sixb/client"
import * as DocumentPicker from "expo-document-picker"
import { File as LocalFile } from "expo-file-system"
import * as ImagePicker from "expo-image-picker"
import { useEffect, useState } from "react"
import { Alert, Linking } from "react-native"
import { sessionStore } from "../workspace"
import { useConnectedWorkspace } from "../workspace-context"
import { isImage, uploadName } from "./files"
import type { AgentFileRef } from "./types"

/** A file chosen on this device, read from its local `uri`. */
export interface PickedFile {
  readonly uri: string
  readonly name: string
  readonly mediaType: string
}

export type AttachmentSource = "camera" | "library" | "files"

export const MAX_ATTACHMENTS = 10
// JPEG at this quality keeps phone photos to a few megabytes with no visible loss.
const PHOTO_QUALITY = 0.8

/** Ask for files from the camera, the photo library or the Files app. Empty when cancelled. */
export async function pickFiles(source: AttachmentSource, limit: number): Promise<PickedFile[]> {
  if (source === "camera") {
    const permission = await ImagePicker.requestCameraPermissionsAsync()
    if (!permission.granted) {
      Alert.alert("Camera access is off", "Allow Sixb to use the camera in Settings.", [
        { text: "Cancel", style: "cancel" },
        { text: "Open Settings", onPress: () => void Linking.openSettings() },
      ])
      return []
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: PHOTO_QUALITY,
    })
    return result.canceled ? [] : result.assets.map(fromImageAsset)
  }
  if (source === "library") {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: PHOTO_QUALITY,
      allowsMultipleSelection: true,
      selectionLimit: limit,
      // HEIC photos become JPEG, which models and browsers read.
      preferredAssetRepresentationMode:
        ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    })
    return result.canceled ? [] : result.assets.slice(0, limit).map(fromImageAsset)
  }
  const result = await DocumentPicker.getDocumentAsync({
    multiple: true,
    copyToCacheDirectory: true,
  })
  if (result.canceled) return []
  return result.assets.slice(0, limit).map((asset) => ({
    uri: asset.uri,
    name: asset.name,
    mediaType: asset.mimeType ?? "application/octet-stream",
  }))
}

function fromImageAsset(asset: ImagePicker.ImagePickerAsset): PickedFile {
  const mediaType = asset.mimeType ?? "image/jpeg"
  const name = asset.fileName ?? `photo-${Date.now()}.jpg`
  // A converted photo can keep its original name; give it the extension of what it now is.
  return {
    uri: asset.uri,
    mediaType,
    name: mediaType === "image/jpeg" ? name.replace(/\.(heic|heif)$/i, ".jpg") : name,
  }
}

// Photos sent from this device, by blob, so the saved message shows the local copy instead of
// downloading the same image again.
const localImages = new Map<string, string>()

export function localImageFor(blobId: string): string | undefined {
  return localImages.get(blobId)
}

/** Upload a picked file to the workspace, ready to attach to a message. */
export async function uploadPickedFile(
  client: SixbClient,
  file: PickedFile
): Promise<AgentFileRef> {
  // Expo's fetch encodes a form part from any object with `bytes()`, taking its filename and
  // content type from `name` and `type`. It refuses React Native's `{ uri }` parts, and the
  // generated client's serializer only passes real Blobs through, so the form is built here.
  const part = {
    name: uploadName(file.name),
    type: file.mediaType,
    bytes: async () => new Uint8Array(await new LocalFile(file.uri).arrayBuffer()),
  }
  const form = new FormData()
  form.append("file", part as unknown as Blob)
  const { data } = await uploadFileRaw({
    client,
    body: form as unknown as UploadFileRawData["body"],
    bodySerializer: null,
    throwOnError: true,
  })
  if (isImage(file.mediaType)) localImages.set(data.blobId, file.uri)
  return data
}

/**
 * Headers that let an image load a workspace file: the session's access token, or none for a
 * workspace without sign-in. Null until the token is read.
 */
export function useFileHeaders(): Readonly<Record<string, string>> | null {
  const { workspace } = useConnectedWorkspace()
  const [headers, setHeaders] = useState<Readonly<Record<string, string>> | null>(
    workspace.signIn ? null : {}
  )
  useEffect(() => {
    if (!workspace.signIn) return
    let cancelled = false
    getSixbSessionAccessToken({ baseUrl: workspace.baseUrl, store: sessionStore })
      .then((token) => {
        if (!cancelled && token) setHeaders({ authorization: `Bearer ${token}` })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [workspace])
  return headers
}
