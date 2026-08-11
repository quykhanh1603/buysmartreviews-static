// One-off, re-runnable migration: pulls posts/pages/categories/media from the
// live WordPress REST API and writes Eleventy-ready content files.
// Usage: node scripts/migrate-from-wp.mjs

import { load } from "cheerio";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const WP_BASE = "https://buysmartreviews.store";
const SITE_ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(SITE_ROOT, "src");

const EXCLUDED_PAGE_SLUGS = new Set(["sample-page"]);
const EXCLUDED_POST_SLUGS = new Set(["hello-world"]);
// Known WP-side redirects (verified via curl against the live site) that must
// be preserved since GitHub Pages won't apply WP's server-side 301s.
const KNOWN_REDIRECTS = { "/contact/": "/contact-us/" };

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed ${res.status}: ${url}`);
  return res.json();
}

async function fetchAllPaged(endpoint) {
  const items = [];
  for (let page = 1; ; page++) {
    const url = `${WP_BASE}/wp-json/wp/v2/${endpoint}?per_page=100&page=${page}&_embed`;
    const res = await fetch(url);
    if (res.status === 400) break; // WP returns 400 past the last page
    if (!res.ok) throw new Error(`Fetch failed ${res.status}: ${url}`);
    const batch = await res.json();
    if (!batch.length) break;
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(str) {
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name] ?? m);
}

function yamlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ").trim()}"`;
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

async function downloadImage(url, imageMap) {
  if (imageMap.has(url)) return imageMap.get(url);
  try {
    const u = new URL(url);
    const marker = "/wp-content/uploads/";
    const idx = u.pathname.indexOf(marker);
    const relPath = idx >= 0 ? u.pathname.slice(idx + marker.length) : path.basename(u.pathname);
    const localRel = `/assets/uploads/${relPath}`;
    const localAbs = path.join(SRC, "assets", "uploads", relPath);
    if (!existsSync(localAbs)) {
      const res = await fetch(url);
      if (res.ok) {
        await mkdir(path.dirname(localAbs), { recursive: true });
        await writeFile(localAbs, Buffer.from(await res.arrayBuffer()));
      } else {
        console.warn(`  ! image fetch failed (${res.status}): ${url}`);
        imageMap.set(url, url); // leave original URL as fallback
        return url;
      }
    }
    imageMap.set(url, localRel);
    return localRel;
  } catch (err) {
    console.warn(`  ! image error: ${url} (${err.message})`);
    imageMap.set(url, url);
    return url;
  }
}

async function rewriteContent(html, imageMap) {
  const $ = load(html, { xmlMode: false });
  const imgs = $("img").toArray();
  for (const el of imgs) {
    const $el = $(el);
    const src = $el.attr("src");
    if (src && src.includes("/wp-content/uploads/")) {
      const local = await downloadImage(src, imageMap);
      $el.attr("src", local);
    }
    $el.removeAttr("srcset");
    $el.removeAttr("sizes");
  }
  $("a[href]").each((_, el) => {
    const $el = $(el);
    let href = $el.attr("href");
    if (href && href.startsWith(WP_BASE)) {
      href = href.slice(WP_BASE.length) || "/";
    }
    if (href && KNOWN_REDIRECTS[href]) {
      href = KNOWN_REDIRECTS[href];
    }
    if (href !== $el.attr("href")) $el.attr("href", href);
  });
  return $("body").html() ?? html;
}

