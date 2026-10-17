"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const app = require("../server");
const store = require("../lib/store");
const adminAuth = require("../lib/admin-auth");
const { parseCsv, toCsv } = require("../lib/csv");
const { UNI_COLUMNS } = require("../lib/csv-import");

let server, base, cookie;
const email = `import_test_${Date.now()}@example.com`;
const password = "a very strong test password";
const SRC = "https://www.example-university.edu/admissions";

const call = (method, path, body, type = "application/json") =>
  fetch(base + path, {
    method,
    headers: { "Content-Type": type, Cookie: cookie || "" },
    body:
      body === undefined
        ? undefined
        : type === "application/json"
          ? JSON.stringify(body)
          : body,
  });

before(async () => {
  await new Promise((r) => {
    server = app.listen(0, r);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  await adminAuth.createAdmin(email, password);
  const r = await call("POST", "/api/admin/login", { email, password });
  cookie = r.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
});

after(async () => {
  await store.write(
    "admins",
    store.read("admins").filter((a) => a.email !== email),
  );
  server && server.close();
});

test("import routes are closed to signed-out visitors", async () => {
  const saved = cookie;
  cookie = "";
  assert.equal((await call("GET", "/api/admin/records.csv")).status, 401);
  assert.equal(
    (await call("POST", "/api/admin/import/preview", "a", "text/csv")).status,
    401,
  );
  assert.equal(
    (await call("POST", "/api/admin/import/apply", { token: "x" })).status,
    401,
  );
  cookie = saved;
});

test("export → fill → preview → apply saves a sourced deadline, with one log entry", async () => {
  const res = await call(
    "GET",
    "/api/admin/records.csv?filter=missing_deadline",
  );
  assert.equal(res.status, 200);
  assert.match(
    res.headers.get("content-disposition"),
    /universo-universitys?-featured-.*\.csv/,
  );
  const bytes = new Uint8Array(await res.clone().arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], "BOM for Excel");
  const text = await res.text();
  const parsed = parseCsv(text);
  assert.equal(parsed.delimiter, ";");
  const [header, first] = parsed.records.map((r) => r.cells);
  assert.deepEqual(header, UNI_COLUMNS);
  const id = first[1];
  first[UNI_COLUMNS.indexOf("deadline")] = "31.1.2027";
  first[UNI_COLUMNS.indexOf("deadline_source")] = SRC;
  const filled = toCsv([header, first], { delimiter: ";" });

  const prev = await call(
    "POST",
    "/api/admin/import/preview",
    filled,
    "text/csv",
  );
  assert.equal(prev.status, 200);
  const plan = await prev.json();
  assert.equal(plan.summary.update, 1, JSON.stringify(plan.rows));
  assert.equal(plan.toApply, 1);
  assert.ok(plan.token);
  assert.equal(plan.items, undefined, "the held plan is not echoed back");

  const before = (await (await call("GET", "/api/admin/health")).json()).recent
    .length;
  const ok = await call("POST", "/api/admin/import/apply", {
    token: plan.token,
  });
  const done = await ok.json();
  assert.equal(done.applied, 1);
  assert.deepEqual(done.failed, []);

  const rec = await (
    await call("GET", "/api/admin/record/university/" + id)
  ).json();
  assert.ok(rec.fields.deadline.value, "deadline saved");
  assert.equal(rec.fields.deadline.source, SRC);
  const recent = (await (await call("GET", "/api/admin/health")).json()).recent;
  assert.equal(recent[0].action, "import");
  assert.equal(recent.length, Math.min(8, before + 1));

  // the token is single-use
  const again = await call("POST", "/api/admin/import/apply", {
    token: plan.token,
  });
  assert.equal(again.status, 400);
});

test("a number without a source is a problem row, and nothing is held to apply", async () => {
  const text = await (await call("GET", "/api/admin/records.csv")).text();
  const [header, first] = parseCsv(text).records.map((r) => r.cells);
  first[UNI_COLUMNS.indexOf("tuition_min")] = "9000";
  first[UNI_COLUMNS.indexOf("tuition_max")] = "9000";
  const plan = await (
    await call(
      "POST",
      "/api/admin/import/preview",
      toCsv([header, first], { delimiter: ";" }),
      "text/csv",
    )
  ).json();
  assert.equal(plan.summary.error, 1);
  assert.equal(plan.toApply, 0);
});

test("bad uploads: not a sheet, too large, and unknown or expired tokens", async () => {
  const junk = await call(
    "POST",
    "/api/admin/import/preview",
    "hello",
    "text/csv",
  );
  assert.equal(junk.status, 400);
  const big = await call(
    "POST",
    "/api/admin/import/preview",
    "a;b\n" + "x;y\n".repeat(600000),
    "text/csv",
  );
  assert.equal(big.status, 413);
  const t = await call("POST", "/api/admin/import/apply", { token: "nope" });
  assert.equal(t.status, 400);
  assert.match((await t.json()).error, /expired/i);
});
