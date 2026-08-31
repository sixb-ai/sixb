/** Encode a Meet AIP-122 resource name while preserving its `/` separators. */
function meetResourceName(value: string, field: string, pattern: RegExp, example: string): string {
  if (!pattern.test(value)) {
    throw new Error(`[SixbGoogle] ${field} must match ${example}.`)
  }
  return value.split("/").map(encodeURIComponent).join("/")
}

export function meetSpaceName(value: string, field = "name"): string {
  return meetResourceName(value, field, /^spaces\/[^/]+$/, '"spaces/{spaceOrMeetingCode}"')
}

export function meetConferenceRecordName(value: string, field = "name"): string {
  return meetResourceName(
    value,
    field,
    /^conferenceRecords\/[^/]+$/,
    '"conferenceRecords/{conferenceRecord}"'
  )
}

export function meetParticipantName(value: string, field = "name"): string {
  return meetResourceName(
    value,
    field,
    /^conferenceRecords\/[^/]+\/participants\/[^/]+$/,
    '"conferenceRecords/{conferenceRecord}/participants/{participant}"'
  )
}

export function meetParticipantSessionName(value: string, field = "name"): string {
  return meetResourceName(
    value,
    field,
    /^conferenceRecords\/[^/]+\/participants\/[^/]+\/participantSessions\/[^/]+$/,
    '"conferenceRecords/{conferenceRecord}/participants/{participant}/participantSessions/{session}"'
  )
}

export function meetRecordingName(value: string, field = "name"): string {
  return meetResourceName(
    value,
    field,
    /^conferenceRecords\/[^/]+\/recordings\/[^/]+$/,
    '"conferenceRecords/{conferenceRecord}/recordings/{recording}"'
  )
}

export function meetTranscriptName(value: string, field = "name"): string {
  return meetResourceName(
    value,
    field,
    /^conferenceRecords\/[^/]+\/transcripts\/[^/]+$/,
    '"conferenceRecords/{conferenceRecord}/transcripts/{transcript}"'
  )
}

export function meetTranscriptEntryName(value: string, field = "name"): string {
  return meetResourceName(
    value,
    field,
    /^conferenceRecords\/[^/]+\/transcripts\/[^/]+\/entries\/[^/]+$/,
    '"conferenceRecords/{conferenceRecord}/transcripts/{transcript}/entries/{entry}"'
  )
}

export function meetSmartNoteName(value: string, field = "name"): string {
  return meetResourceName(
    value,
    field,
    /^conferenceRecords\/[^/]+\/smartNotes\/[^/]+$/,
    '"conferenceRecords/{conferenceRecord}/smartNotes/{smartNote}"'
  )
}

export function assertMeetPageSize(
  value: number | undefined,
  maximum: number,
  field = "options.pageSize"
): void {
  if (value === undefined) {
    return
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`[SixbGoogle] ${field} must be an integer between 1 and ${maximum}.`)
  }
}
