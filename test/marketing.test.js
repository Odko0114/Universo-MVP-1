"use strict";

// Marketing OS endpoints: auth, the marketing-vs-admin permission wall, idea
// CRUD + validation, field-level brand-brain merges, the real-data ideas feed,
// and the concurrency guarantee (granular writes don't overwrite each other).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const app = require("../server");
const adminAuth = require("../lib/admin-auth");
const trends = require("../lib/trends");

let server, base;
let jar = {};
const cookieHeader = () =>
  Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
function stash(res) {
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of set) {
    const [kv] = c.split(";");
    const i = kv.indexOf("=");
    jar[kv.slice(0, i)] = kv.slice(i + 1);
  }
}
async function req(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookieHeader() },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  stash(res);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
}
async function loginAs(email, password) {
  jar = {};
  const r = await req("POST", "/api/admin/login", { email, password });
  return r.status;
}

const MKT = { email: "mkt-os-test@example.com", pw: "Marketing123!" };
const ADM = { email: "adm-os-test@example.com", pw: "Adminpass123!" };

before(async () => {
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
  await adminAuth.createAdmin(MKT.email, MKT.pw, "marketing");
  await adminAuth.createAdmin(ADM.email, ADM.pw, "admin");
});
after(() => server && server.close());

test("marketing routes reject unauthenticated access with 401", async () => {
  jar = {};
  for (const p of ["/api/marketing/me", "/api/marketing/data", "/api/marketing/ideas-feed"]) {
    assert.equal((await req("GET", p)).status, 401, p);
  }
  assert.equal((await req("POST", "/api/marketing/idea", { title: "x" })).status, 401);
});

test("a marketing-role account can sign in and use the OS", async () => {
  assert.equal(await loginAs(MKT.email, MKT.pw), 200);
  const me = await req("GET", "/api/marketing/me");
  assert.equal(me.status, 200);
  assert.equal(me.json.email, MKT.email);
  const data = await req("GET", "/api/marketing/data");
  assert.equal(data.status, 200);
  assert.ok(Array.isArray(data.json.ideas));
  assert.ok(data.json.brain && typeof data.json.brain === "object");
});

