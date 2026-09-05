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

// Google Trends — daily trending searches, ANY topic (not education). Free
// public RSS, no key. Titles are the trending search terms.
function parseTrends(xml) {
  const out = [];
  for (const p of String(xml).split(/<item>/i).slice(1)) {
    const m = p.match(/<title>([\s\S]*?)<\/title>/i);
    const l = p.match(/<link>([\s\S]*?)<\/link>/i);
    const traffic = p.match(/approx_traffic>([\s\S]*?)<\//i);
    const title = m ? decode(m[1]) : "";
    if (title) out.push({ title, link: l ? decode(l[1]) : "https://trends.google.com/trending", source: traffic ? "Trending · " + decode(traffic[1]) + " searches" : "Google Trends", topic: topicOf(title), kind: "trend" });
  }
  return out;
}

// Reddit — top posts of the day across ALL of Reddit. High upvotes = trending
// with real people, any topic. Free JSON, no key (best-effort: cloud IPs are
// sometimes throttled, in which case it's simply absent).
function parseReddit(json) {
  const kids = (json && json.data && json.data.children) || [];
  return kids
    .map((c) => c.data)
    .filter((d) => d && d.title && !d.over_18)
    .map((d) => ({ title: decode(d.title), link: "https://www.reddit.com" + d.permalink, source: "r/" + d.subreddit + " · " + (d.ups || 0).toLocaleString("en-US") + " upvotes", topic: topicOf(d.title), kind: "reddit" }));
}

async function fetchNews() {
  const out = [];
  for (const q of QUERIES) {
    const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(q + " when:7d") + "&hl=en-US&gl=US&ceid=US:en";
    try {
      const res = await fetchWithResilience(url, { headers: { "User-Agent": UA }, timeoutMs: 8000, retries: 1, label: "news-rss" });
      parseRss(await res.text()).slice(0, PER_QUERY).forEach((it) => out.push({ ...it, kind: "news", query: q }));
    } catch { /* skip this query */ }
  }
  return out;
}
async function fetchTrends() {
  try {
    const res = await fetchWithResilience("https://trends.google.com/trending/rss?geo=US", { headers: { "User-Agent": UA }, timeoutMs: 8000, retries: 1, label: "google-trends" });
    return parseTrends(await res.text()).slice(0, 12);
  } catch { return []; }
}
async function fetchReddit() {
  try {
    const res = await fetchWithResilience("https://www.reddit.com/r/all/top.json?t=day&limit=20", { headers: { "User-Agent": UA, Accept: "application/json" }, timeoutMs: 8000, retries: 1, label: "reddit-top" });
    return parseReddit(await res.json()).slice(0, 12);
  } catch { return []; }
}

async function refresh() {
  const errors = [];
  const [news, trend, reddit] = await Promise.all([
    fetchNews().catch(() => { errors.push("news"); return []; }),
    fetchTrends().catch(() => { errors.push("trends"); return []; }),
    fetchReddit().catch(() => { errors.push("reddit"); return []; }),
  ]);
  const seen = new Set();
  const items = [];
  for (const it of [...news, ...trend, ...reddit]) {
    const k = it.title.toLowerCase().slice(0, 60);
    if (!seen.has(k)) { seen.add(k); items.push(it); }
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
  { label: "🎵 TikTok Creative Center — top videos, sounds & hashtags", url: "https://ads.tiktok.com/business/creativecenter/inspiration/popular/pc/en" },
  { label: "▶️ YouTube — Trending", url: "https://www.youtube.com/feed/trending" },
  { label: "📈 Google Trends — trending now", url: "https://trends.google.com/trending?geo=US" },
  { label: "👽 Reddit — r/all (top this week)", url: "https://www.reddit.com/r/all/top/?t=week" },
  { label: "📸 Instagram — Reels", url: "https://www.instagram.com/reels/" },
  { label: "🎓 Reddit — r/studyAbroad", url: "https://www.reddit.com/r/studyAbroad/top/?t=week" },
];

module.exports = { getRadar, RESEARCH_LINKS, parseRss, parseTrends, parseReddit, topicOf };
