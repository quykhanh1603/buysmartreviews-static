import { readFileSync } from "node:fs";
import path from "node:path";

const categories = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "src/_data/allCategories.json"), "utf8")
);
const categoryNameBySlug = new Map(categories.map((c) => [c.slug, c.name]));
const categoryPathBySlug = new Map(categories.map((c) => [c.slug, c.path]));

export default function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy("src/assets");
  eleventyConfig.addPassthroughCopy({ "src/robots.txt": "robots.txt" });
  eleventyConfig.addPassthroughCopy({ "src/CNAME": "CNAME" });

  eleventyConfig.setLibrary("md", null);
  eleventyConfig.setTemplateFormats(["html", "njk"]);

  eleventyConfig.addFilter("readableDate", (isoDate) => {
    const d = new Date(isoDate);
    return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  });

  eleventyConfig.addFilter("isoDate", (isoDate) => new Date(isoDate).toISOString());

  eleventyConfig.addGlobalData("currentYear", () => new Date().getFullYear());

  eleventyConfig.addFilter("categoryName", (slug) => categoryNameBySlug.get(slug) ?? slug);
  eleventyConfig.addFilter("categoryPath", (slug) => categoryPathBySlug.get(slug) ?? slug);

  eleventyConfig.addFilter("limit", (arr, n) => arr.slice(0, n));

  eleventyConfig.addFilter("filterRelated", (posts, categories, currentSlug, limit = 3) =>
    posts
      .filter((p) => p.data.slug !== currentSlug && p.data.categories.some((c) => categories.includes(c)))
      .slice(0, limit)
  );

  eleventyConfig.addCollection("posts", (api) =>
    api.getFilteredByGlob("src/posts/*.html").sort((a, b) => b.date - a.date)
  );

  eleventyConfig.addCollection("pages", (api) => api.getFilteredByGlob("src/pages/*.html"));

  return {
    htmlTemplateEngine: "njk",
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes",
      data: "_data",
    },
  };
}
