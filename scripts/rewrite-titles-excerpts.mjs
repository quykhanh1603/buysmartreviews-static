// Follow-up to rewrite-old-content.mjs: the article bodies now vary in
// structure, but 140/142 titles still literally read "Is X Legit? An Honest
// Review" and excerpts leaned on the same handful of cliches ("mixed bag",
// "raises questions", "should exercise caution"). This pass only rewrites
// title + excerpt, keeping the already-diversified body untouched. Slug is
// never touched (URLs stay stable).
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

const TITLE_SHAPES = [
  "Phrase the title as a direct yes/no legitimacy question naming the business (style: 'Is <Business> Legit?') — but do NOT append 'An Honest Review' or any subtitle after it.",
  "Phrase the title as a statement about what customers/reviews say about the business, naming it. Do not use the word 'Legit'.",
  "Phrase the title as a question about whether the business can be trusted, naming it. Do not use the word 'Legit'.",
  "Phrase the title using a blunt 'Legit or not' style framing, naming the business.",
  "Phrase the title as a should-you-buy/shop-here verdict framing, naming the business. Do not use the word 'Legit'.",
];

const SYSTEM_PROMPT =
  "You write a new title and excerpt for an existing store-legitimacy review article, given its current " +
  "title and full body. Keep the exact business name from the current title. Follow the REQUIRED TITLE STYLE " +
  "given to you exactly for the title's framing, but write your own natural wording within it — don't reuse " +
  "generic boilerplate. Never use the literal phrase 'An Honest Review'. The excerpt is a 1-2 sentence teaser " +
  "shown on listing pages: base it on the article's actual content/verdict, and never use these overused " +
  "phrases: 'mixed bag', 'raises questions', 'should exercise caution', 'potential and pitfalls', 'here's a " +
  "closer look', 'here's what you should know', 'here's what to know', 'worth noting', 'thinking about " +
  "ordering'. Don't start the excerpt with the business name followed by 'is a' or 'offers' or 'presents'. " +
  'Respond as JSON: {"title": "...", "excerpt": "..."}.';

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
  const body = raw.slice(closeIdx + 4);
  const lines = fmBlock.split("\n").slice(1);
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

function unquote(value) {
  const m = value.match(/^"(.*)"$/);
  return m ? m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\") : value;
}

async function rewriteTitleExcerpt(currentTitle, body, titleShape) {
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
          content: `REQUIRED TITLE STYLE: ${titleShape}\n\nCurrent title: ${currentTitle}\n\nArticle body:\n\n${body}`,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const parsed = JSON.parse(data.choices[0].message.content);
  if (!parsed.title || !parsed.excerpt) throw new Error("Missing title/excerpt in response");
  return parsed;
}

async function processFile(filename, titleShape) {
  const filePath = path.join(POSTS_DIR, filename);
  const raw = await readFile(filePath, "utf8");
  const { fm, body } = parsePost(raw);
  const currentTitle = unquote(fm.title || "");
  const { title, excerpt } = await rewriteTitleExcerpt(currentTitle, body, titleShape);

  const frontMatter = [
    "---",
    `title: ${yamlString(title)}`,
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

  await writeFile(filePath, frontMatter + body + "\n");
}

async function main() {
  const only = process.argv.slice(2);
  let all = (await readdir(POSTS_DIR)).filter((f) => f.endsWith(".html") && !EXCLUDE.has(f));
  if (only.length) all = all.filter((f) => only.includes(f));
  console.log(`Rewriting titles/excerpts for ${all.length} posts...`);

  const order = shuffled(all);
  const shapeFor = new Map(order.map((f, i) => [f, TITLE_SHAPES[i % TITLE_SHAPES.length]]));

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
