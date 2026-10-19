"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const app = require("../server");
const store = require("../lib/store");
const adminAuth = require("../lib/admin-auth");

let server, base;
const jar = {};
const email = `admin_test_${Date.now()}@example.com`;
const password = "a very strong test password";

function cookieHeader() {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}
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
  return { status: res.status, json };
}

before(async () => {
  await new Promise((r) => {
    server = app.listen(0, r);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  await adminAuth.createAdmin(email, password); // seed directly — same in-process store the server reads
});

after(async () => {
  // Clean up the test admin so repeated local runs don't accumulate rows.
  const admins = store.read("admins").filter((a) => a.email !== email);
  await store.write("admins", admins);
  server && server.close();
});

test("GET /api/admin/me without a session is 401", async () => {
  const r = await req("GET", "/api/admin/me");
  assert.equal(r.status, 401);
});

test("GET /api/admin/health without a session is 401 (dashboard data is protected)", async () => {
  const r = await req("GET", "/api/admin/health");
  assert.equal(r.status, 401);
});

test("POST /api/admin/login rejects a wrong password", async () => {
  const r = await req("POST", "/api/admin/login", {
    email,
    password: "not the password",
  });
  assert.equal(r.status, 401);
});

test("POST /api/admin/login rejects an unknown email without leaking which emails exist", async () => {
  const r = await req("POST", "/api/admin/login", {
    email: "nope@example.com",
    password: "whatever12345",
  });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, "Incorrect email or password.");
});

test("POST /api/admin/login with correct credentials sets a session cookie", async () => {
  const r = await req("POST", "/api/admin/login", { email, password });
  assert.equal(r.status, 200);
  assert.equal(r.json.admin.email, email);
  assert.ok(jar.uv_admin, "admin session cookie set");
});

test("GET /api/admin/me now succeeds with the session cookie", async () => {
  const r = await req("GET", "/api/admin/me");
  assert.equal(r.status, 200);
  assert.equal(r.json.admin.email, email);
});

test("GET /api/admin/audience returns counts only, and falls back on bad input", async () => {
  const r = await req("GET", "/api/admin/audience?range=bogus&who=x");
  assert.equal(r.status, 200);
  assert.equal(r.json.range, "today");
  assert.equal(r.json.daily.length, 7);
  assert.ok(
    Array.isArray(r.json.people),
    "founder view includes the people list",
  );
  assert.ok(r.json.previous.visitors, "every number has a comparison");
  assert.ok(
    !/@|password/i.test(JSON.stringify(r.json)),
    "never emails or hashes",
  );
});

test("GET /api/admin/health returns the dataset overview and recent edits", async () => {
  const r = await req("GET", "/api/admin/health");
  assert.equal(r.status, 200);
  const o = r.json.overview;
  assert.ok(typeof o.total === "number" && o.total > 2000);
  assert.ok(o.featured > 0 && o.featured <= o.total);
  assert.ok(typeof o.researchedTuition === "number");
  assert.ok(
    typeof o.scholarships.total === "number" && o.scholarships.total > 0,
  );
  assert.ok(Array.isArray(r.json.recent));
});

test("GET /api/admin/records lists the featured work queue, filters and searches", async () => {
  const r = await req("GET", "/api/admin/records?limit=5");
  assert.equal(r.status, 200);
  assert.ok(r.json.total > 0 && r.json.items.length <= 5);
  const it = r.json.items[0];
  assert.ok(it.id && it.name && Array.isArray(it.needs));
  assert.equal(it.type, "university");

  const sch = await req(
    "GET",
    "/api/admin/records?scope=scholarships&limit=100",
  );
  assert.ok(
    sch.json.items.length > 0 &&
      sch.json.items.every((x) => x.type === "scholarship"),
  );

  const q = await req(
    "GET",
    "/api/admin/records?scope=all&q=" + encodeURIComponent(it.name.slice(0, 8)),
  );
  assert.ok(q.json.items.some((x) => x.id === it.id));

  const f = await req(
    "GET",
    "/api/admin/records?filter=missing_deadline&limit=100",
  );
  assert.ok(f.json.items.every((x) => x.needs.includes("deadline")));
});

test("GET /api/admin/leads returns the pilot-lead rows with a session", async () => {
  const r = await req("GET", "/api/admin/leads");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.leads));
  assert.equal(typeof r.json.count, "number");
});

