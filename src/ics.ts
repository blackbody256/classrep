import https from "node:https"
import tls from "node:tls"
import { SECTIGO_OV_R36 } from "./sectigo-intermediate.js"

export type MueleEvent = {
  uid: string
  summary: string
  description: string
  course: string
  start: string // ISO datetime or YYYY-MM-DD
  allDay: boolean
}

export type EventType = "Assignment" | "Quiz / Test" | "Event"

const trustedCAs = [...tls.rootCertificates, SECTIGO_OV_R36]

export function fetchText(url: string, redirectsLeft = 3): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { ca: trustedCAs, timeout: 20_000 }, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume()
        resolve(fetchText(new URL(res.headers.location, url).toString(), redirectsLeft - 1))
        return
      }
      if (status !== 200) {
        res.resume()
        reject(new Error(`MUELE calendar request failed with HTTP ${status}`))
        return
      }
      let body = ""
      res.setEncoding("utf8")
      res.on("data", (chunk) => (body += chunk))
      res.on("end", () => resolve(body))
    })
    req.on("timeout", () => req.destroy(new Error("MUELE calendar request timed out")))
    req.on("error", reject)
  })
}

function unescapeIcs(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\([,;\\])/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .trim()
}

// "20261010T205900Z" | "20261010T235900" | "20261010" → ISO string
function parseIcsDate(value: string): { iso: string; allDay: boolean } {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/)
  if (!m) return { iso: value, allDay: false }
  const [, y, mo, d, h, mi, s, z] = m
  if (!h) return { iso: `${y}-${mo}-${d}`, allDay: true }
  return { iso: `${y}-${mo}-${d}T${h}:${mi}:${s}${z ? "Z" : ""}`, allDay: false }
}

export function parseIcs(text: string): MueleEvent[] {
  // Unfold continuation lines (RFC 5545: CRLF followed by a space or tab).
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/)
  const events: MueleEvent[] = []
  let current: Record<string, string> | null = null

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      current = {}
    } else if (line === "END:VEVENT" && current) {
      if (current.UID && current.DTSTART) {
        const { iso, allDay } = parseIcsDate(current.DTSTART)
        events.push({
          uid: current.UID,
          summary: unescapeIcs(current.SUMMARY ?? "Untitled event"),
          description: unescapeIcs(current.DESCRIPTION ?? ""),
          course: unescapeIcs(current.CATEGORIES ?? ""),
          start: iso,
          allDay,
        })
      }
      current = null
    } else if (current) {
      const sep = line.indexOf(":")
      if (sep > 0) {
        const name = line.slice(0, sep).split(";")[0].toUpperCase()
        current[name] = line.slice(sep + 1)
      }
    }
  }
  return events
}

export function classify(summary: string): EventType {
  if (/\bis due\b|assignment|coursework|submission/i.test(summary)) return "Assignment"
  if (/\b(quiz|test|exam)\b|\b(opens|closes)\b/i.test(summary)) return "Quiz / Test"
  return "Event"
}

export async function loadMueleEvents(): Promise<MueleEvent[]> {
  const url = process.env.MUELE_CALENDAR_URL
  if (!url) throw new Error("MUELE_CALENDAR_URL is not set")
  const events = parseIcs(await fetchText(url))

  // Optional: only keep chosen course units, e.g. MUELE_COURSES="CSC 2100,CSC 2209"
  const wanted = (process.env.MUELE_COURSES ?? "")
    .split(",")
    .map(normalizeCourse)
    .filter(Boolean)
  if (wanted.length === 0) return events
  return events.filter((event) => wanted.some((code) => normalizeCourse(event.course).includes(code)))
}

function normalizeCourse(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase()
}

// Upcoming deadlines within `days`, soonest first. Shared by the Worker tool and the Groq agent.
export async function upcomingDeadlines(days: number, course?: string | null) {
  const now = Date.now()
  const until = now + days * 24 * 60 * 60 * 1000
  const wanted = course ? normalizeCourse(course) : ""

  const upcoming = (await loadMueleEvents())
    .map((event) => ({ ...event, time: Date.parse(event.start) }))
    .filter((event) => event.time >= now && event.time <= until)
    .filter((event) => !wanted || normalizeCourse(event.course).includes(wanted))
    .sort((a, b) => a.time - b.time)

  return {
    count: upcoming.length,
    items: upcoming.map((event) => ({
      name: event.summary,
      course: event.course,
      type: classify(event.summary),
      due: event.start,
      dueKampala: new Date(event.time).toLocaleString("en-GB", { timeZone: "Africa/Kampala", dateStyle: "full", timeStyle: "short" }),
      hoursLeft: Math.round((event.time - now) / 36e5),
    })),
  }
}
