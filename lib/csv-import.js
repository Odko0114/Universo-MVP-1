"use strict";

/**
 * Spreadsheet round-trip for the admin Data screen.
 *
 *   buildSheet()  — the records in the current list as a CSV, pre-filled with
 *                   what is already CONFIRMED (never with country-level estimates,
 *                   so an estimate can't be re-saved as if it were checked).
 *   planImport()  — reads a filled-in CSV and works out, row by row, what would
 *                   change. It writes nothing; the caller shows a preview and only
 *                   applies the plan after the admin confirms.
 *
 * Every row goes through the SAME validation as the editor (lib/overrides.js),
 * including "no number, date or language claim without a source link". Parsing is
 * deliberately strict about numbers and dates — a spreadsheet that quietly turns
 * "12.000" into 12 euros would put a wrong figure in front of students.
 */

const { parseCsv, toCsv, unguard } = require("./csv");
const { validate } = require("./overrides");

const UNI_COLUMNS = [
  "type",
  "id",
  "name",
  "country",
  "tuition_min",
  "tuition_max",
  "tuition_source",
  "deadline",
  "deadline_source",
  "requirements",
  "requirements_source",
  "languages",
  "languages_source",
  "application_link",
];
const SCH_COLUMNS = [
  "type",
  "id",
  "name",
  "country",
  "deadline_date",
  "deadline_note",
  "deadline_source",
  "portal",
];
const SCH_ONLY = ["deadline_date", "deadline_note", "portal"];
const READ_ONLY = ["type", "name", "country"];

// ---- strict cell parsers ---------------------------------------------------

/**
 * Whole euros only. Accepts 12000, "12 000", "12,000", "12.000" (European
 * thousands), "€12000". Anything else — decimals, "12k", "free" — is rejected
 * rather than guessed.
 * @returns {number|null|undefined}  number, null = empty, undefined = invalid
 */
function parseMoneyCell(raw) {
  const t = String(raw == null ? "" : raw).replace(/[\s €]|EUR/gi, "");
  if (!t) return null;
  if (/^\d{1,3}([.,]\d{3})+$/.test(t)) return Number(t.replace(/[.,]/g, ""));
  if (/^\d+$/.test(t)) return Number(t);
  return undefined;
}

/**
 * ISO (2027-01-15) or Finnish-style (15.1.2027). Slashes are refused: 3/4/2027
 * is March 4th to one person and April 3rd to another, so it is never guessed.
 * @returns {string|null|undefined}  ISO date, null = empty, undefined = invalid
 */
function parseDateCell(raw) {
  const t = String(raw == null ? "" : raw).trim();
  if (!t) return null;
  let y, m, d;
  let mt = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (mt) [, y, m, d] = mt;
  else if ((mt = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/))) [, d, m, y] = mt;
  else return undefined;
  const dt = new Date(Date.UTC(+y, +m - 1, +d));
  if (
    dt.getUTCFullYear() !== +y ||
    dt.getUTCMonth() !== +m - 1 ||
    dt.getUTCDate() !== +d
  )
    return undefined; // 31 February etc.
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// ---- export ----------------------------------------------------------------

/**
 * @param {"university"|"scholarship"} kind
 * @param {{id:string}[]} records  the rows to export (from the admin list)
 * @param {{get:(type:string,id:string)=>any}} overlay
 * @param {{delimiter?:string}} [opts]
 */
function buildSheet(kind, records, overlay, { delimiter = ";" } = {}) {
  const cols = kind === "scholarship" ? SCH_COLUMNS : UNI_COLUMNS;
  const rows = [cols];
  for (const r of records) {
    const d = overlay.get(kind, r.id);
    if (!d) continue;
    const f = d.fields;
    if (kind === "scholarship") {
      rows.push([
        "scholarship",
        d.id,
        d.name,
        d.country,
        f.deadline.value || "",
        f.deadline.note || "",
        f.deadline.source || "",
        f.portal.value || "",
      ]);
      continue;
    }
    // Only confirmed values are pre-filled. An estimate stays blank on purpose.
    const confirmedTuition =
      f.tuition.status === "researched" || f.tuition.status === "edited";
    rows.push([
      "university",
      d.id,
      d.name,
      d.country,
      confirmedTuition && f.tuition.min != null ? f.tuition.min : "",
      confirmedTuition && f.tuition.max != null ? f.tuition.max : "",
      f.tuition.source || "",
      f.deadline.value || "",
      f.deadline.source || "",
      f.requirements.value || "",
      f.requirements.source || "",
      f.languages.status === "estimate"
        ? ""
        : (f.languages.value || []).join("; "),
      f.languages.source || "",
      f.application_link.value || "",
    ]);
  }
  return toCsv(rows, { delimiter });
}