test("GET /api/admin/subscribers.csv is admin-gated and returns a CSV header row", async () => {
  const res = await fetch(base + "/api/admin/subscribers.csv", {
    headers: { Cookie: cookieHeader() },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/csv/);
  assert.match(
    await res.text(),
    /^email,full_name,country_of_origin,signup_date/,
  );

  const anon = await fetch(base + "/api/admin/subscribers.csv"); // no cookies
  assert.equal(anon.status, 401);
});

const SRC = "https://www.example-university.edu/admissions";
let editId;

test("editing: a number or date without a source link is refused (server-side, not just the form)", async () => {
  const list = await req(
    "GET",
    "/api/admin/records?filter=missing_deadline&limit=1",
  );
  editId = list.json.items[0].id;
  const bad = await req("PATCH", "/api/admin/record/university/" + editId, {
    fields: { deadline: { value: "31 January 2027" } },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.field, "deadline");
  assert.match(bad.json.error, /source/i);
  const nothing = await req("PATCH", "/api/admin/record/university/" + editId, {
    fields: {},
  });
  assert.equal(nothing.status, 400);
  const unknown = await req("PATCH", "/api/admin/record/university/" + editId, {
    fields: { name: { value: "x" } },
  });
  assert.equal(unknown.status, 400);
  assert.equal(
    (await req("PATCH", "/api/admin/record/nonsense/" + editId, { fields: {} }))
      .status,
    404,
  );
  assert.equal(
    (
      await req("PATCH", "/api/admin/record/university/does-not-exist", {
        fields: { deadline: { value: "x", source: SRC } },
      })
    ).status,
    404,
  );
});

test("editing: a sourced edit is saved, shown to students as verified, logged, and revertible", async () => {
  const before = (await req("GET", "/api/universities/" + editId)).json
    .university;
  const ok = await req("PATCH", "/api/admin/record/university/" + editId, {
    fields: {
      deadline: { value: "31 January 2027", source: SRC },
      tuition: { min: "1,200", max: "1,200", source: SRC },
    },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.fields.deadline.status, "edited");
  assert.equal(ok.json.fields.tuition.status, "edited");
  assert.ok(ok.json.verified_at, "a sourced save counts as a verification");

  // What a STUDENT now sees from the public API.
  const after = (await req("GET", "/api/universities/" + editId)).json
    .university;
  assert.equal(after.application_deadline, "31 January 2027");
  assert.equal(
    after.tuition_source,
    "curated_research",
    "the gate every tuition display checks",
  );
  assert.equal(after.tuition_range.min, 1200);
  assert.equal(after.tuition_range.estimated, undefined);
  assert.equal(after.sources.deadline, SRC);

  // It is in the activity feed.
  const health = await req("GET", "/api/admin/health");
  assert.ok(
    health.json.recent.some(
      (l) => l.id === editId && l.fields.includes("deadline"),
    ),
  );

  // And it can be reverted to exactly what the seed said.
  const rev = await req("PATCH", "/api/admin/record/university/" + editId, {
    fields: { deadline: null, tuition: null },
  });
  assert.equal(rev.status, 200);
  const reverted = (await req("GET", "/api/universities/" + editId)).json
    .university;
  assert.equal(reverted.application_deadline, before.application_deadline);
  assert.equal(reverted.tuition_source, before.tuition_source);
});

test("editing: 'mark verified today' stamps the record and appears in the feed", async () => {
  const v = await req(
    "POST",
    "/api/admin/record/university/" + editId + "/verify",
  );
  assert.equal(v.status, 200);
  assert.equal(v.json.verified_at, new Date().toISOString().slice(0, 10));
  assert.equal(v.json.verified_by, email);
  assert.equal(
    (await req("POST", "/api/admin/record/university/does-not-exist/verify"))
      .status,
    404,
  );
});

test("editing: scholarships take a validated deadline and a link", async () => {
  const sch = (
    await req("GET", "/api/admin/records?scope=scholarships&limit=1")
  ).json.items[0];
  const badDate = await req(
    "PATCH",
    "/api/admin/record/scholarship/" + sch.id,
    { fields: { deadline: { value: "15 Jan", source: SRC } } },
  );
  assert.equal(badDate.status, 400);
  const ok = await req("PATCH", "/api/admin/record/scholarship/" + sch.id, {
    fields: { deadline: { value: "2027-01-15", note: "Round 2", source: SRC } },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.fields.deadline.value, "2027-01-15");
  assert.equal(ok.json.fields.deadline.note, "Round 2");
});

test("usage: real searches are recorded with their filters and result count, and show up", async () => {
  const events = require("../lib/events");
  // A real search with filters, one with a free-text query that finds nothing,
  // a "load more" (must not count) and a bare page load (must not count).
  const anon = "uv_anon=usage-test-" + Date.now();
  const hit = (qs) =>
    fetch(base + "/api/universities?" + qs, { headers: { Cookie: anon } });
  await hit("country=Germany&limit=5");
  await hit("q=zzzqqqnotauniversity&limit=5");
  await hit("country=Germany&limit=5&offset=5");
  await hit("limit=5");
  await events.flush();

  const u = await req("GET", "/api/admin/usage");
  assert.equal(u.status, 200);
  assert.equal(u.json.series.searches.length, 8);
  assert.ok(u.json.current.searches >= 2, "both real searches counted");
  assert.ok(u.json.lists.countries.some((c) => c.name === "Germany"));
  assert.ok(
    u.json.gaps.some((g) => g.q === "zzzqqqnotauniversity" && g.results === 0),
    "a search that found nothing is surfaced as unmet demand",
  );
  assert.ok(u.json.searchQuality.zero >= 1);
  assert.equal(typeof u.json.accounts.total, "number");
  assert.equal(typeof u.json.enquiries.count, "number");
  assert.equal(u.json.subscribersCsv, "/api/admin/subscribers.csv");
});

test("usage: pageviews carry only an anonymous id — no device, referrer, language or path", async () => {
  const events = require("../lib/events");
  const anon = "uv_anon=privacy-test-" + Date.now();
  await fetch(base + "/api/track", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: anon,
      Referer: "https://example.org/x",
      "Accept-Language": "mn-MN",
    },
    body: JSON.stringify({
      type: "pageview",
      path: "/secret",
      device: "mobile",
    }),
  });
  // An old cached client still sending the retired filter beacon is accepted and dropped.
  const legacy = await fetch(base + "/api/track", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: anon },
    body: JSON.stringify({ type: "filter_used", filter: "field", value: "x" }),
  });
  assert.equal(legacy.status, 204);
  await events.flush();
  const mine = events.readAll().filter((e) => e.anon === anon.split("=")[1]);
  assert.equal(mine.length, 1, "the legacy beacon recorded nothing");
  assert.deepEqual(Object.keys(mine[0]).sort(), ["anon", "ts", "type"]);
});

test("a student session cannot access admin routes", async () => {
  // Register a student in a fresh cookie jar (simulated by clearing uv_admin only).
  delete jar.uv_admin;
  const reg = await req("POST", "/api/auth/register", {
    full_name: "Not An Admin",
    email: `student_${Date.now()}@example.com`,
    password: "password123",
    consent: true,
  });
  assert.equal(reg.status, 201);
  const r = await req("GET", "/api/admin/health"); // has uv_token but no uv_admin
  assert.equal(r.status, 401);
  await req("DELETE", "/api/me"); // cleanup the student account
});

test("POST /api/admin/logout clears the session", async () => {
  await req("POST", "/api/admin/login", { email, password });
  const out = await req("POST", "/api/admin/logout");
  assert.equal(out.status, 200);
  const me = await req("GET", "/api/admin/me");
  assert.equal(me.status, 401);
});