test("idea CRUD: create (with owner), patch status/owner/due/draft, delete", async () => {
  // no title → 400
  assert.equal((await req("POST", "/api/marketing/idea", {})).status, 400);
  const created = await req("POST", "/api/marketing/idea", { title: "Test idea", owner: "Founder" });
  assert.equal(created.status, 200);
  const id = created.json.idea.id;
  assert.ok(id);
  assert.equal(created.json.idea.owner, "Founder");
  assert.equal(created.json.idea.status, "idea");

  const patched = await req("PATCH", "/api/marketing/idea/" + id, {
    status: "review",
    due: "2027-05-01",
    draft: "final copy",
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.idea.status, "review");
  assert.equal(patched.json.idea.due, "2027-05-01");
  assert.equal(patched.json.idea.draft, "final copy");

  // an invalid due is rejected
  assert.equal((await req("PATCH", "/api/marketing/idea/" + id, { due: "nope" })).status, 400);
  // an unknown status is ignored, not applied
  await req("PATCH", "/api/marketing/idea/" + id, { status: "bogus" });
  const afterBogus = await req("GET", "/api/marketing/data");
  assert.equal(afterBogus.json.ideas.find((i) => i.id === id).status, "review");

  assert.equal((await req("DELETE", "/api/marketing/idea/" + id)).status, 200);
  const gone = await req("GET", "/api/marketing/data");
  assert.ok(!gone.json.ideas.find((i) => i.id === id));

  // patching a missing idea → 404
  assert.equal((await req("PATCH", "/api/marketing/idea/" + id, { status: "idea" })).status, 404);
});

test("performance results: record, sanitize, persist, edit, auto-post", async () => {
  const created = await req("POST", "/api/marketing/idea", { title: "Perf idea" });
  const id = created.json.idea.id;
  assert.deepEqual(created.json.idea.results, []); // new ideas start with an empty history

  // record two platforms; a bogus rating/platform/metric is coerced, not trusted
  const rec = await req("PATCH", "/api/marketing/idea/" + id, {
    results: [
      { platform: "TikTok", date: "2026-09-08", rating: "Great", note: "hi", views: "1240", likes: 84 },
      { platform: "Nope", date: "bad", rating: "Amazing", views: "-5", saves: "abc" },
    ],
  });
  assert.equal(rec.status, 200);
  const r = rec.json.idea.results;
  assert.equal(r.length, 2);
  assert.equal(r[0].views, 1240); // numeric string → number
  assert.equal(r[0].rating, "Great");
  assert.equal(r[1].platform, "Other"); // unknown platform coerced
  assert.equal(r[1].date, ""); // bad date coerced to empty
  assert.equal(r[1].rating, ""); // unknown rating dropped
  assert.equal(r[1].views, ""); // negative → empty, never a fake number
  assert.equal(r[1].saves, ""); // non-numeric → empty
  assert.equal(rec.json.idea.status, "posted"); // recording results auto-posts

  // survives a fresh read (persistence)
  const after = await req("GET", "/api/marketing/data");
  assert.equal(after.json.ideas.find((i) => i.id === id).results[0].likes, 84);

  // edit later: same content, updated rating; original title untouched
  const edited = await req("PATCH", "/api/marketing/idea/" + id, {
    title: undefined,
    results: [{ platform: "TikTok", date: "2026-09-08", rating: "Good" }],
  });
  assert.equal(edited.json.idea.results.length, 1);
  assert.equal(edited.json.idea.results[0].rating, "Good");
  assert.equal(edited.json.idea.title, "Perf idea");

  // a non-array results payload is rejected
  assert.equal((await req("PATCH", "/api/marketing/idea/" + id, { results: "x" })).status, 400);

  await req("DELETE", "/api/marketing/idea/" + id);
});

test("idea persists goal, topic and platforms (deduped); patch updates them", async () => {
  const created = await req("POST", "/api/marketing/idea", { title: "Goal idea", goal: "signups", topic: "Scholarships", platforms: ["reel", "linkedin", "reel"] });
  const id = created.json.idea.id;
  assert.equal(created.json.idea.goal, "signups");
  assert.equal(created.json.idea.topic, "Scholarships");
  assert.deepEqual(created.json.idea.platforms, ["reel", "linkedin"]); // deduped, order kept

  // a fresh read confirms persistence
  const data = await req("GET", "/api/marketing/data");
  const got = data.json.ideas.find((i) => i.id === id);
  assert.equal(got.goal, "signups");
  assert.deepEqual(got.platforms, ["reel", "linkedin"]);

  // patch updates goal + platforms; a non-array platforms is rejected
  const patched = await req("PATCH", "/api/marketing/idea/" + id, { goal: "trust", platforms: ["ig"] });
  assert.equal(patched.json.idea.goal, "trust");
  assert.deepEqual(patched.json.idea.platforms, ["ig"]);
  assert.equal((await req("PATCH", "/api/marketing/idea/" + id, { platforms: "nope" })).status, 400);

  // legacy ideas without these fields still work (created without them)
  const legacy = await req("POST", "/api/marketing/idea", { title: "Legacy" });
  assert.deepEqual(legacy.json.idea.platforms, []);
  assert.equal(legacy.json.idea.goal, "");

  await req("DELETE", "/api/marketing/idea/" + id);
  await req("DELETE", "/api/marketing/idea/" + legacy.json.idea.id);
});

test("editing checklist persists (booleans, capped); bad payload rejected", async () => {
  const created = await req("POST", "/api/marketing/idea", { title: "Edit idea" });
  const id = created.json.idea.id;
  assert.deepEqual(created.json.idea.editing, {}); // starts empty
  const patched = await req("PATCH", "/api/marketing/idea/" + id, { editing: { hook: true, captions: "yes", music: 0 } });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.idea.editing.hook, true);
  assert.equal(patched.json.idea.editing.captions, true); // coerced to boolean
  assert.equal(patched.json.idea.editing.music, false);
  const after = await req("GET", "/api/marketing/data");
  assert.equal(after.json.ideas.find((i) => i.id === id).editing.hook, true); // persisted
  assert.equal((await req("PATCH", "/api/marketing/idea/" + id, { editing: [1, 2] })).status, 400); // array rejected
  await req("DELETE", "/api/marketing/idea/" + id);
});

