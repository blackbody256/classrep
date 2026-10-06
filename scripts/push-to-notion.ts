// Push MUELE deadlines into a Notion database using the `ntn` CLI (works on every Notion plan).
// Run: npm run push   — first run creates a "ClassRep" page + "MUELE Deadlines" database.
import { execFileSync } from "node:child_process"
import { appendFileSync, existsSync } from "node:fs"
import { classify, loadMueleEvents, type MueleEvent } from "../src/ics.js"

const ENV_FILE = new URL("../.env", import.meta.url).pathname
const NOTION_VERSION = "2025-09-03"
const TIME_ZONE = "Africa/Kampala"

if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE)

type NotionPage = { id: string; properties: Record<string, any> }

function ntn(path: string, method: string, body?: unknown): any {
  const args = ["api", path, "-X", method, "--notion-version", NOTION_VERSION]
  if (body !== undefined) args.push("-d", JSON.stringify(body))
  const out = execFileSync("ntn", args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 })
  const json = JSON.parse(out)
  if (json.object === "error") throw new Error(`${method} ${path}: ${json.message}`)
  return json
}

const text = (content: string) => [{ type: "text", text: { content: content.slice(0, 1900) } }]

function kampalaDate(event: MueleEvent) {
  if (event.allDay) return { start: event.start }
  // "2026-10-06T18:00:00Z" → "2026-10-06 21:00:00" in Kampala time
  const local = new Date(event.start).toLocaleString("sv-SE", { timeZone: TIME_ZONE, hour12: false })
  return { start: local.replace(" ", "T"), time_zone: TIME_ZONE }
}

function setupDatabase(): string {
  let parent: any = { type: "workspace", workspace: true }
  let page: any
  try {
    page = ntn("v1/pages", "POST", {
      parent,
      icon: { type: "emoji", emoji: "🎓" },
      properties: { title: { title: text("ClassRep") } },
    })
  } catch {
    // Fall back to the first top-level page the CLI can see.
    const search = ntn("v1/search", "POST", { filter: { property: "object", value: "page" }, page_size: 50 })
    const top = search.results.find((r: any) => r.parent?.type === "workspace")
    if (!top) throw new Error("No top-level page found. Set NOTION_PARENT_PAGE_ID in .env.")
    parent = { type: "page_id", page_id: process.env.NOTION_PARENT_PAGE_ID ?? top.id }
    page = ntn("v1/pages", "POST", {
      parent,
      icon: { type: "emoji", emoji: "🎓" },
      properties: { title: { title: text("ClassRep") } },
    })
  }

  const db = ntn("v1/databases", "POST", {
    parent: { type: "page_id", page_id: page.id },
    title: text("MUELE Deadlines"),
    icon: { type: "emoji", emoji: "📚" },
    initial_data_source: {
      properties: {
        Name: { title: {} },
        "Event ID": { rich_text: {} },
        Course: { select: {} },
        Due: { date: {} },
        Type: {
          select: {
            options: [
              { name: "Assignment", color: "blue" },
              { name: "Quiz / Test", color: "red" },
              { name: "Event", color: "gray" },
            ],
          },
        },
        Details: { rich_text: {} },
      },
    },
  })
  const dataSourceId: string = db.data_sources[0].id
  appendFileSync(ENV_FILE, `NOTION_DATA_SOURCE_ID=${dataSourceId}\n`)
  console.log(`Created ClassRep page + MUELE Deadlines database: ${db.url ?? page.url}`)
  return dataSourceId
}

function existingRows(dataSourceId: string): Map<string, NotionPage> {
  const rows = new Map<string, NotionPage>()
  let cursor: string | undefined
  do {
    const res = ntn(`v1/data_sources/${dataSourceId}/query`, "POST", {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    })
    for (const page of res.results as NotionPage[]) {
      const key = page.properties["Event ID"]?.rich_text?.map((t: any) => t.plain_text).join("")
      if (key) rows.set(key, page)
    }
    cursor = res.has_more ? res.next_cursor : undefined
  } while (cursor)
  return rows
}

async function main() {
  const dataSourceId = process.env.NOTION_DATA_SOURCE_ID || setupDatabase()
  const events = await loadMueleEvents()
  const rows = existingRows(dataSourceId)
  let created = 0
  let updated = 0
  let removed = 0

  for (const event of events) {
    const type = classify(event.summary)
    const body = {
      icon: { type: "emoji", emoji: type === "Quiz / Test" ? "🧪" : type === "Assignment" ? "📝" : "📅" },
      properties: {
        Name: { title: text(event.summary) },
        "Event ID": { rich_text: text(event.uid) },
        Course: event.course ? { select: { name: event.course } } : { select: null },
        Due: { date: kampalaDate(event) },
        Type: { select: { name: type } },
        Details: { rich_text: text(event.description) },
      },
    }
    const existing = rows.get(event.uid)
    if (existing) {
      ntn(`v1/pages/${existing.id}`, "PATCH", body)
      rows.delete(event.uid)
      updated++
    } else {
      ntn("v1/pages", "POST", { parent: { type: "data_source_id", data_source_id: dataSourceId }, ...body })
      created++
    }
    console.log(`${existing ? "updated" : "created"}  ${event.course.padEnd(8)} ${event.summary}`)
  }

  // Rows no longer in the MUELE feed (or filtered out by MUELE_COURSES) go to Notion's trash.
  for (const page of rows.values()) {
    ntn(`v1/pages/${page.id}`, "PATCH", { in_trash: true })
    removed++
  }

  console.log(`\nDone: ${created} created, ${updated} updated, ${removed} moved to trash.`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
