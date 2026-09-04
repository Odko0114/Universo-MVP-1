"use strict";

// Marketing intelligence source — €0, no API keys. Pulls the last 7 days of
// news from Google News RSS (a genuinely free, public feed) for a handful of
// Universo-relevant queries, tags each headline by topic, dedupes, and caches
// for 2h so we never hammer the source. If a fetch fails, the last good cache
// is served; if there's nothing, the caller falls back to manual research
// links. Nothing here is invented — every item is a real headline with a link.

const { fetchWithResilience } = require("./http");

const QUERIES = [
  "international student scholarships",
  "study abroad Europe students",
  "student visa Europe",
  "university tuition fees international students",
  "Erasmus scholarship",
  "university application deadline",
];
const UA = "UniversoMarketingOS/1.0 (education content research; contact join.universo@gmail.com)";
const TTL_MS = 2 * 60 * 60 * 1000; // 2h
const PER_QUERY = 6;

let cache = { at: 0, items: [], errors: [] };
let refreshing = null;

function decode(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function topicOf(title) {
  const t = title.toLowerCase();
  if (/scholarship|grant|bursary|stipend|fully funded|funding/.test(t)) return "Scholarships";
  if (/visa|immigration|residence permit|work permit/.test(t)) return "Visa";
  if (/tuition|fee|cost|afford|expensive|price|financial/.test(t)) return "Cost";
  if (/deadline|application|admission|apply|entry requirement/.test(t)) return "Applications";
  if (/erasmus|exchange programme|exchange program/.test(t)) return "Erasmus";
  if (/ranking|best universit|top universit/.test(t)) return "Rankings";
  return "Study abroad";
}

function parseRss(xml) {
  const items = [];
  const parts = String(xml).split(/<item>/i).slice(1);
  for (const p of parts) {
    const grab = (re) => {
      const m = p.match(re);
      return m ? decode(m[1]) : "";
    };
    let title = grab(/<title>([\s\S]*?)<\/title>/i);
    const link = grab(/<link>([\s\S]*?)<\/link>/i);
    const date = grab(/<pubDate>([\s\S]*?)<\/pubDate>/i);
    let source = grab(/<source[^>]*>([\s\S]*?)<\/source>/i);
    // Google News titles are usually "Headline - Publisher"; split the publisher out.
    if (!source) {
      const i = title.lastIndexOf(" - ");
      if (i > 20) {
        source = title.slice(i + 3);
        title = title.slice(0, i);
      }
    }
    if (title) items.push({ title, link, date, source, topic: topicOf(title) });
  }
  return items;
}

async function refresh() {
  const all = [];
  const errors = [];
  for (const q of QUERIES) {
    const url =
      "https://news.google.com/rss/search?q=" +
      encodeURIComponent(q + " when:7d") +
      "&hl=en-US&gl=US&ceid=US:en";
    try {
      const res = await fetchWithResilience(url, {
        headers: { "User-Agent": UA },
        timeoutMs: 8000,
        retries: 1,
        label: "news-rss",
      });
      const xml = await res.text();
      parseRss(xml).slice(0, PER_QUERY).forEach((it) => all.push({ ...it, query: q }));
    } catch {
      errors.push(q);
    }
  }
  const seen = new Set();
  const items = [];
  for (const it of all) {
    const k = it.title.toLowerCase().slice(0, 60);
    if (!seen.has(k)) {
      seen.add(k);
      items.push(it);
    }
  }
  cache = { at: Date.now(), items, errors };
  return cache;
}

async function getRadar() {
  const fresh = Date.now() - cache.at < TTL_MS && cache.items.length;
  if (fresh) return { ...cache, fromCache: true };
  if (!refreshing) refreshing = refresh().finally(() => (refreshing = null));
  try {
    const c = await refreshing;
    return { ...c, fromCache: false };
  } catch {
    return { ...cache, fromCache: true };
  }
}

// Sources we can't legally/reliably automate for €0 → the marketer opens these
// and adds findings by hand (an honest hybrid, not fake automation).
const RESEARCH_LINKS = [
  { label: "Google Trends — study abroad", url: "https://trends.google.com/trends/explore?q=study%20abroad,scholarship" },
  { label: "Reddit — r/studyAbroad (top this week)", url: "https://www.reddit.com/r/studyAbroad/top/?t=week" },
  { label: "Reddit — r/IWantOut", url: "https://www.reddit.com/r/IWantOut/top/?t=week" },
  { label: "YouTube — study in Europe", url: "https://www.youtube.com/results?search_query=study+in+europe+scholarship&sp=CAI%253D" },
  { label: "Google News — scholarships", url: "https://news.google.com/search?q=international%20student%20scholarships%20when%3A7d" },
];

module.exports = { getRadar, RESEARCH_LINKS, parseRss, topicOf };