test("content workspace persists (fields + versions); bad payload rejected", async () => {
  const created = await req("POST", "/api/marketing/idea", { title: "Editor idea" });
  const id = created.json.idea.id;
  assert.deepEqual(created.json.idea.content, {}); // starts empty
  const patched = await req("PATCH", "/api/marketing/idea/" + id, {
    content: { hook: "Big hook", caption: "The post body", cta: "Join free", mediaUrl: "https://x/i.png", mediaType: "image", notes: "punchy", versions: [{ at: "2026-09-09 10:00", hook: "old", caption: "old body", cta: "old", body: "" }] },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.idea.content.hook, "Big hook");
  assert.equal(patched.json.idea.content.caption, "The post body");
  assert.equal(patched.json.idea.content.versions.length, 1);
  const after = await req("GET", "/api/marketing/data");
  assert.equal(after.json.ideas.find((i) => i.id === id).content.cta, "Join free"); // persisted
  assert.equal((await req("PATCH", "/api/marketing/idea/" + id, { content: [1, 2] })).status, 400); // array rejected
  await req("DELETE", "/api/marketing/idea/" + id);
});

test("image upload stores an asset, serves it back; bad type & traversal rejected", async () => {
  assert.equal(await loginAs(MKT.email, MKT.pw), 200);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  const up = await fetch(base + "/api/marketing/upload?type=image/png", { method: "POST", headers: { "Content-Type": "application/octet-stream", Cookie: cookieHeader() }, body: png });
  const j = await up.json();
  assert.equal(up.status, 200);
  assert.match(j.url, /^\/api\/marketing\/asset\/[a-z0-9]+\.png$/);
  const get = await fetch(base + j.url, { headers: { Cookie: cookieHeader() } });
  assert.equal(get.status, 200); // serves the stored asset
  const bad = await fetch(base + "/api/marketing/upload?type=text/plain", { method: "POST", headers: { "Content-Type": "application/octet-stream", Cookie: cookieHeader() }, body: png });
  assert.equal(bad.status, 400); // non-image rejected
  const trav = await fetch(base + "/api/marketing/asset/..%2fmarketing.json", { headers: { Cookie: cookieHeader() } });
  assert.ok(trav.status === 400 || trav.status === 404); // no path traversal
});

test("status lifecycle accepts the new stages", async () => {
  await loginAs(ADM.email, ADM.pw); // founder — "approved" is founder-gated
  const created = await req("POST", "/api/marketing/idea", { title: "Lifecycle idea" });
  const id = created.json.idea.id;
  for (const s of ["editing", "approved", "scheduled"]) {
    const r = await req("PATCH", "/api/marketing/idea/" + id, { status: s });
    assert.equal(r.json.idea.status, s, s + " accepted");
  }
  await req("DELETE", "/api/marketing/idea/" + id);
});

test("permissions: marketer can't edit brand, self-approve, or publish a flagged item; founder can", async () => {
  assert.equal(await loginAs(MKT.email, MKT.pw), 200); // marketer
  assert.equal((await req("PATCH", "/api/marketing/brain", { perm_probe: "x" })).status, 403); // brand = founder only
  const it = await req("POST", "/api/marketing/idea", { title: "perm item" });
  const id = it.json.idea.id;
  assert.equal((await req("PATCH", "/api/marketing/idea/" + id, { status: "approved" })).status, 403); // can't self-approve
  assert.equal((await req("PATCH", "/api/marketing/idea/" + id, { approval: true })).status, 200); // can request approval
  assert.equal((await req("PATCH", "/api/marketing/idea/" + id, { status: "posted" })).status, 403); // flagged → can't publish
  assert.equal((await req("PATCH", "/api/marketing/idea/" + id, { approval: false })).status, 403); // can't grant own approval

  assert.equal(await loginAs(ADM.email, ADM.pw), 200); // founder
  const ok = await req("PATCH", "/api/marketing/idea/" + id, { status: "approved", approval: false });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.idea.status, "approved");
  assert.equal((await req("PATCH", "/api/marketing/brain", { perm_probe: "founder-set" })).status, 200); // founder edits brand
  await req("DELETE", "/api/marketing/idea/" + id);
});

