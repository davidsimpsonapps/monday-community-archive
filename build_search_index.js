#!/usr/bin/env node
/**
 * build_search_index.js
 *
 * Reads all dist/api/topics/*.json and builds two files:
 *   dist/api/search-index.json   — serialised Lunr index
 *   dist/api/search-docs.json    — lightweight doc store for rendering results
 *
 * Usage (from the folder containing dist/):
 *   npm install lunr
 *   node build_search_index.js
 *
 * Takes ~10-30s for 24k topics.
 */

const fs   = require("fs");
const path = require("path");
const lunr = require("lunr");

const TOPICS_DIR  = path.join("dist", "api", "topics");
const INDEX_OUT   = path.join("dist", "api", "search-index.json");
const DOCS_OUT    = path.join("dist", "api", "search-docs.json");

// Strip HTML tags and decode common entities for clean text indexing
function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&hellip;/g, "…")
    .replace(/\s+/g, " ")
    .trim();
}

// Extract plain text from the first post body (the question itself)
function firstPostText(topic) {
  const first = topic.posts?.[0];
  if (!first) return "";
  return stripHtml(first.cookedHtml).slice(0, 500); // cap at 500 chars
}

console.log(`Reading topics from ${TOPICS_DIR}…`);
const files = fs.readdirSync(TOPICS_DIR).filter(f => f.endsWith(".json"));
console.log(`Found ${files.length} topic files`);

const docs = [];
const docStore = {};

for (let i = 0; i < files.length; i++) {
  if (i % 2000 === 0) console.log(`  loading ${i}/${files.length}…`);

  const raw = fs.readFileSync(path.join(TOPICS_DIR, files[i]), "utf8");
  let topic;
  try {
    topic = JSON.parse(raw);
  } catch {
    continue;
  }

  const id      = String(topic.id);
  const title   = topic.title || "";
  const excerpt = stripHtml(topic.excerpt || "");
  const body    = firstPostText(topic);
  // Collect all unique authors across every post in the topic
  const author  = [...new Set(
    (topic.posts || []).map(p => p.author || "").filter(Boolean)
  )].join(" ");

  docs.push({ id, title, excerpt, body, author });

  // Lightweight store for rendering search results — no post bodies
  docStore[id] = {
    id:          topic.id,
    title,
    excerpt:     excerpt.slice(0, 100),   // trimmed from 180 to save space
    categoryId:  topic.categoryId,
    postsCount:  topic.postsCount,
    likeCount:   topic.likeCount || 0,
    solvedPostId: topic.solvedPostId || null,
    lastPostedAt: topic.lastPostedAt || null,
    slug:        topic.slug || null,
    author:      topic.posts?.[0]?.author || "",
  };
}

console.log(`Building Lunr index over ${docs.length} documents…`);
const start = Date.now();

const idx = lunr(function () {
  this.ref("id");
  this.field("title",   { boost: 10 }); // title matches ranked much higher
  this.field("excerpt", { boost: 3  });
  this.field("body",    { boost: 1  });
  this.field("author",  { boost: 5  }); // author search ranks above body, below title

  // Disable stemming pipeline for more predictable results
  // (comment these out if you want stemming)
  // this.pipeline.remove(lunr.stemmer);
  // this.searchPipeline.remove(lunr.stemmer);

  docs.forEach(d => this.add(d));
});

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`Index built in ${elapsed}s`);

// Serialise
const serialised = JSON.stringify(idx);
const docsJson   = JSON.stringify(docStore);

fs.writeFileSync(INDEX_OUT, serialised);
fs.writeFileSync(DOCS_OUT,  docsJson);

const idxKb  = (Buffer.byteLength(serialised)  / 1024).toFixed(0);
const docsKb = (Buffer.byteLength(docsJson)     / 1024).toFixed(0);
console.log(`Wrote ${INDEX_OUT}  (${idxKb} KB)`);
console.log(`Wrote ${DOCS_OUT}   (${docsKb} KB)`);
console.log("Done.");
