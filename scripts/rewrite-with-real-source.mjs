// Re-writes the 142 WP-migrated "is X legit" posts using the same
// scrape-real-source-then-write pipeline now used by the live bot
// (bot-worker/src/index.ts): read the business's own homepage (OG tags,
// JSON-LD, page text) + best-effort Trustpilot, then have GPT rewrite the
// article grounded in that real material, with a real product/store image
// and FAQ. Adds an affiliate CTA button to the body (site-wide affiliate
// disclosure now covers every post, not just the "store-reviews" category).
//
// Safety: every guessed domain is verified by checking the scraped page
// actually mentions the expected business name before writing anything —
// a wrong guess is skipped and reported, never published.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const SRC = path.resolve(import.meta.dirname, "..", "src");
const POSTS_DIR = path.join(SRC, "posts");
const UPLOADS_DIR = path.join(SRC, "assets", "uploads", "store-reviews");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY env var");
  process.exit(1);
}

// slug -> { domain, nameCheck: [words that must appear in scraped text/title] }
const DOMAIN_MAP = {
  "is-1-800-petmeds-legit-an-honest-review": "1800petmeds.com",
  "is-abercrombie-fitch-legit-an-honest-review": "abercrombie.com",
  "is-abt-electronics-legit-an-honest-review": "abt.com",
  "is-adorama-legit-an-honest-review": "adorama.com",
  "is-aj-madison-legit-an-honest-review": "ajmadison.com",
  "is-allbirds-legit-an-honest-review": "allbirds.com",
  "is-american-eagle-legit-an-honest-review": "ae.com",
  "is-angara-legit-an-honest-review": "angara.com",
  "is-anthropologie-legit-an-honest-review": "anthropologie.com",
  "is-article-furniture-legit-an-honest-review": "article.com",
  "is-ashley-furniture-legit-an-honest-review": "ashleyfurniture.com",
  "is-asos-legit-an-honest-review": "asos.com",
  "is-autonation-legit-an-honest-review": "autonation.com",
  "is-avocado-green-mattress-legit-an-honest-review": "avocadogreenmattress.com",
  "is-banana-republic-legit-an-honest-review": "bananarepublic.gap.com",
  "is-barkbox-legit-an-honest-review": "barkbox.com",
  "is-best-buy-legit-an-honest-review": "bestbuy.com",
  "is-bh-photo-video-legit-an-honest-review": "bhphotovideo.com",
  "is-bikesdirect-legit-an-honest-review": "bikesdirect.com",
  "is-blue-nile-legit-an-honest-review": "bluenile.com",
  "is-boden-legit-an-honest-review": "bodenusa.com",
  "is-bonobos-legit-an-honest-review": "bonobos.com",
  "is-brecks-bulbs-legit-an-honest-review": "brecks.com",
  "is-brilliant-earth-legit-an-honest-review": "brilliantearth.com",
  "is-brooklinen-legit-a-trust-review": "brooklinen.com",
  "is-brooks-brothers-legit-an-honest-review": "brooksbrothers.com",
  "is-burpee-legit-an-honest-review": "burpee.com",
  "is-cannondale-legit-an-honest-review": "cannondale.com",
  "is-carmax-legit-an-honest-review": "carmax.com",
  "is-carvana-legit-an-honest-review": "carvana.com",
  "is-casper-legit-an-honest-review": "casper.com",
  "is-charlotte-tilbury-legit-an-honest-review": "charlottetilbury.com",
  "is-chewy-legit-an-honest-review": "chewy.com",
  "is-chicos-legit-an-honest-review": "chicos.com",
  "is-chubbies-legit-an-honest-review": "chubbiesshorts.com",
  "is-conns-homeplus-legit-an-honest-review": "conns.com",
  "is-crutchfield-legit-an-honest-review": "crutchfield.com",
  "is-dell-legit-an-honest-review": "dell.com",
  "is-diamondback-legit-an-honest-review": "diamondback.com",
  "is-drivetime-legit-an-honest-review": "drivetime.com",
  "is-dsw-legit-an-honest-review": "dsw.com",
  "is-e-l-f-cosmetics-legit-an-honest-review": "elfcosmetics.com",
  "is-echopark-automotive-legit-an-honest-review": "echopark.com",
  "is-enterprise-car-sales-legit-an-honest-review": "enterprisecarsales.com",
  "is-express-legit-an-honest-review": "express.com",
  "is-famous-footwear-legit-an-honest-review": "famousfootwear.com",
  "is-fast-growing-trees-legit-an-honest-review": "fast-growing-trees.com",
  "is-fenty-beauty-legit-an-honest-review": "fentybeauty.com",
  "is-foot-locker-legit-an-honest-review": "footlocker.com",
  "is-forever-21-legit-an-honest-review": "forever21.com",
  "is-free-people-legit-an-honest-review": "freepeople.com",
  "is-frigidaire-legit-an-honest-review": "frigidaire.com",
  "is-furniturecart-legit-an-honest-review": "furniturecart.com",
  "is-gap-legit-an-honest-review": "gap.com",
  "is-gardeners-supply-company-legit-an-honest-review": "gardeners.com",
  "is-ge-appliances-legit-an-honest-review": "geappliances.com",
  "is-giant-bicycles-legit-an-honest-review": "giant-bicycles.com",
  "is-glossier-legit-an-honest-review": "glossier.com",
  "is-gullwing-motor-cars-legit-an-honest-review": "gullwingmotorcars.com",
  "is-helix-sleep-legit-an-honest-review": "helixsleep.com",
  "is-helzberg-diamonds-legit-an-honest-review": "helzberg.com",
  "is-hertz-car-sales-legit-an-honest-review": "hertzcarsales.com",
  "is-home-depot-legit-an-honest-review": "homedepot.com",
  "is-hp-legit-an-honest-review": "hp.com",
  "is-j-crew-legit-an-honest-review": "jcrew.com",
  "is-j-jill-legit-an-honest-review": "jjill.com",
  "is-james-allen-legit-an-honest-review": "jamesallen.com",
  "is-jared-legit-an-honest-review": "jared.com",
  "is-journeys-legit-an-honest-review": "journeys.com",
  "is-kay-jewelers-legit-an-honest-review": "kay.com",
  "is-kylie-cosmetics-legit-an-honest-review": "kyliecosmetics.com",
  "is-la-z-boy-legit-an-honest-review": "la-z-boy.com",
  "is-lowes-legit-an-honest-review": "lowes.com",
  "is-lululemon-legit-an-honest-review": "lululemon.com",
  "is-mac-cosmetics-legit-an-honest-review": "maccosmetics.com",
  "is-madewell-legit-an-honest-review": "madewell.com",
  "is-mejuri-legit-an-honest-review": "mejuri.com",
  "is-mens-wearhouse-legit-an-honest-review": "menswearhouse.com",
  "is-micro-center-legit-an-honest-review": "microcenter.com",
  "is-monoprice-legit-an-honest-review": "monoprice.com",
  "is-morphe-legit-an-honest-review": "morphe.com",
  "is-nature-hills-nursery-legit-an-honest-review": "naturehills.com",
  "is-nectar-sleep-legit-an-honest-review": "nectarsleep.com",
  "is-new-balance-legit-an-honest-review": "newbalance.com",
  "is-newegg-legit-an-honest-review": "newegg.com",
  "is-nike-legit-an-honest-review": "nike.com",
  "is-nom-nom-legit-an-honest-review": "nomnomnow.com",
  "is-nordstrom-legit-an-honest-review": "nordstrom.com",
  "is-old-navy-legit-an-honest-review": "oldnavy.gap.com",
  "is-ollie-legit-an-honest-review": "myollie.com",
  "is-p-c-richard-son-legit-an-honest-review": "pcrichard.com",
  "is-pandora-jewelry-legit-an-honest-review": "pandora.net",
  "is-petco-legit-an-honest-review": "petco.com",
  "is-petflow-legit-an-honest-review": "petflow.com",
  "is-petsmart-legit-an-honest-review": "petsmart.com",
  "is-pottery-barn-legit-an-honest-review": "potterybarn.com",
  "is-priority-bicycles-legit-an-honest-review": "prioritybicycles.com",
  "is-purple-mattress-legit-an-honest-review": "purple.com",
  "is-quince-legit-an-honest-review": "quince.com",
  "is-rad-power-bikes-legit-an-honest-review": "radpowerbikes.com",
  "is-raymour-flanigan-legit-an-honest-review": "raymourflanigan.com",
  "is-reformation-legit-an-honest-review": "thereformation.com",
  "is-rei-legit-an-honest-review": "rei.com",
  "is-rooms-to-go-legit-an-honest-review": "roomstogo.com",
  "is-rothys-legit": "rothys.com",
  "is-saatva-legit-an-honest-review": "saatva.com",
  "is-sally-beauty-legit-an-honest-review": "sallybeauty.com",
  "is-scotts-miracle-gro-legit-an-honest-review": "scotts.com",
  "is-sears-legit-an-honest-review": "sears.com",
  "is-sephora-legit-an-honest-review": "sephora.com",
  "is-serta-legit-an-honest-review": "serta.com",
  "is-shein-legit-an-honest-review": "shein.com",
  "is-skechers-legit-an-honest-review": "skechers.com",
  "is-sleep-number-legit-an-honest-review": "sleepnumber.com",
  "is-specialized-legit-an-honest-review": "specialized.com",
  "is-spot-tango-legit-an-honest-review": "spotandtango.com",
  "is-spring-hill-nurseries-legit-an-honest-review": "springhillnursery.com",
  "is-state-bicycle-co-legit-an-honest-review": "statebicycle.com",
  "is-suitsupply-legit-an-honest-review": "suitsupply.com",
  "is-sunday-lawn-care-legit-an-honest-review": "getsunday.com",
  "is-sweetwater-legit-an-honest-review": "sweetwater.com",
  "is-tempur-pedic-legit-an-honest-review": "tempurpedic.com",
  "is-the-farmers-dog-legit-an-honest-review": "thefarmersdog.com",
  "is-todd-snyder-legit-an-honest-review": "toddsnyder.com",
  "is-torrid-legit-an-honest-review": "torrid.com",
  "is-tractor-supply-co-legit-an-honest-review": "tractorsupply.com",
  "is-trek-legit-an-honest-review": "trekbikes.com",
  "is-trex-decking-legit-an-honest-review": "trex.com",
  "is-truecar-legit-an-honest-review": "truecar.com",
  "is-tuft-needle-legit-an-honest-review": "tuftandneedle.com",
  "is-ulta-beauty-legit-an-honest-review": "ulta.com",
  "is-uniqlo-legit-an-honest-review": "uniqlo.com",
  "is-untuckit-legit-an-honest-review": "untuckit.com",
  "is-value-city-furniture-legit-an-honest-review": "valuecityfurniture.com",
  "is-vans-legit-an-honest-review": "vans.com",
  "is-vineyard-vines-legit-an-honest-review": "vineyardvines.com",
  "is-vroom-legit-an-honest-review": "vroom.com",
  "is-wayfair-legit-an-honest-review": "wayfair.com",
  "is-west-elm-legit-an-honest-review": "westelm.com",
  "is-whirlpool-legit-an-honest-review": "whirlpool.com",
  "is-zales-legit-an-honest-review": "zales.com",
  "is-zappos-legit-an-honest-review": "zappos.com",
};