test("approval flag defaults off and toggles", async () => {
  const created = await req("POST", "/api/marketing/idea", { title: "Approval idea" });
  assert.equal(created.json.idea.approval, false); // off by default — no sign-off needed
  const id = created.json.idea.id;
  const on = await req("PATCH", "/api/marketing/idea/" + id, { approval: true });
  assert.equal(on.json.idea.approval, true);
  const back = await req("GET", "/api/marketing/data");
  assert.equal(back.json.ideas.find((i) => i.id === id).approval, true); // persists
  await req("DELETE", "/api/marketing/idea/" + id);
});

test("insights endpoint returns engine output driven by recorded results", async () => {
  assert.equal(await loginAs(MKT.email, MKT.pw), 200);
  // an idea with a clear winning combo: Story about a distinct topic, two Greats on TikTok
  const win = await req("POST", "/api/marketing/idea", { title: "Insight win", formula: "story", topic: "InsightTopic", goal: "signups" });
  await req("PATCH", "/api/marketing/idea/" + win.json.idea.id, { results: [{ platform: "TikTok", date: "2026-09-01", rating: "Great" }, { platform: "TikTok", date: "2026-09-02", rating: "Great" }] });

  const ins = await req("GET", "/api/marketing/insights");
  assert.equal(ins.status, 200);
  assert.ok(ins.json.dims && Array.isArray(ins.json.dims.formula), "returns dimension breakdowns");
  assert.ok(["low", "medium", "high"].includes(ins.json.confidence), "reports confidence");
  assert.ok(ins.json.nextBest, "recommends what to create next once there are rated posts");
  // the winning combo should surface story+InsightTopic somewhere in the ranked combos
  assert.ok(ins.json.combos.formulaTopic.some((c) => c.formula === "story" && c.topic === "InsightTopic" && c.n === 2), "joins results to idea dimensions");

  await req("DELETE", "/api/marketing/idea/" + win.json.idea.id);
});

test("two independent adds both persist (granular writes, no whole-blob overwrite)", async () => {
  const a = await req("POST", "/api/marketing/idea", { title: "Persist A" });
  const b = await req("POST", "/api/marketing/idea", { title: "Persist B" });
  const data = await req("GET", "/api/marketing/data");
  assert.ok(data.json.ideas.some((i) => i.id === a.json.idea.id));
  assert.ok(data.json.ideas.some((i) => i.id === b.json.idea.id));
});

test("brand-brain patches merge field-by-field (a second patch keeps the first)", async () => {
  await loginAs(ADM.email, ADM.pw); // brand editing is founder-only
  await req("PATCH", "/api/marketing/brain", { mission: "MISSION-X" });
  await req("PATCH", "/api/marketing/brain", { tone: "TONE-Y" });
  const data = await req("GET", "/api/marketing/data");
  assert.equal(data.json.brain.mission, "MISSION-X");
  assert.equal(data.json.brain.tone, "TONE-Y");
});

test("ideas-feed returns real content seeds mined from Universo's data", async () => {
  const feed = await req("GET", "/api/marketing/ideas-feed");
  assert.equal(feed.status, 200);
  assert.ok(Array.isArray(feed.json.seeds));
  assert.ok(feed.json.seeds.length > 10);
  assert.ok(feed.json.seeds.some((s) => s.cat === "Scholarship"));
});

test("script endpoint composes a ready script from real data with sources", async () => {
  assert.equal(await loginAs(MKT.email, MKT.pw), 200);
  const sch = await req("GET", "/api/marketing/script?topic=Scholarships&angle=funding");
  assert.equal(sch.status, 200);
  assert.ok(Array.isArray(sch.json.beats) && sch.json.beats.length >= 2, "has beats");
  assert.ok(sch.json.beats.every((b) => b.cue && b.line), "every beat is filled, not a label");
  assert.ok(Array.isArray(sch.json.sources), "returns sources to verify");
  assert.ok(sch.json.dataLabel, "labels where the data came from");
  // an unknown/creative topic still returns a real script (overview fallback)
  const ov = await req("GET", "/api/marketing/script?topic=Relatable&angle=day%20in%20the%20life");
  assert.equal(ov.status, 200);
  assert.equal(ov.json.kind, "overview");
  assert.ok(/universities/.test(ov.json.beats[0].line), "overview counts come from the dataset");
});