async function main() {
  console.log(`Migrating content from ${WP_BASE} ...`);
  const imageMap = new Map();

  // 1. Categories
  const rawCategories = await fetchJson(`${WP_BASE}/wp-json/wp/v2/categories?per_page=100`);
  const rawById = new Map(rawCategories.map((c) => [c.id, c]));
  // WP category archive URLs include ancestor slugs (e.g. /category/reviews/jewelry/),
  // so each category needs its full slug path, not just its own slug.
  function categoryPath(id) {
    const c = rawById.get(id);
    if (!c) return [];
    return c.parent ? [...categoryPath(c.parent), c.slug] : [c.slug];
  }
  const categories = rawCategories
    .filter((c) => c.count > 0)
    .map((c) => ({
      id: c.id,
      slug: c.slug,
      name: decodeEntities(c.name),
      count: c.count,
      path: categoryPath(c.id).join("/"),
    }));
  const categoryById = new Map(rawCategories.map((c) => [c.id, c.slug]));
  await mkdir(path.join(SRC, "_data"), { recursive: true });
  // Named allCategories (not "categories") so the global data variable doesn't
  // collide with each post's own `categories` front-matter field.
  await writeFile(
    path.join(SRC, "_data", "allCategories.json"),
    JSON.stringify(categories, null, 2)
  );
  console.log(`Wrote ${categories.length} categories -> src/_data/allCategories.json`);

  // 2. Posts
  const rawPosts = await fetchAllPaged("posts");
  await mkdir(path.join(SRC, "posts"), { recursive: true });
  await writeFile(
    path.join(SRC, "posts", "posts.11tydata.json"),
    JSON.stringify({ layout: "post.njk", permalink: "/{{ slug }}/", tags: ["post"] }, null, 2) + "\n"
  );

  let migratedCount = 0;
  const unresolvedCategories = [];
  for (const post of rawPosts) {
    if (EXCLUDED_POST_SLUGS.has(post.slug)) continue;
    const catSlugs = post.categories
      .map((id) => categoryById.get(id))
      .filter((slug) => {
        if (!slug) unresolvedCategories.push(post.slug);
        return Boolean(slug);
      });
    const featuredUrl = post._embedded?.["wp:featuredmedia"]?.[0]?.source_url;
    const image = featuredUrl ? await downloadImage(featuredUrl, imageMap) : "";
    const body = await rewriteContent(post.content.rendered, imageMap);
    const excerpt = decodeEntities(stripTags(post.excerpt.rendered).slice(0, 300));

    const frontMatter = [
      "---",
      `title: ${yamlString(decodeEntities(post.title.rendered))}`,
      `slug: ${post.slug}`,
      `date: ${post.date}`,
      `modified: ${post.modified}`,
      `categories: [${catSlugs.map((s) => `"${s}"`).join(", ")}]`,
      `excerpt: ${yamlString(excerpt)}`,
      image ? `image: "${image}"` : null,
      "---",
      "",
    ]
      .filter(Boolean)
      .join("\n");

    await writeFile(path.join(SRC, "posts", `${post.slug}.html`), frontMatter + body + "\n");
    migratedCount++;
  }
  console.log(`Wrote ${migratedCount} posts -> src/posts/*.html`);
  if (unresolvedCategories.length) {
    console.warn(`! Posts with unresolved categories: ${unresolvedCategories.join(", ")}`);
  }

  // 3. Pages
  const rawPages = await fetchJson(`${WP_BASE}/wp-json/wp/v2/pages?per_page=50&_embed`);
  await mkdir(path.join(SRC, "pages"), { recursive: true });
  await writeFile(
    path.join(SRC, "pages", "pages.11tydata.json"),
    JSON.stringify({ layout: "page.njk", permalink: "/{{ slug }}/", tags: ["page"] }, null, 2) + "\n"
  );

  let pageCount = 0;
  for (const p of rawPages) {
    if (EXCLUDED_PAGE_SLUGS.has(p.slug)) continue;
    const body = await rewriteContent(p.content.rendered, imageMap);
    const frontMatter = [
      "---",
      `title: ${yamlString(decodeEntities(p.title.rendered))}`,
      `slug: ${p.slug}`,
      "---",
      "",
    ].join("\n");
    await writeFile(path.join(SRC, "pages", `${p.slug}.html`), frontMatter + body + "\n");
    pageCount++;
  }
  console.log(`Wrote ${pageCount} pages -> src/pages/*.html`);
  console.log(`Downloaded/mapped ${imageMap.size} unique images -> src/assets/uploads/`);
  console.log("Done. Review the sanity warnings above (if any) before building.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