function fetchAsText(url) {
  return fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(15000),
  }).then((res) => {
    if (!res.ok) throw new Error(`Fetch failed (${res.status}): ${url}`);
    return res.text();
  });
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
}

function metaContent(html, attr, key) {
  const re = new RegExp(`<meta[^>]+${attr}=["']${key}["'][^>]+content=["']([^"']*)["']`, "i");
  const altRe = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+${attr}=["']${key}["']`, "i");
  const m = html.match(re) || html.match(altRe);
  return m ? decodeHtmlEntities(m[1]).trim() : null;
}

function extractJsonLd(html) {
  const blocks = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const arr = Array.isArray(parsed) ? parsed : parsed["@graph"] ? parsed["@graph"] : [parsed];
      blocks.push(...arr);
    } catch {}
  }
  return blocks;
}

function findProductNodes(nodes) {
  return nodes.filter((n) => {
    const type = n?.["@type"];
    if (!type) return false;
    return Array.isArray(type) ? type.includes("Product") : type === "Product";
  });
}

function summarizeProductFacts(product) {
  const lines = [];
  if (product.name) lines.push(`Name: ${product.name}`);
  if (product.description) lines.push(`Description: ${String(product.description).slice(0, 500)}`);
  const brand = typeof product.brand === "string" ? product.brand : product.brand?.name;
  if (brand) lines.push(`Brand: ${brand}`);
  const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;
  if (offer?.price) lines.push(`Price: ${offer.price} ${offer.priceCurrency ?? ""}`.trim());
  if (product.aggregateRating?.ratingValue) {
    const rv = product.aggregateRating.ratingValue;
    const rc = product.aggregateRating.reviewCount ?? product.aggregateRating.ratingCount;
    lines.push(`Rating (from site's own structured data): ${rv}/5${rc ? ` from ${rc} reviews` : ""}`);
  }
  return lines.join("\n");
}

