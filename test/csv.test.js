"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseCsv, toCsv, detectDelimiter, unguard } = require("../lib/csv");

const cells = (r) => r.records.map((x) => x.cells);

test("parses a plain comma file, with line numbers", () => {
  const r = parseCsv("id,name\nu1,Alpha\nu2,Beta\n");
  assert.equal(r.delimiter, ",");
  assert.deepEqual(cells(r), [
    ["id", "name"],
    ["u1", "Alpha"],
    ["u2", "Beta"],
  ]);
  assert.deepEqual(
    r.records.map((x) => x.line),
    [1, 2, 3],
  );
});

test("detects the semicolon Excel uses in Finland / Europe", () => {
  const r = parseCsv("id;name;note\r\nu1;Alpha;a, b, c\r\n");
  assert.equal(r.delimiter, ";");
  assert.deepEqual(cells(r)[1], ["u1", "Alpha", "a, b, c"]); // commas inside are just text
});

test("detects tabs, and ignores delimiters that are inside quotes in the header", () => {
  assert.equal(detectDelimiter("a\tb\tc\n1\t2\t3"), "\t");
  assert.equal(detectDelimiter('"a,b,c";d;e\n1;2;3'), ";");
});

test("strips the UTF-8 byte-order mark Excel adds", () => {
  const r = parseCsv("﻿id,name\nu1,Åbo Akademi\n");
  assert.deepEqual(cells(r)[0], ["id", "name"]);
  assert.equal(cells(r)[1][1], "Åbo Akademi");
});

test("handles quotes: delimiters, doubled quotes and line breaks inside a cell", () => {
  const r = parseCsv(
    'id,req\nu1,"IELTS 6.5, or ""TOEFL 88""\nand a portfolio"\nu2,plain\n',
  );
  assert.equal(cells(r)[1][1], 'IELTS 6.5, or "TOEFL 88"\nand a portfolio');
  assert.equal(
    r.records[2].line,
    4,
    "line numbers count lines inside quoted cells",
  );
  assert.deepEqual(cells(r)[2], ["u2", "plain"]);
});

test("handles CRLF, lone CR, a missing final newline and blank rows", () => {
  assert.deepEqual(cells(parseCsv("a,b\r\n1,2\r\n\r\n3,4")), [
    ["a", "b"],
    ["1", "2"],
    ["3", "4"],
  ]);
  assert.deepEqual(cells(parseCsv("a,b\r1,2")), [
    ["a", "b"],
    ["1", "2"],
  ]);
  assert.deepEqual(cells(parseCsv("")), []);
});

test("keeps empty cells in place (a skipped column must not shift the rest)", () => {
  assert.deepEqual(cells(parseCsv("a,b,c\n1,,3\n,,\n"))[1], ["1", "", "3"]);
});

test("an unclosed quote is reported with the line it started on, not swallowed", () => {
  const r = parseCsv('a,b\n1,"never closed\n2,3');
  assert.match(r.error, /line 2/);
});

test("rejects absurd input instead of hanging", () => {
  assert.match(parseCsv("a\n" + "x\n".repeat(6000)).error, /more than/);
  assert.match(parseCsv("a\n" + "x".repeat(6000)).error, /longer than/);
});

test("writes with a BOM, quotes only when needed, and CRLF line ends", () => {
  const out = toCsv([
    ["id", "note"],
    ["u1", 'say "hi", ok'],
    ["u2", "plain"],
  ]);
  assert.equal(out.charCodeAt(0), 0xfeff);
  assert.match(out, /u1,"say ""hi"", ok"\r\n/);
  assert.match(out, /u2,plain\r\n$/);
});

test("writes with the delimiter asked for (semicolon for Finnish Excel)", () => {
  const out = toCsv([["a", "b, c"]], { delimiter: ";", bom: false });
  assert.equal(out, "a;b, c\r\n"); // a comma is harmless in a semicolon file
});

test("spreadsheet formulas in cells are neutralised on export, and undone on import", () => {
  const out = toCsv(
    [['=HYPERLINK("http://evil","x")', "+1", "-2", "@x", "ok"]],
    { bom: false },
  );
  assert.ok(out.startsWith(`"'=HYPERLINK(`) || out.startsWith("'=HYPERLINK("));
  assert.ok(
    out.includes(",'+1,") && out.includes(",'-2,") && out.includes(",'@x,"),
  );
  assert.equal(unguard("'=SUM(A1)"), "=SUM(A1)");
  assert.equal(unguard("'plain"), "'plain"); // only our own guard is removed
});

test("round trip: what we write is what we read (commas, quotes, accents, newlines, ;)", () => {
  const rows = [
    ["id", "text"],
    ["u1", 'a, "b"; c\nd'],
    ["u2", "Åbo — ü"],
    ["u3", ""],
  ];
  for (const delimiter of [",", ";", "\t"]) {
    const back = parseCsv(toCsv(rows, { delimiter }));
    assert.equal(back.delimiter, delimiter);
    assert.deepEqual(cells(back), rows);
  }
});