// ---- import ----------------------------------------------------------------

const eur = (n) => "€" + Number(n).toLocaleString("en-US");

/** Compare a validated field with what the record has now. */
function differs(kind, key, next, cur) {
  const src = (cur.source || "") !== (next.source || "");
  if (kind === "university") {
    if (key === "tuition")
      return src || cur.min !== next.min || cur.max !== next.max;
    if (key === "languages")
      return (
        src || JSON.stringify(cur.value || []) !== JSON.stringify(next.value)
      );
    if (key === "application_link") return (cur.value || "") !== next.value;
    return src || (cur.value || "") !== next.value; // deadline, requirements
  }
  if (key === "deadline")
    return (
      src ||
      (cur.value || "") !== next.value ||
      (cur.note || "") !== (next.note || "")
    );
  return (cur.value || "") !== next.value; // portal
}

function describe(key, v) {
  if (key === "tuition")
    return `tuition ${v.min === v.max ? eur(v.min) : eur(v.min) + "–" + eur(v.max)}`;
  if (key === "deadline") return `deadline “${v.value || v.note}”`;
  if (key === "languages") return `languages ${v.value.join(", ")}`;
  if (key === "application_link" || key === "portal") return "link";
  return key;
}

/**
 * @param {string} text  the raw CSV
 * @param {{ get:(type:string,id:string)=>any }} overlay
 * @returns {{ok:false,error:string} | {
 *   ok:true, kind:string, delimiter:string, warnings:string[],
 *   rows:{line:number,id:string,name:string,status:string,changes:string[],errors:string[]}[],
 *   summary:{update:number,unchanged:number,empty:number,error:number},
 *   items:{type:string,id:string,patch:object}[] }}
 */
