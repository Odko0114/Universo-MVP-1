"use strict";

/**
 * Minimal CSV reader/writer — no dependency, RFC 4180 quoting.
 *
 * Built for spreadsheets that people really use:
 *  - Excel in Finland/Europe saves with SEMICOLONS (because the comma is its
 *    decimal mark), Google Sheets and US Excel with commas, some tools with tabs.
 *    The delimiter is detected from the header row.
 *  - Excel writes a UTF-8 byte-order mark; it is stripped on read and added on
 *    write (without it Excel garbles accents).
 *  - Quoted cells may contain delimiters, doubled quotes and line breaks.
 *
 * Output cells are guarded against spreadsheet formula injection: a cell that
 * starts with = + - @ is written with a leading apostrophe, so opening an export
 * in Excel never executes text a stranger put in (e.g. a lead's message).
 */

const MAX_ROWS = 5000;
const MAX_CELL = 5000;

/** Pick the delimiter used by the first non-empty line (outside quotes). */
function detectDelimiter(text) {
  let counts = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes) {
      if (c === "\n" || c === "\r") {
        if (counts[","] + counts[";"] + counts["\t"] > 0) break; // header line done
        continue; // skip leading blank lines
      }
      if (c in counts) counts[c]++;
    }
  }
  // Ties go to the comma, the most common default.
  return [";", "\t"].reduce(
    (best, d) => (counts[d] > counts[best] ? d : best),
    ",",
  );
}

/**
 * @param {string} input
 * @returns {{ delimiter: string, records: { line: number, cells: string[] }[] } | { error: string }}
 */
function parseCsv(input) {
  let text = String(input == null ? "" : input);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delimiter = detectDelimiter(text);

  const records = [];
  let cells = [];
  let cell = "";
  let inQuotes = false;
  let line = 1; // physical line currently being read
  let startLine = 1; // line the current record began on
  let quotedStart = 0;

  const endCell = () => {
    if (cell.length > MAX_CELL)
      throw new Error(
        `A cell on line ${startLine} is longer than ${MAX_CELL} characters.`,
      );
    cells.push(cell);
    cell = "";
  };
  const endRecord = () => {
    endCell();
    if (cells.some((c) => c.trim() !== ""))
      records.push({ line: startLine, cells });
    if (records.length > MAX_ROWS)
      throw new Error(`The file has more than ${MAX_ROWS} rows.`);
    cells = [];
  };

  try {
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            cell += '"';
            i++;
          } else inQuotes = false;
        } else {
          if (c === "\n") line++;
          cell += c;
        }
        continue;
      }
      if (c === '"' && cell === "") {
        inQuotes = true;
        quotedStart = line;
      } else if (c === delimiter) endCell();
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        endRecord();
        line++;
        startLine = line;
      } else cell += c;
    }
    if (inQuotes)
      return {
        error: `A quoted cell that starts on line ${quotedStart} is never closed.`,
      };
    if (cell !== "" || cells.length) endRecord();
  } catch (e) {
    return { error: e.message };
  }
  return { delimiter, records };
}

/** Neutralise spreadsheet formulas, then quote only when needed. */
function cellOut(value, delimiter) {
  let s = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (
    s.includes(delimiter) ||
    s.includes('"') ||
    /[\r\n]/.test(s) ||
    /^\s|\s$/.test(s)
  )
    s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * @param {(string|number|null|undefined)[][]} rows
 * @param {{ delimiter?: string, bom?: boolean }} [opts]
 */
function toCsv(rows, { delimiter = ",", bom = true } = {}) {
  const body =
    rows
      .map((r) => r.map((v) => cellOut(v, delimiter)).join(delimiter))
      .join("\r\n") + "\r\n";
  return (bom ? "﻿" : "") + body;
}

/** Undo the apostrophe cellOut() adds in front of = + - @ (so exports round-trip). */
const unguard = (s) => String(s).replace(/^'(?=[=+\-@\t\r])/, "");

module.exports = {
  parseCsv,
  toCsv,
  detectDelimiter,
  unguard,
  MAX_ROWS,
  MAX_CELL,
};
