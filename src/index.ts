import { Worker } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"
import { j } from "@notionhq/workers/schema-builder"
import { classify, loadMueleEvents, upcomingDeadlines } from "./ics.js"

const worker = new Worker()
export default worker

// -- MUELE calendar feed --
// MUELE → Calendar → Import or export calendars → Export calendar → Get calendar URL.
// Store it with `ntn workers env set MUELE_CALENDAR_URL=...` (never commit it).

// Be gentle with the university server: a handful of requests per minute at most.
const mueleApi = worker.pacer("muele", { allowedRequests: 6, intervalMs: 60_000 })

// -- Sync: MUELE deadlines → Notion "Deadlines" database --

const deadlines = worker.database("deadlines", {
  type: "managed",
  initialTitle: "MUELE Deadlines",
  primaryKeyProperty: "Event ID",
  schema: {
    properties: {
      Name: Schema.title(),
      "Event ID": Schema.richText(),
      Course: Schema.richText(),
      Due: Schema.date(),
      Type: Schema.select([
        { name: "Assignment", color: "blue" },
        { name: "Quiz / Test", color: "red" },
        { name: "Event", color: "gray" },
      ]),
      Details: Schema.richText(),
    },
  },
})

worker.sync("mueleDeadlines", {
  database: deadlines,
  mode: "replace",
  schedule: "1h",
  execute: async () => {
    await mueleApi.wait()
    const events = await loadMueleEvents()
    return {
      changes: events.map((event) => {
        const type = classify(event.summary)
        return {
          type: "upsert" as const,
          key: event.uid,
          icon: Builder.emojiIcon(type === "Quiz / Test" ? "🧪" : type === "Assignment" ? "📝" : "📅"),
          properties: {
            Name: Builder.title(event.summary),
            "Event ID": Builder.richText(event.uid),
            Course: Builder.richText(event.course),
            Due: event.allDay ? Builder.date(event.start) : Builder.dateTime(event.start),
            Type: Builder.select(type),
            Details: Builder.richText(event.description.slice(0, 1900)),
          },
        }
      }),
      hasMore: false,
    }
  },
})

// -- Tool: "what's due?" for Custom Agents (and later, the WhatsApp bot) --

worker.tool("whatsDue", {
  title: "What's due on MUELE",
  description:
    "Lists upcoming MUELE assignments, quizzes and tests within the next N days, soonest first. Use when a student asks what is due, what tests are coming, or what to work on next.",
  schema: j.object({
    days: j.number().describe("How many days ahead to look, e.g. 7 for this week.").nullable(),
    course: j.string().describe("Optional course code filter, e.g. CSC 2100.").nullable(),
  }),
  hints: { readOnlyHint: true },
  execute: ({ days, course }) => upcomingDeadlines(days ?? 7, course),
})
