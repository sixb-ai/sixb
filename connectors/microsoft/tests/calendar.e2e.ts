import { describe, expect, test } from "bun:test"
import { type CalendarEvent, type CalendarSurface, MicrosoftApiError, microsoft } from "../src"

// Explicit opt-in. Both participating mailboxes must be dedicated, consenting test accounts:
// this test sends an invitation, an acceptance and a cancellation, then removes its own data.
const enabled = process.env.MICROSOFT_CALENDAR_E2E === "1"
function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name} for the explicitly enabled calendar E2E.`)
  return value
}
async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const value = await read()
    if (ready(value)) return value
    if (Date.now() >= deadline)
      throw new Error("Calendar change was not visible within 30 seconds.")
    await Bun.sleep(1000)
  }
}

describe.skipIf(!enabled)("Outlook calendar live application access", () => {
  test("scoped calendars, recurring instances, attachments, delta and meeting responses", async () => {
    const auth = {
      tenantId: required("MICROSOFT_TENANT_ID"),
      clientId: required("MICROSOFT_CLIENT_ID"),
      clientSecret: required("MICROSOFT_CLIENT_SECRET"),
    }
    const mailbox = required("MICROSOFT_CALENDAR_TEST_MAILBOX")
    const attendee = required("MICROSOFT_CALENDAR_TEST_ATTENDEE")
    const denied = required("MICROSOFT_CALENDAR_DENIED_MAILBOX")
    if (mailbox.toLowerCase() === attendee.toLowerCase())
      throw new Error("Organizer and attendee must be different test mailboxes.")
    const context = {
      projectId: "calendar-e2e",
      connectorId: "microsoft",
      signal: AbortSignal.timeout(240_000),
    }
    const { calendar } = await microsoft({ auth }).connect(context)
    await expect(calendar.calendars.list(denied, { top: 1 })).rejects.toMatchObject({ status: 403 })
    await calendar.calendars.getDefault(attendee)
    const name = `sixb-calendar-e2e-${crypto.randomUUID()}`
    const day = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10)
    const endDay = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)
    const range = { startDateTime: `${day}T00:00:00Z`, endDateTime: `${endDay}T00:00:00Z` }
    const start = { dateTime: `${day}T09:00:00`, timeZone: "UTC" }
    const end = { dateTime: `${day}T10:00:00`, timeZone: "UTC" }
    const owned: { mailbox: string; id: string }[] = []
    const errors: unknown[] = []
    let calendarId: string | undefined
    const own = (owner: string, event: CalendarEvent) => {
      owned.push({ mailbox: owner, id: event.id })
      return event
    }
    try {
      const secondary = await calendar.calendars.create(mailbox, name)
      calendarId = secondary.id
      expect(
        (await calendar.calendars.update(mailbox, secondary.id, { name: `${name} updated` })).name
      ).toBe(`${name} updated`)
      const recurring = own(
        mailbox,
        await calendar.events.create(
          mailbox,
          {
            subject: name,
            start,
            end,
            recurrence: {
              pattern: { type: "daily", interval: 1 },
              range: { type: "numbered", startDate: day, numberOfOccurrences: 3 },
            },
          },
          { calendarId }
        )
      )
      const instances = await calendar.events.instances(mailbox, recurring.id, range)
      expect(instances.value).toHaveLength(3)
      const occurrence = instances.value[1]
      expect(
        (await calendar.events.update(mailbox, occurrence.id, { subject: `${name} exception` })).id
      ).toBe(occurrence.id)
      const view = await calendar.view.list(mailbox, { ...range, calendarId })
      expect(view.value.some((item) => item.type === "exception")).toBe(true)
      const appointment = own(
        mailbox,
        await calendar.events.create(
          mailbox,
          {
            subject: name,
            isAllDay: true,
            start: { dateTime: `${day}T00:00:00`, timeZone: "UTC" },
            end: { dateTime: `${endDay}T00:00:00`, timeZone: "UTC" },
          },
          { calendarId }
        )
      )
      expect((await calendar.events.get(mailbox, appointment.id)).isAllDay).toBe(true)
      for (const size of [4, 4 * 1024 * 1024 + 17]) {
        const bytes = new Uint8Array(size)
        bytes[0] = 17
        bytes[size - 1] = 255
        const attachment = await calendar.attachments.upload(
          mailbox,
          appointment.id,
          `test-${size}.bin`,
          bytes
        )
        expect(
          Bun.hash(await calendar.attachments.download(mailbox, appointment.id, attachment.id))
        ).toBe(Bun.hash(bytes))
        await calendar.attachments.delete(mailbox, appointment.id, attachment.id)
      }
      let cursor: string | undefined
      for await (const page of calendar.view.delta.pages(mailbox, range))
        cursor = page["@odata.deltaLink"]
      if (!cursor) throw new Error("Initial calendar delta did not return a checkpoint.")
      const meeting = own(
        mailbox,
        await calendar.events.create(mailbox, {
          subject: name,
          start,
          end,
          transactionId: crypto.randomUUID(),
          attendees: [{ emailAddress: { address: attendee }, type: "required" }],
          ...(process.env.MICROSOFT_CALENDAR_TEST_TEAMS === "1"
            ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" as const }
            : {}),
        })
      )
      if (process.env.MICROSOFT_CALENDAR_TEST_TEAMS === "1")
        expect(meeting.onlineMeeting?.joinUrl).toBeTruthy()
      await eventually(async () => {
        let found = false
        for await (const page of calendar.view.delta.pages(mailbox, { cursor: cursor! })) {
          found ||= page.value.some((item) => item.id === meeting.id && !item["@removed"])
          cursor = page["@odata.deltaLink"] ?? cursor
        }
        return found
      }, Boolean)
      const invitation = await eventually(
        async () => {
          for await (const item of calendar.view.listAll(attendee, range)) {
            if (item.iCalUId === meeting.iCalUId && item.subject === name) return item
          }
          return undefined
        },
        (value) => value !== undefined
      )
      if (!invitation) throw new Error("Attendee's event is missing.")
      own(attendee, invitation)
      expect(
        (await calendar.events.accept(attendee, invitation.id, { sendResponse: true })).status
      ).toBe("accepted")
      await eventually(
        () => calendar.events.get(mailbox, meeting.id),
        (item) =>
          item.attendees?.some(
            (a) =>
              a.emailAddress.address?.toLowerCase() === attendee.toLowerCase() &&
              a.status?.response === "accepted"
          ) === true
      )
      const schedule = await calendar.getSchedule(mailbox, {
        schedules: [mailbox, attendee],
        startTime: start,
        endTime: end,
      })
      expect(schedule.value).toHaveLength(2)
      expect(schedule.value.every((item) => !item.error)).toBe(true)
      expect(
        (
          await calendar.events.cancel(mailbox, meeting.id, {
            comment: "Sixb integration test complete.",
          })
        ).status
      ).toBe("accepted")
    } catch (error) {
      errors.push(error)
    } finally {
      const cleanup: CalendarSurface = (
        await microsoft({ auth }).connect({ ...context, signal: AbortSignal.timeout(45_000) })
      ).calendar
      // Attendee copies first, then organizer copies. A cancelled/declined event can already be absent.
      for (const item of owned.reverse()) {
        try {
          await cleanup.events.delete(item.mailbox, item.id)
        } catch (error) {
          if (!(error instanceof MicrosoftApiError && error.status === 404)) errors.push(error)
        }
      }
      if (calendarId) {
        try {
          await cleanup.calendars.delete(mailbox, calendarId)
        } catch (error) {
          errors.push(error)
        }
      }
    }
    if (errors.length) throw new AggregateError(errors, `Calendar E2E or cleanup failed (${name}).`)
  }, 290_000)
})
