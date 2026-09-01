/**
 * Hand-written wire types for the stable Google Meet REST API v2.
 *
 * Resource fields remain optional because every method accepts Google's
 * standard `fields` partial-response selector. Open index signatures preserve
 * forward compatibility when Google adds output fields.
 */
import type { QueryParams } from "./common"

export type MeetAccessType = "ACCESS_TYPE_UNSPECIFIED" | "OPEN" | "TRUSTED" | "RESTRICTED"
export type MeetEntryPointAccess = "ENTRY_POINT_ACCESS_UNSPECIFIED" | "ALL" | "CREATOR_APP_ONLY"
export type MeetModeration = "MODERATION_UNSPECIFIED" | "OFF" | "ON"
export type MeetRestrictionType = "RESTRICTION_TYPE_UNSPECIFIED" | "HOSTS_ONLY" | "NO_RESTRICTION"
export type MeetDefaultJoinAsViewerType = "DEFAULT_JOIN_AS_VIEWER_TYPE_UNSPECIFIED" | "ON" | "OFF"
export type MeetAttendanceReportGenerationType =
  | "ATTENDANCE_REPORT_GENERATION_TYPE_UNSPECIFIED"
  | "GENERATE_REPORT"
  | "DO_NOT_GENERATE"
export type MeetAutoGenerationType = "AUTO_GENERATION_TYPE_UNSPECIFIED" | "ON" | "OFF"
export type MeetArtifactState = "STATE_UNSPECIFIED" | "STARTED" | "ENDED" | "FILE_GENERATED"

export interface MeetModerationRestrictions {
  readonly chatRestriction?: MeetRestrictionType
  readonly reactionRestriction?: MeetRestrictionType
  readonly presentRestriction?: MeetRestrictionType
  readonly defaultJoinAsViewerType?: MeetDefaultJoinAsViewerType
  readonly [key: string]: unknown
}

export interface MeetRecordingConfig {
  readonly autoRecordingGeneration?: MeetAutoGenerationType
  readonly [key: string]: unknown
}

export interface MeetTranscriptionConfig {
  readonly autoTranscriptionGeneration?: MeetAutoGenerationType
  readonly [key: string]: unknown
}

export interface MeetSmartNotesConfig {
  readonly autoSmartNotesGeneration?: MeetAutoGenerationType
  readonly [key: string]: unknown
}

export interface MeetArtifactConfig {
  readonly recordingConfig?: MeetRecordingConfig
  readonly transcriptionConfig?: MeetTranscriptionConfig
  readonly smartNotesConfig?: MeetSmartNotesConfig
  readonly [key: string]: unknown
}

export interface MeetSpaceConfig {
  readonly accessType?: MeetAccessType
  readonly entryPointAccess?: MeetEntryPointAccess
  readonly moderation?: MeetModeration
  readonly moderationRestrictions?: MeetModerationRestrictions
  readonly attendanceReportGenerationType?: MeetAttendanceReportGenerationType
  readonly artifactConfig?: MeetArtifactConfig
  readonly [key: string]: unknown
}

export interface MeetActiveConference {
  /** `conferenceRecords/{conferenceRecord}`. */
  readonly conferenceRecord?: string
  readonly [key: string]: unknown
}

export interface MeetPhoneAccess {
  readonly phoneNumber?: string
  readonly pin?: string
  readonly regionCode?: string
  readonly languageCode?: string
  readonly [key: string]: unknown
}

export interface MeetGatewaySipAccess {
  readonly uri?: string
  readonly sipAccessCode?: string
  readonly [key: string]: unknown
}

export interface MeetSpace {
  /** Stable resource name. Store this instead of the reusable meeting code. */
  readonly name?: string
  readonly meetingUri?: string
  readonly meetingCode?: string
  readonly config?: MeetSpaceConfig
  readonly activeConference?: MeetActiveConference
  readonly phoneAccess?: readonly MeetPhoneAccess[]
  readonly gatewaySipAccess?: readonly MeetGatewaySipAccess[]
  readonly [key: string]: unknown
}

/** Writable fields accepted by `spaces.create`. */
export interface MeetCreateSpaceRequest {
  readonly config?: MeetSpaceConfig
  readonly [key: string]: unknown
}

/** Writable fields accepted by `spaces.patch`; `name` supplies the path binding. */
export interface MeetPatchSpaceRequest {
  readonly name: string
  readonly config?: MeetSpaceConfig
  readonly [key: string]: unknown
}

export interface MeetConferenceRecord {
  readonly name?: string
  readonly startTime?: string
  readonly endTime?: string
  readonly expireTime?: string
  readonly space?: string
  readonly [key: string]: unknown
}