function productImages(product) {
  const img = product.image;
  if (!img) return [];
  if (typeof img === "string") return [img];
  if (Array.isArray(img)) return img.filter((x) => typeof x === "string");
  if (typeof img === "object" && img.url) return [img.url];
  return [];
}

async function scrapeSource(url) {
  const html = await fetchAsText(url);
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const ogTitle = metaContent(html, "property", "og:title");
  const ogDescription = metaContent(html, "property", "og:description") || metaContent(html, "name", "description");
  const ogImage = metaContent(html, "property", "og:image");

  const jsonLdNodes = extractJsonLd(html);
  const products = findProductNodes(jsonLdNodes);

  const images = [];
  for (const p of products) images.push(...productImages(p));
  if (ogImage) images.push(ogImage);
  const absoluteImages = images
    .map((src) => {
      try {
        return new URL(src, url).href;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const dedupedImages = [...new Set(absoluteImages)].slice(0, 5);

  const productFacts = products.length ? products.map(summarizeProductFacts).filter(Boolean).join("\n---\n") : null;
  const text = htmlToText(html).slice(0, 6000);

  return {
    title: ogTitle || (titleMatch ? htmlToText(titleMatch[1]) : new URL(url).hostname),
    metaDescription: ogDescription || "",
    text,
    fullTextForCheck: (ogTitle || "") + " " + (titleMatch ? titleMatch[1] : "") + " " + text.slice(0, 2000),
    images: dedupedImages,
    productFacts,
  };
}

async function scrapeTrustpilot(domain) {
  try {
    const html = await fetchAsText(`https://www.trustpilot.com/review/${domain}`);
    const text = htmlToText(html).slice(0, 3000);
    return text.length > 200 ? text : null;
  } catch {
    return null;
  }
}

const TITLE_STYLES = [
  "a direct 'Is <Business> Legit?' question, no subtitle after it",
  "a benefit/practical framing naming the business, e.g. what shoppers get from it — don't use the word 'Legit'",
  "a 'Business Review: what to know before you buy' framing",
  "a blunt 'Legit or not' framing naming the business",
];

async function writeArticle(domain, scraped, trustpilot) {
  const titleStyle = TITLE_STYLES[Math.floor(Math.random() * TITLE_STYLES.length)];

  const systemPrompt =
    "You write store/product review articles for an affiliate review site (Buy Smart Reviews). The site " +
    "earns affiliate commission when readers click through to the business being written about, so the goal " +
    "is a genuinely useful, practical article that helps a shopper decide — grounded in the business's own " +
    "product/store information, not a generic template. " +
    "You are given the TARGET SITE'S OWN homepage content and structured data (their own SEO copy, meta " +
    "description) plus best-effort trust signals (Trustpilot). Base the article primarily on the target " +
    "site's own material: rewrite it in your own original wording for our site — never copy sentences " +
    "verbatim — covering what they actually sell/offer, standout features or selling points, pricing/value " +
    "signals, and any shipping/returns/policy details mentioned. Weave in genuine trust signals (ratings, " +
    "review counts, recurring praise or complaints) wherever the context supports them. " +
    "Never invent facts, numbers, ratings, or quotes not present in the given context — if something is thin " +
    "or unclear, say so plainly rather than filling in generic filler. " +
    "Write 700-900 words as clean HTML using <h2> section headings and <p>/<ul> as needed (no <h1>, no " +
    "markdown). Vary heading wording, order, and count (3-6) based on what's actually notable about THIS " +
    "business — don't force the same checklist onto every review. Write like a real person who did the " +
    `research, not a form being filled in. Phrase the title as ${titleStyle}. ` +
    "Also produce a 1-2 sentence excerpt (for listing pages and meta description, under 160 characters, not " +
    "starting with 'We checked' or '<Business> is a') and 2-3 FAQ question/answer pairs a shopper would " +
    "realistically search for (shipping, returns, financing, trial/warranty periods, pricing, legitimacy — " +
    "whichever the context actually supports). If the scraped context mentions a policy or fact like a trial " +
    "period, warranty, financing option, or return window, that's a good FAQ candidate — use it. Only return " +
    "an empty faq array if the context truly has nothing concrete to answer. " +
    'Respond as JSON: {"title": "...", "excerpt": "...", "html": "<h2>...</h2><p>...</p>...", ' +
    '"faq": [{"q": "...", "a": "..."}]}.';

  const userPrompt = [
    `Business/site: ${domain}`,
    `Target site's own title/meta: ${scraped.title} — ${scraped.metaDescription || "(no meta description found)"}`,
    scraped.productFacts
      ? `Structured product/store data found on the target site (first-party, high-confidence):\n${scraped.productFacts}`
      : "No structured product data (JSON-LD) found on the target site.",
    `Target site page text:\n${scraped.text}`,
    trustpilot ? `Trustpilot page text:\n${trustpilot}` : "Trustpilot data: not available.",
  ].join("\n\n");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0.8,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI request failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const parsed = JSON.parse(data.choices[0].message.content);
  if (!parsed.title || !parsed.html || !parsed.excerpt) throw new Error("OpenAI response missing fields");
  return { title: parsed.title, excerpt: parsed.excerpt, html: parsed.html, faq: parsed.faq ?? [] };
}

function extFromContentType(contentType, fallbackUrl) {
  const map = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
  if (contentType) {
    const clean = contentType.split(";")[0].trim().toLowerCase();
    if (map[clean]) return map[clean];
  }
  const m = fallbackUrl.match(/\.(jpe?g|png|webp|gif)(?:\?|$)/i);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg") : "jpg";
}

async function downloadImage(slug, imageUrl) {
  try {
    const res = await fetch(imageUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BuySmartReviewsBot/1.0)" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`fetch failed (${res.status})`);
    const contentType = res.headers.get("content-type");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 200 || buf.length > 5_000_000) throw new Error(`unusable size (${buf.length}b)`);
    const ext = extFromContentType(contentType, imageUrl);
    await mkdir(UPLOADS_DIR, { recursive: true });
    await writeFile(path.join(UPLOADS_DIR, `${slug}.${ext}`), buf);
    return `/assets/uploads/store-reviews/${slug}.${ext}`;
  } catch (err) {
    console.log(`  [image] skipped (${imageUrl}): ${err.message}`);
    return null;
  }
}

function yamlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ").trim()}"`;
}

function parseFrontMatter(raw) {
  const closeIdx = raw.indexOf("\n---", 3);
  const fmBlock = raw.slice(0, closeIdx);
  const lines = fmBlock.split("\n").slice(1);
  const fm = {};
  for (const line of lines) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) fm[m[1]] = m[2];
  }
  return fm;
}

function nameCheckWords(slug) {
  return slug
    .replace(/^is-/, "")
    .replace(/-legit-an-honest-review$|-legit-a-trust-review$|-legit$/, "")
    .split("-")
    .filter((w) => w.length > 2 && !/^\d+$/.test(w));
}

async function processFile(filename) {
  const slug = filename.replace(/\.html$/, "");
  const domain = DOMAIN_MAP[slug];
  if (!domain) return { slug, status: "no-domain" };

  const filePath = path.join(POSTS_DIR, filename);
  const raw = await readFile(filePath, "utf8");
  const fm = parseFrontMatter(raw);
  const targetUrl = `https://www.${domain}/`;

  let scraped;
  try {
    scraped = await scrapeSource(targetUrl);
  } catch (err) {
    return { slug, status: "scrape-failed", detail: err.message };
  }

  const words = nameCheckWords(slug);
  const haystack = scraped.fullTextForCheck.toLowerCase();
  const matched = words.some((w) => haystack.includes(w.replace(/^\d+$/, "")));
  if (!matched) {
    return { slug, status: "name-mismatch", detail: `expected words [${words.join(", ")}] not found on ${domain}` };
  }

  const trustpilot = await scrapeTrustpilot(domain);

  let article;
  try {
    article = await writeArticle(domain, scraped, trustpilot);
  } catch (err) {
    return { slug, status: "write-failed", detail: err.message };
  }

  const imagePath = scraped.images[0] ? await downloadImage(slug, scraped.images[0]) : null;
  const now = new Date().toISOString();
  const ctaButton = `<p><a class="btn btn-primary" href="${targetUrl}" target="_blank" rel="sponsored noopener">Visit site</a></p>`;

  const frontMatter = [
    "---",
    `title: ${yamlString(article.title)}`,
    `slug: ${fm.slug || slug}`,
    `date: ${fm.date}`,
    `modified: ${now}`,
    `categories: ${fm.categories}`,
    `excerpt: ${yamlString(article.excerpt)}`,
    imagePath ? `image: "${imagePath}"` : null,
    article.faq.length ? `faq: ${JSON.stringify(article.faq)}` : null,
    "---",
  ]
    .filter(Boolean)
    .join("\n");

  const body = `${ctaButton}\n${article.html}\n${ctaButton}\n`;
  await writeFile(filePath, frontMatter + body);
  return { slug, status: "ok", domain };
}

async function main() {
  const only = process.argv.slice(2);
  let files = Object.keys(DOMAIN_MAP).map((s) => `${s}.html`);
  if (only.length) files = files.filter((f) => only.includes(f));
  console.log(`Processing ${files.length} posts...`);

  const CONCURRENCY = 5;
  let done = 0;
  const results = [];
  const queue = [...files];

  async function worker() {
    while (queue.length) {
      const filename = queue.shift();
      const r = await processFile(filename).catch((err) => ({ slug: filename, status: "error", detail: err.message }));
      results.push(r);
      done++;
      console.log(`[${done}/${files.length}] ${r.status.toUpperCase()} ${r.slug}${r.detail ? " — " + r.detail : ""}`);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const byStatus = {};
  for (const r of results) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  console.log("\n=== SUMMARY ===");
  console.log(byStatus);
  const failed = results.filter((r) => r.status !== "ok");
  if (failed.length) {
    console.log("\nNeed follow-up:");
    for (const f of failed) console.log(`  ${f.slug}: ${f.status}${f.detail ? " — " + f.detail : ""}`);
  }
}

main();
