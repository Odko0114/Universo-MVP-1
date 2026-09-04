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

test("two independent adds both persist (granular writes, no whole-blob overwrite)", async () => {
  const a = await req("POST", "/api/marketing/idea", { title: "Persist A" });
  const b = await req("POST", "/api/marketing/idea", { title: "Persist B" });
  const data = await req("GET", "/api/marketing/data");
  assert.ok(data.json.ideas.some((i) => i.id === a.json.idea.id));
  assert.ok(data.json.ideas.some((i) => i.id === b.json.idea.id));
});

test("brand-brain patches merge field-by-field (a second patch keeps the first)", async () => {
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
