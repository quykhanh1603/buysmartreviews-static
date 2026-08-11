// One-off: rewrite the 142 WP-migrated posts so they don't all share the same
// rigid Quick verdict/What customer ratings show/Recurring themes/Before you
// order/Bottom line heading template. Keeps every fact/rating from the
// original, only varies structure and wording. Title/slug/date/categories/
// image are left untouched (SEO metadata).
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SRC = path.resolve(import.meta.dirname, "..", "src");
const POSTS_DIR = path.join(SRC, "posts");
const EXCLUDE = new Set([
  "is-bear-mattress-legit.html",
  "is-grovemade-legit.html",
  "is-true-classic-legit.html",
]);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY env var");
  process.exit(1);
}

const SHAPES = [
  "Open with your take on whether this business is trustworthy in the very first sentence — no company-background sentence first. Use exactly 2 <h2> headings total. No bullet lists.",
  "Open with the single most specific number or rating from the article as the hook. Use 3 <h2> headings and include exactly one <ul> of quick facts placed right after the opening paragraph.",
  "Write it like you're answering a friend who just texted asking whether they should order from this place — conversational, second person ('you'). Phrase 2 of the headings as questions. Use 3 headings total.",
  "Write it as flowing prose paragraphs with no bullet lists at all. Use 4 <h2> headings. Never use the word 'verdict' anywhere.",
  "Open with the single most surprising or notable fact about this business, stated bluntly. Use 2 <h2> headings and end with a single blunt one-sentence bottom line, not a full closing paragraph.",
];

const SYSTEM_PROMPT =
  "You rewrite existing 'Is X Legit?' store-legitimacy articles for a consumer review site so they " +
  "read naturally instead of following a rigid template. You will be given the current article's HTML body " +
  "plus a REQUIRED SHAPE for this specific rewrite — follow that shape's instructions exactly, including its " +
  "exact heading count and formatting constraints, even if that departs a lot from the original's layout. " +
  "Preserve every factual claim, rating, statistic, platform name, and specific detail from the original " +
  "exactly — never invent, change, or drop a number or fact. But the structure, heading wording, opening " +
  "sentence, and paragraph order are yours to change freely per the shape. " +
  "Never open an article with '<Business> is a ...' or '<Business>, a ...,' — that generic company-description " +
  "opener is overused; start somewhere else (a claim, a number, a question, a scene). Never reuse the exact " +
  "phrases 'Quick verdict', 'Before you order', 'Bottom line', 'here's a closer look', or 'here's what you " +
  "should know' — these have been used too many times already. Write like a real person explaining what they " +
  "found, not a form being filled in. Output clean HTML using <h2> section headings and <p>/<ul> as needed " +
  "per the shape (no <h1>, no markdown), roughly the same total length as the original. If useful, end with a " +
  "brief note that ratings reflect publicly available data at the time of writing. " +
  'Respond as JSON: {"excerpt": "1-2 sentence natural description, not starting with \'We checked\' or ' +
  '\'<Business> is a\'", "html": "<h2>...</h2><p>...</p>..."}.';

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function parsePost(raw) {
  const closeIdx = raw.indexOf("\n---", 3);
  const fmBlock = raw.slice(0, closeIdx);
  const body = raw.slice(closeIdx + 4); // skip "\n---"
  const lines = fmBlock.split("\n").slice(1); // drop leading "---"
  const fm = {};
  for (const line of lines) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) fm[m[1]] = m[2];
  }
  return { fm, body };
}

function yamlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ").trim()}"`;
}

async function rewriteOne(slug, body, shape) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0.9,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `REQUIRED SHAPE for this rewrite: ${shape}\n\nCurrent article HTML for "${slug}":\n\n${body}`,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const parsed = JSON.parse(data.choices[0].message.content);
  if (!parsed.html || !parsed.excerpt) throw new Error("Missing html/excerpt in response");
  return parsed;
}

async function processFile(filename, shape) {
  const filePath = path.join(POSTS_DIR, filename);
  const raw = await readFile(filePath, "utf8");
  const { fm, body } = parsePost(raw);
  const { excerpt, html } = await rewriteOne(fm.slug || filename, body, shape);

  const frontMatter = [
    "---",
    `title: ${fm.title}`,
    `slug: ${fm.slug}`,
    `date: ${fm.date}`,
    `modified: ${fm.modified}`,
    `categories: ${fm.categories}`,
    `excerpt: ${yamlString(excerpt)}`,
    fm.image ? `image: ${fm.image}` : null,
    "---",
  ]
    .filter(Boolean)
    .join("\n");

  await writeFile(filePath, frontMatter + html + "\n");
}

async function main() {
  const only = process.argv.slice(2);
  let all = (await readdir(POSTS_DIR)).filter((f) => f.endsWith(".html") && !EXCLUDE.has(f));
  if (only.length) all = all.filter((f) => only.includes(f));
  console.log(`Rewriting ${all.length} posts...`);

  const order = shuffled(all);
  const shapeFor = new Map(order.map((f, i) => [f, SHAPES[i % SHAPES.length]]));

  const CONCURRENCY = 5;
  let done = 0;
  const failures = [];
  const queue = [...all];

  async function worker() {
    while (queue.length) {
      const filename = queue.shift();
      try {
        await processFile(filename, shapeFor.get(filename));
        done++;
        console.log(`[${done}/${all.length}] OK ${filename}`);
      } catch (err) {
        failures.push(filename);
        console.error(`[${done}/${all.length}] FAIL ${filename}: ${err.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`\nDone. ${all.length - failures.length}/${all.length} succeeded.`);
  if (failures.length) {
    console.log("Failed:", failures.join(", "));
  }
}

main();