function planImport(text, overlay) {
  const parsed = parseCsv(text);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  if (!parsed.records.length)
    return {
      ok: false,
      error:
        "The file is empty. Download the template, fill it in, and upload that.",
    };

  const header = parsed.records[0].cells.map((h) =>
    unguard(h).trim().toLowerCase(),
  );
  const col = Object.fromEntries(header.map((h, i) => [h, i]).reverse()); // first occurrence wins
  if (col.id === undefined)
    return {
      ok: false,
      error:
        "The first row must be the column names, including “id”. Use the downloaded template.",
    };

  const hasSch = SCH_ONLY.some((c) => col[c] !== undefined);
  const hasUni = [
    "tuition_min",
    "tuition_max",
    "requirements",
    "languages",
    "application_link",
  ].some((c) => col[c] !== undefined);
  if (hasSch && hasUni)
    return {
      ok: false,
      error:
        "This file mixes university and scholarship columns. Use one template at a time.",
    };
  const kind = hasSch ? "scholarship" : "university";
  const known = new Set(kind === "scholarship" ? SCH_COLUMNS : UNI_COLUMNS);
  const warnings = [];
  const unknown = header.filter((h) => h && !known.has(h));
  if (unknown.length) warnings.push(`Ignored columns: ${unknown.join(", ")}.`);

  const cell = (cells, name) =>
    col[name] === undefined ? "" : unguard(cells[col[name]] || "").trim();
  const rows = [];
  const items = [];
  const seen = new Map();
  const summary = { update: 0, unchanged: 0, empty: 0, error: 0 };

  for (const rec of parsed.records.slice(1)) {
    const row = {
      line: rec.line,
      id: cell(rec.cells, "id"),
      name: cell(rec.cells, "name"),
      status: "",
      changes: [],
      errors: [],
    };
    const fail = (msg) => row.errors.push(msg);
    const finish = (status) => {
      row.status = status;
      summary[status]++;
      rows.push(row);
    };

    const rowType = cell(rec.cells, "type");
    if (rowType && rowType !== kind)
      fail(`This row says “${rowType}” but the file is a ${kind} sheet.`);
    if (!row.id) fail("No id on this row.");
    if (row.id && seen.has(row.id))
      fail(`This id also appears on line ${seen.get(row.id)}.`);
    if (row.id && !seen.has(row.id)) seen.set(row.id, rec.line);
    const current = row.id ? overlay.get(kind, row.id) : null;
    if (row.id && !current)
      fail(`Unknown ${kind} id “${row.id}”. Don't change the id column.`);
    if (current && !row.name) row.name = current.name;
    if (row.errors.length) {
      finish("error");
      continue;
    }

    // ---- cells → a patch, using the same shapes the editor sends ----
    const patch = {};
    const need = (cond, msg) => {
      if (!cond) fail(msg);
      return cond;
    };

    if (kind === "university") {
      const [tmin, tmax, tsrc] = [
        "tuition_min",
        "tuition_max",
        "tuition_source",
      ].map((c) => cell(rec.cells, c));
      if (tmin || tmax) {
        const a = parseMoneyCell(tmin);
        const b = parseMoneyCell(tmax);
        const bad = (v, label) =>
          v === undefined &&
          fail(
            `${label} must be a whole number of euros per year, like 12000 (no decimals, “k” or words — write 0 for no tuition).`,
          );
        bad(a, "tuition_min");
        bad(b, "tuition_max");
        if (
          need(
            a !== null,
            "tuition_min is empty (the highest figure needs a lowest one)",
          )
        )
          patch.tuition = { min: a, max: b == null ? a : b, source: tsrc };
      } else if (tsrc)
        fail("tuition_source is filled in but there is no tuition figure.");

      for (const [key, vcol, scol] of [
        ["deadline", "deadline", "deadline_source"],
        ["requirements", "requirements", "requirements_source"],
      ]) {
        const v = cell(rec.cells, vcol),
          s = cell(rec.cells, scol);
        if (v) patch[key] = { value: v, source: s };
        else if (s) fail(`${scol} is filled in but ${vcol} is empty.`);
      }
      const langs = cell(rec.cells, "languages"),
        lsrc = cell(rec.cells, "languages_source");
      if (langs)
        patch.languages = {
          value: langs
            .split(/[;,|/]/)
            .map((x) => x.trim())
            .filter(Boolean),
          source: lsrc,
        };
      else if (lsrc)
        fail("languages_source is filled in but languages is empty.");
      const link = cell(rec.cells, "application_link");
      if (link) patch.application_link = { value: link };
    } else {
      const date = cell(rec.cells, "deadline_date"),
        note = cell(rec.cells, "deadline_note"),
        src = cell(rec.cells, "deadline_source");
      if (date || note) {
        const iso = parseDateCell(date);
        if (iso === undefined)
          fail(
            `deadline_date “${date}” isn't a date I can read safely. Use 2027-01-15 or 15.1.2027.`,
          );
        else patch.deadline = { value: iso || "", note, source: src };
      } else if (src)
        fail("deadline_source is filled in but there is no deadline.");
      const portal = cell(rec.cells, "portal");
      if (portal) patch.portal = { value: portal };
    }
    if (row.errors.length) {
      finish("error");
      continue;
    }
    if (!Object.keys(patch).length) {
      finish("empty");
      continue;
    }

    // ---- drop what is identical to what the record already has. This must come
    // BEFORE validation: a hand-researched record has no source link on file, and
    // re-uploading it untouched must read as "unchanged", not "needs a source".
    for (const key of Object.keys(patch)) {
      if (!differs(kind, key, patch[key], current.fields[key]))
        delete patch[key];
    }
    if (!Object.keys(patch).length) {
      finish("unchanged");
      continue;
    }

    // ---- the same rules as the editor, including "no source, no number" ----
    const v = validate(kind, patch);
    if (!v.ok) {
      fail(v.field ? `${v.field}: ${v.error}` : v.error);
      finish("error");
      continue;
    }
    for (const [key, val] of Object.entries(v.value))
      row.changes.push(describe(key, val));
    items.push({ type: kind, id: row.id, patch: v.value });
    finish("update");
  }

  return {
    ok: true,
    kind,
    delimiter: parsed.delimiter,
    warnings,
    rows,
    summary,
    items,
  };
}

module.exports = {
  buildSheet,
  planImport,
  parseMoneyCell,
  parseDateCell,
  UNI_COLUMNS,
  SCH_COLUMNS,
  READ_ONLY,
};