export interface MeetSignedInUser {
  /** `users/{user}`; interoperable with the Admin SDK and People API. */
  readonly user?: string
  readonly displayName?: string
  readonly [key: string]: unknown
}

export interface MeetAnonymousUser {
  readonly displayName?: string
  readonly [key: string]: unknown
}

export interface MeetPhoneUser {
  readonly displayName?: string
  readonly [key: string]: unknown
}

export interface MeetParticipant {
  readonly name?: string
  readonly earliestStartTime?: string
  readonly latestEndTime?: string | null
  /** Exactly one participant identity is normally present; partial responses may omit all three. */
  readonly signedinUser?: MeetSignedInUser
  readonly anonymousUser?: MeetAnonymousUser
  readonly phoneUser?: MeetPhoneUser
  readonly [key: string]: unknown
}

export interface MeetParticipantSession {
  readonly name?: string
  readonly startTime?: string
  readonly endTime?: string
  readonly [key: string]: unknown
}

export interface MeetDriveDestination {
  /** Drive file id for the underlying MP4. */
  readonly file?: string
  readonly exportUri?: string
  readonly [key: string]: unknown
}

export interface MeetDocsDestination {
  /** Google Docs document id for the generated artifact. */
  readonly document?: string
  readonly exportUri?: string
  readonly [key: string]: unknown
}

export interface MeetRecording {
  readonly name?: string
  readonly state?: MeetArtifactState
  readonly startTime?: string
  readonly endTime?: string
  readonly driveDestination?: MeetDriveDestination
  readonly [key: string]: unknown
}

export interface MeetTranscript {
  readonly name?: string
  readonly state?: MeetArtifactState
  readonly startTime?: string
  readonly endTime?: string
  readonly docsDestination?: MeetDocsDestination
  readonly [key: string]: unknown
}

export interface MeetTranscriptEntry {
  readonly name?: string
  readonly participant?: string
  readonly text?: string
  readonly languageCode?: string
  readonly startTime?: string
  readonly endTime?: string
  readonly [key: string]: unknown
}

export interface MeetSmartNote {
  readonly name?: string
  readonly state?: MeetArtifactState
  readonly startTime?: string
  readonly endTime?: string
  readonly docsDestination?: MeetDocsDestination
  readonly [key: string]: unknown
}

export type MeetGetOptions = QueryParams & {
  readonly fields?: string
}

export type MeetWriteOptions = MeetGetOptions

export type MeetPatchSpaceOptions = MeetWriteOptions & {
  /** Google field mask; omitted means all provided fields. */
  readonly updateMask?: string
}

export type MeetListConferenceRecordsOptions = MeetGetOptions & {
  readonly pageSize?: number
  readonly pageToken?: string
  /** Supports `space.meeting_code`, `space.name`, `start_time`, and `end_time`. */
  readonly filter?: string
}

export type MeetListParticipantsOptions = MeetGetOptions & {
  readonly pageSize?: number
  readonly pageToken?: string
  /** Supports `earliest_start_time` and `latest_end_time`. */
  readonly filter?: string
}

export type MeetListParticipantSessionsOptions = MeetGetOptions & {
  readonly pageSize?: number
  readonly pageToken?: string
  /** Supports `start_time` and `end_time`. */
  readonly filter?: string
}

export type MeetListArtifactsOptions = MeetGetOptions & {
  readonly pageSize?: number
  readonly pageToken?: string
}

export interface MeetListConferenceRecordsResponse {
  readonly conferenceRecords?: readonly MeetConferenceRecord[]
  readonly nextPageToken?: string
}

export interface MeetListParticipantsResponse {
  readonly participants?: readonly MeetParticipant[]
  readonly nextPageToken?: string
  /** Returned only when requested through `fields`. */
  readonly totalSize?: number
}

export interface MeetListParticipantSessionsResponse {
  readonly participantSessions?: readonly MeetParticipantSession[]
  readonly nextPageToken?: string
}

export interface MeetListRecordingsResponse {
  readonly recordings?: readonly MeetRecording[]
  readonly nextPageToken?: string
}

export interface MeetListTranscriptsResponse {
  readonly transcripts?: readonly MeetTranscript[]
  readonly nextPageToken?: string
}

export interface MeetListTranscriptEntriesResponse {
  readonly transcriptEntries?: readonly MeetTranscriptEntry[]
  readonly nextPageToken?: string
}

export interface MeetListSmartNotesResponse {
  readonly smartNotes?: readonly MeetSmartNote[]
  readonly nextPageToken?: string
}

export type MeetEmptyResponse = Readonly<Record<string, never>>