test("a marketing account is BLOCKED (403) from full-admin routes", async () => {
  assert.equal(await loginAs(MKT.email, MKT.pw), 200);
  assert.equal((await req("GET", "/api/admin/stats")).status, 403);
  assert.equal((await req("GET", "/api/admin/leads")).status, 403);
});

test("a full admin reaches BOTH the Marketing OS and the admin dashboard", async () => {
  assert.equal(await loginAs(ADM.email, ADM.pw), 200);
  assert.equal((await req("GET", "/api/marketing/me")).status, 200);
  assert.equal((await req("GET", "/api/admin/stats")).status, 200);
});

test("ideas carry source/rationale/priority; invalid priority falls back to med", async () => {
  assert.equal(await loginAs(MKT.email, MKT.pw), 200);
  const created = await req("POST", "/api/marketing/idea", {
    title: "Opportunity idea",
    source: "Headline — Publisher",
    rationale: "Trending this week",
    priority: "high",
  });
  assert.equal(created.json.idea.source, "Headline — Publisher");
  assert.equal(created.json.idea.rationale, "Trending this week");
  assert.equal(created.json.idea.priority, "high");
  const bad = await req("POST", "/api/marketing/idea", { title: "x", priority: "URGENT!!" });
  assert.equal(bad.json.idea.priority, "med"); // unknown priority is not trusted
  // PATCH accepts a valid priority, ignores an invalid one
  const id = created.json.idea.id;
  await req("PATCH", "/api/marketing/idea/" + id, { priority: "low" });
  await req("PATCH", "/api/marketing/idea/" + id, { priority: "bogus" });
  const data = await req("GET", "/api/marketing/data");
  assert.equal(data.json.ideas.find((i) => i.id === id).priority, "low");
});

test("the radar endpoint requires authentication", async () => {
  jar = {};
  assert.equal((await req("GET", "/api/marketing/radar")).status, 401);
});

test("trends.parseRss extracts real headlines and topic-tags them", () => {
  const xml = `<rss><channel>
    <item><title>New DAAD scholarship opens for international students - Study Times</title><link>https://example.com/a</link><pubDate>Mon, 01 Jan 2027</pubDate></item>
    <item><title>UK tightens student visa rules</title><link>https://example.com/b</link><source url="x">BBC</source></item>
  </channel></rss>`;
  const items = trends.parseRss(xml);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "New DAAD scholarship opens for international students");
  assert.equal(items[0].source, "Study Times"); // split from "Headline - Publisher"
  assert.equal(items[0].topic, "Scholarships");
  assert.equal(items[1].source, "BBC");
  assert.equal(items[1].topic, "Visa");
});

test("trends.topicOf maps keywords to Universo topics", () => {
  assert.equal(trends.topicOf("full scholarship for students"), "Scholarships");
  assert.equal(trends.topicOf("student visa changes"), "Visa");
  assert.equal(trends.topicOf("rising tuition fees"), "Cost");
  assert.equal(trends.topicOf("application deadline approaching"), "Applications");
  assert.equal(trends.topicOf("a nice day in europe"), "Study abroad");
});

test("trends.parseTrends reads Google Trends items (any topic) with traffic", () => {
  const xml = `<rss><channel>
    <item><title>Champions League</title><link>https://trends.google.com/x</link><ht:approx_traffic>2,000,000+</ht:approx_traffic></item>
    <item><title>new iphone</title></item>
  </channel></rss>`;
  const t = trends.parseTrends(xml);
  assert.equal(t.length, 2);
  assert.equal(t[0].title, "Champions League");
  assert.equal(t[0].kind, "trend");
  assert.match(t[0].source, /2,000,000\+ searches/); // traffic surfaced
});

test("trends.parseReddit reads top posts, keeps upvotes, drops NSFW", () => {
  const json = { data: { children: [
    { data: { title: "Wholesome moment", permalink: "/r/aww/1", subreddit: "aww", ups: 54000, over_18: false } },
    { data: { title: "NSFW thing", permalink: "/r/x/2", subreddit: "x", ups: 9, over_18: true } },
  ] } };
  const r = trends.parseReddit(json);
  assert.equal(r.length, 1); // NSFW filtered out
  assert.equal(r[0].kind, "reddit");
  assert.match(r[0].source, /54,000 upvotes/);
  assert.equal(r[0].link, "https://www.reddit.com/r/aww/1");
});
