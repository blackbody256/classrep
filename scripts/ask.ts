// ClassRep agent: Groq LLM + deterministic tools (MUELE deadlines, save plan to Notion).
// Run: npm run ask -- "What's due this week? Make me a study plan and save it to Notion."
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { upcomingDeadlines } from "../src/ics.js"

const ENV_FILE = new URL("../.env", import.meta.url).pathname
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE)

const MODEL = process.env.GROQ_MODEL ?? "openai/gpt-oss-120b"
const NOTION_VERSION = "2025-09-03"

function ntn(args: string[]): string {
  return execFileSync("ntn", args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 })
}

// The ClassRep page is the parent of the MUELE Deadlines database.
function classRepPageId(): string {
  const dataSourceId = process.env.NOTION_DATA_SOURCE_ID
  if (!dataSourceId) throw new Error("Run `npm run push` first to create the Notion database.")
  const dataSource = JSON.parse(ntn(["api", `v1/data_sources/${dataSourceId}`, "-X", "GET", "--notion-version", NOTION_VERSION]))
  const databaseId = dataSource.parent?.database_id
  const database = JSON.parse(ntn(["api", `v1/databases/${databaseId}`, "-X", "GET", "--notion-version", NOTION_VERSION]))
  return database.parent.page_id
}

const tools = [
  {
    type: "function",
    function: {
      name: "whatsDue",
      description: "Lists upcoming MUELE assignments, quizzes and tests within the next N days, soonest first.",
      parameters: {
        type: "object",
        properties: {
          days: { type: "number", description: "How many days ahead to look, e.g. 7 for this week." },
          course: { type: "string", description: "Optional course code filter, e.g. CSC3119." },
        },
        required: ["days"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "savePlanToNotion",
      description: "Saves a study plan as a new page under the student's ClassRep page in Notion. Use only when the student asks to save or create a plan.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short page title, e.g. 'Study plan: 6–13 Oct'." },
          markdown: { type: "string", description: "The plan body in Markdown (headings, checklists)." },
        },
        required: ["title", "markdown"],
      },
    },
  },
]

async function runTool(name: string, args: any): Promise<unknown> {
  if (name === "whatsDue") return upcomingDeadlines(args.days ?? 7, args.course)
  if (name === "savePlanToNotion") {
    const out = ntn(["pages", "create", "--parent", `page:${classRepPageId()}`, "--content", `# ${args.title}\n\n${args.markdown}`, "--json"])
    const page = JSON.parse(out)
    return { saved: true, url: page.url ?? page.id }
  }
  return { error: `Unknown tool ${name}` }
}

async function chat(messages: any[]) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: "auto", temperature: 0.2 }),
  })
  const json: any = await res.json()
  if (!res.ok) throw new Error(`Groq ${res.status}: ${json.error?.message ?? JSON.stringify(json)}`)
  return json.choices[0].message
}

async function main() {
  const question = process.argv.slice(2).join(" ") || "What's due this week?"
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not set in .env")

  const messages: any[] = [
    {
      role: "system",
      content:
        "You are ClassRep, a study assistant for a Makerere University student. " +
        "Always call whatsDue to get deadlines — never invent or guess dates. " +
        "Quote times exactly as given in dueKampala (Kampala time). Flag anything due within 24 hours as urgent. " +
        "Be brief and practical. Today is " + new Date().toLocaleString("en-GB", { timeZone: "Africa/Kampala", dateStyle: "full", timeStyle: "short" }) + ".",
    },
    { role: "user", content: question },
  ]

  for (let step = 0; step < 6; step++) {
    const message = await chat(messages)
    messages.push(message)
    if (!message.tool_calls?.length) {
      console.log(`\n${message.content}\n`)
      return
    }
    for (const call of message.tool_calls) {
      const args = JSON.parse(call.function.arguments || "{}")
      console.error(`→ tool: ${call.function.name}(${JSON.stringify(args).slice(0, 80)})`)
      const result = await runTool(call.function.name, args)
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) })
    }
  }
  console.log("Stopped after too many tool calls.")
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
