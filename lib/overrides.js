"use strict";

/**
 * Admin-edited facts, layered OVER the derived data.
 *
 * Why an overlay: `universities` is rebuilt from data/seed/* at every boot (so a
 * deploy can never serve stale seed data), and scholarships live in a committed
 * JSON file. Editing either in place would be wiped on the next deploy. So edits
 * live in their own persistent collection (`opportunity_overrides`) and are
 * re-applied on top at boot and after every save.
 *
 * Honesty rule, enforced here and not only in the UI: any figure, date, score
 * or language claim must carry a source URL, or it is rejected. An empty field
 * is better than a guess, and a source-less number never reaches a student.
 *
 * Stored shape (opportunity_overrides.json):
 *   { university: { [id]:  { fields:{…}, verified_at, verified_by } },
 *     scholarship:{ [key]: { fields:{…}, verified_at, verified_by } },
 *     log: [ { ts, by, type, id, name, action, fields:[label…] } ] }
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const URL_RE = /^https?:\/\/[^\s<>"']{3,300}$/i;
const LANG_RE = /^[A-Za-z][A-Za-z \-]{1,28}$/;
const LOG_CAP = 300;

const LABELS = {
  tuition: "tuition",
  deadline: "deadline",
  requirements: "requirements",
  languages: "teaching language",
  application_link: "application link",
  portal: "application link",
};

// Original values of every field an override can touch, captured before the
// first edit so a "revert" restores exactly what the seed said.
const UNI_KEYS = [
  "tuition_range",
  "tuition_intl_min",
  "tuition_intl_max",
  "tuition_source",
  "application_deadline",
  "acceptance_requirements",
  "language_of_instruction",
  "language_estimated",
  "application_link",
  "sources",
  "last_verified_at",
  "last_updated_at",
];
const SCH_KEYS = ["application", "verification"];

const clone = (v) =>
  v === undefined ? undefined : JSON.parse(JSON.stringify(v));
const today = (now) => now().toISOString().slice(0, 10);

function snapshot(obj, keys) {
  const s = {};
  for (const k of keys) if (k in obj) s[k] = clone(obj[k]);
  return s;
}
function restore(obj, snap, keys) {
  for (const k of keys) {
    if (k in snap) obj[k] = clone(snap[k]);
    else delete obj[k];
  }
}

// ---- validation -----------------------------------------------------------

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function cleanSource(v) {
  const s = str(v, 300);
  return URL_RE.test(s) ? s : "";
}
function cleanUrl(v) {
  const s = str(v, 300);
  return URL_RE.test(s) ? s : "";
}
function money(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[, €]/g, ""));
  if (!Number.isFinite(n) || n < 0 || n > 200000) return NaN;
  return Math.round(n);
}

const NEED_SOURCE =
  "Add a source link (the official page this came from) to save this.";

const VALIDATORS = {
  university: {
    tuition(p) {
      const min = money(p.min);
      const max = p.max === "" || p.max == null ? min : money(p.max);
      if (min === null || Number.isNaN(min) || Number.isNaN(max))
        return {
          error:
            "Tuition must be a number between 0 and 200,000 (euros per year).",
        };
      if (max < min)
        return { error: "The highest tuition can't be lower than the lowest." };
      const source = cleanSource(p.source);
      if (!source) return { error: NEED_SOURCE };
      return { value: { min, max, source } };
    },
    deadline(p) {
      const value = str(p.value, 120);
      if (!value) return { error: "Enter the deadline, or revert this field." };
      const source = cleanSource(p.source);
      if (!source) return { error: NEED_SOURCE };
      return { value: { value, source } };
    },
    requirements(p) {
      const value = str(p.value, 1200);
      if (!value)
        return { error: "Enter the requirements, or revert this field." };
      const source = cleanSource(p.source);
      if (!source) return { error: NEED_SOURCE };
      return { value: { value, source } };
    },
    languages(p) {
      const list = (
        Array.isArray(p.value) ? p.value : String(p.value || "").split(",")
      )
        .map((x) => String(x).trim())
        .filter(Boolean);
      if (
        !list.length ||
        list.length > 8 ||
        !list.every((x) => LANG_RE.test(x))
      )
        return { error: "Enter up to 8 languages, e.g. English, German." };
      const source = cleanSource(p.source);
      if (!source) return { error: NEED_SOURCE };
      return { value: { value: [...new Set(list)], source } };
    },
    application_link(p) {
      const value = cleanUrl(p.value);
      if (!value)
        return {
          error: "That isn't a valid link (it must start with https://).",
        };
      return { value: { value } };
    },
  },
  scholarship: {
    deadline(p) {
      const value = str(p.value, 10);
      const note = str(p.note, 240);
      if (value && !DATE_RE.test(value))
        return {
          error:
            "Use the date format YYYY-MM-DD, or leave it empty and use the note.",
        };
      if (!value && !note)
        return {
          error: "Enter a deadline date or a note, or revert this field.",
        };
      const source = cleanSource(p.source);
      if (!source) return { error: NEED_SOURCE };
      return { value: { value, note, source } };
    },
    portal(p) {
      const value = cleanUrl(p.value);
      if (!value)
        return {
          error: "That isn't a valid link (it must start with https://).",
        };
      return { value: { value } };
    },
  },
};

/**
 * @param {"university"|"scholarship"} type
 * @param {Record<string, any>} patch  { field: {…}|null } — null reverts a field
 * @returns {{ok:boolean, value?:Record<string,any>, error?:string, field?:string}}
 */
function validate(type, patch) {
  const defs = VALIDATORS[type];
  if (!defs) return { ok: false, error: "Unknown record type." };
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    return { ok: false, error: "Nothing to save." };
  const keys = Object.keys(patch);
  if (!keys.length) return { ok: false, error: "Nothing to save." };
  const out = {};
  for (const k of keys) {
    if (!defs[k]) return { ok: false, error: `"${k}" can't be edited here.` };
    if (patch[k] === null) {
      out[k] = null;
      continue;
    }
    if (typeof patch[k] !== "object" || Array.isArray(patch[k]))
      return { ok: false, error: `Invalid value for ${LABELS[k] || k}.` };
    const r = defs[k](patch[k]);
    if (r.error) return { ok: false, error: r.error, field: k };
    out[k] = r.value;
  }
  return { ok: true, value: out };
}

// ---- the overlay ----------------------------------------------------------

/**
 * @param {object} o
 * @param {{university?:object,scholarship?:object,log?:object[]}} o.doc  persisted document (mutated)
 * @param {object[]} o.universities  LIVE dataset records (mutated in place)
 * @param {object[]} o.scholarships  LIVE curated scholarships (mutated in place)
 * @param {() => any} o.persist  write the doc to disk
 * @param {() => Date} [o.now]
 */
function createOverrides({
  doc,
  universities,
  scholarships,
  persist,
  now = () => new Date(),
}) {
  doc.university = doc.university || {};
  doc.scholarship = doc.scholarship || {};
  doc.log = Array.isArray(doc.log) ? doc.log : [];

  const uniById = new Map(universities.map((u) => [u.id, u]));
  const schByKey = new Map(scholarships.map((s) => [s.key, s]));
  const origUni = new Map();
  const origSch = new Map();

  const target = (type, id) =>
    type === "university" ? uniById.get(id) : schByKey.get(id);

  function rebuildUniversity(u) {
    if (!origUni.has(u.id)) origUni.set(u.id, snapshot(u, UNI_KEYS));
    const snap = origUni.get(u.id);
    restore(u, snap, UNI_KEYS);
    const ov = doc.university[u.id];
    if (!ov || !ov.fields) return;
    const f = ov.fields;
    const src = {};
    if (f.tuition) {
      const { min, max, source } = f.tuition;
      const base = clone(snap.tuition_range) || {};
      delete base.estimated;
      delete base.note;
      u.tuition_range = { ...base, min, max, currency: "EUR", period: "year" };
      u.tuition_intl_min = min;
      u.tuition_intl_max = max;
      // Every student-facing tuition display is gated on this value — setting it
      // is what turns "estimate" into "verified from an official page".
      u.tuition_source = "curated_research";
      src.tuition = source;
    }
    if (f.deadline) {
      u.application_deadline = f.deadline.value;
      src.deadline = f.deadline.source;
    }
    if (f.requirements) {
      u.acceptance_requirements = f.requirements.value;
      src.requirements = f.requirements.source;
    }
    if (f.languages) {
      u.language_of_instruction = [...f.languages.value];
      u.language_estimated = false;
      src.languages = f.languages.source;
    }
    if (f.application_link) u.application_link = f.application_link.value;
    if (Object.keys(src).length)
      u.sources = { ...(clone(snap.sources) || {}), ...src };
    if (ov.verified_at) u.last_verified_at = ov.verified_at;
    if (ov.updated_at) u.last_updated_at = ov.updated_at;
  }

  function rebuildScholarship(s) {
    if (!origSch.has(s.key)) origSch.set(s.key, snapshot(s, SCH_KEYS));
    const snap = origSch.get(s.key);
    restore(s, snap, SCH_KEYS);
    const ov = doc.scholarship[s.key];
    if (!ov || !ov.fields) return;
    const f = ov.fields;
    s.application = { ...(clone(snap.application) || {}) };
    if (f.deadline) {
      s.application.deadline = f.deadline.value;
      s.application.deadline_note = f.deadline.note;
    }
    if (f.portal) s.application.portal = f.portal.value;
    const v = { ...(clone(snap.verification) || {}) };
    const sources = new Set(v.sources || []);
    if (f.deadline && f.deadline.source) sources.add(f.deadline.source);
    if (sources.size) v.sources = [...sources];
    if (ov.verified_at) {
      v.date = ov.verified_at;
      v.status = "verified";
    }
    s.verification = v;
  }

  const rebuild = (type, rec) =>
    type === "university" ? rebuildUniversity(rec) : rebuildScholarship(rec);

  function applyAll() {
    for (const [id] of Object.entries(doc.university)) {
      const u = uniById.get(id);
      if (u) rebuildUniversity(u);
    }
    for (const [key] of Object.entries(doc.scholarship)) {
      const s = schByKey.get(key);
      if (s) rebuildScholarship(s);
    }
  }

  function addLog(entry) {
    doc.log.unshift({ ts: now().toISOString(), ...entry });
    if (doc.log.length > LOG_CAP) doc.log.length = LOG_CAP;
  }

  const nameOf = (type, rec) => rec.name || rec.key || rec.id;

  /** Save validated field edits (or reverts) for one record. */
  function save(type, id, patch, by) {
    const rec = target(type, id);
    if (!rec) return { ok: false, status: 404, error: "Record not found." };
    const v = validate(type, patch);
    if (!v.ok)
      return { ok: false, status: 400, error: v.error, field: v.field };

    const store = type === "university" ? doc.university : doc.scholarship;
    const ov = store[id] || { fields: {} };
    const stamp = now().toISOString();
    const changed = [];
    let sourced = false;
    for (const [k, val] of Object.entries(v.value)) {
      if (val === null) {
        if (ov.fields[k]) {
          delete ov.fields[k];
          changed.push(`reverted ${LABELS[k] || k}`);
        }
        continue;
      }
      ov.fields[k] = { ...val, at: stamp, by };
      changed.push(LABELS[k] || k);
      if (val.source) sourced = true;
    }
    if (!changed.length)
      return { ok: true, record: get(type, id), unchanged: true };
    ov.updated_at = today(now);
    // A save that carries a source means someone checked it — that is a verification.
    if (sourced) {
      ov.verified_at = today(now);
      ov.verified_by = by;
    }
    if (Object.keys(ov.fields).length) store[id] = ov;
    else delete store[id];
    rebuild(type, rec);
    addLog({
      by,
      type,
      id,
      name: nameOf(type, rec),
      action: "edit",
      fields: changed,
    });
    persist();
    return { ok: true, record: get(type, id) };
  }

  /** "I re-checked it and it's still right" — stamps the verification date. */
  function verify(type, id, by) {
    const rec = target(type, id);
    if (!rec) return { ok: false, status: 404, error: "Record not found." };
    const store = type === "university" ? doc.university : doc.scholarship;
    const ov = store[id] || { fields: {} };
    ov.verified_at = today(now);
    ov.verified_by = by;
    ov.updated_at = ov.verified_at;
    store[id] = ov;
    rebuild(type, rec);
    addLog({
      by,
      type,
      id,
      name: nameOf(type, rec),
      action: "verify",
      fields: [],
    });
    persist();
    return { ok: true, record: get(type, id) };
  }

  /** When a person last confirmed this record ("" = never). */
  function verifiedAt(type, id) {
    const ov = (type === "university" ? doc.university : doc.scholarship)[id];
    if (ov && ov.verified_at) return ov.verified_at;
    const rec = target(type, id);
    if (!rec) return "";
    if (type === "scholarship") {
      const snap = origSch.get(id);
      return ((snap ? snap.verification : rec.verification) || {}).date || "";
    }
    // Hand-researched (curated) profiles carry a real verification date; for
    // register (ETER) records `last_verified_at` is just the register's reference
    // year, which is not a human check.
    if (rec.source === "curated") {
      const snap = origUni.get(id);
      return (snap ? snap.last_verified_at : rec.last_verified_at) || "";
    }
    return "";
  }

  const overrideFor = (type, id) =>
    (type === "university" ? doc.university : doc.scholarship)[id] || null;

  /** Editable view of one record: current value, where it came from, source. */
  function get(type, id) {
    const rec = target(type, id);
    if (!rec) return null;
    const ov = overrideFor(type, id);
    const f = (ov && ov.fields) || {};
    const log = doc.log
      .filter((l) => l.type === type && l.id === id)
      .slice(0, 5);
    const base = {
      type,
      id,
      name: nameOf(type, rec),
      country: rec.country || "",
      verified_at: verifiedAt(type, id),
      verified_by:
        (ov && ov.verified_by) || (rec.source === "curated" ? "research" : ""),
      log,
    };
    if (type === "scholarship") {
      const a = rec.application || {};
      return {
        ...base,
        fields: {
          deadline: {
            value: a.deadline || "",
            note: a.deadline_note || "",
            source: (f.deadline && f.deadline.source) || "",
            status: f.deadline
              ? "edited"
              : a.deadline || a.deadline_note
                ? "set"
                : "missing",
            edited: !!f.deadline,
          },
          portal: {
            value: a.portal || "",
            status: f.portal ? "edited" : a.portal ? "set" : "missing",
            edited: !!f.portal,
          },
        },
      };
    }
    const sources = rec.sources || {};
    const t = rec.tuition_range;
    const researched = rec.tuition_source === "curated_research";
    return {
      ...base,
      city: rec.city || "",
      featured: !!rec.verified,
      fields: {
        tuition: {
          // Never pre-fill a country-level estimate: showing it in the box invites
          // saving it as if it were a checked figure.
          min: researched && t ? t.min : null,
          max: researched && t ? t.max : null,
          estimate: !researched && t ? { min: t.min, max: t.max } : null,
          source: sources.tuition || "",
          status: f.tuition
            ? "edited"
            : researched
              ? "researched"
              : t
                ? "estimate"
                : "missing",
          edited: !!f.tuition,
        },
        deadline: {
          value: rec.application_deadline || "",
          source: sources.deadline || "",
          status: f.deadline
            ? "edited"
            : rec.application_deadline
              ? "set"
              : "missing",
          edited: !!f.deadline,
        },
        requirements: {
          value: rec.acceptance_requirements || "",
          source: sources.requirements || "",
          status: f.requirements
            ? "edited"
            : rec.acceptance_requirements
              ? "set"
              : "missing",
          edited: !!f.requirements,
        },
        languages: {
          value: rec.language_estimated
            ? []
            : rec.language_of_instruction || [],
          estimate: rec.language_estimated
            ? rec.language_of_instruction || []
            : null,
          source: sources.languages || "",
          status: f.languages
            ? "edited"
            : rec.language_estimated
              ? "estimate"
              : "set",
          edited: !!f.languages,
        },
        application_link: {
          value: rec.application_link || "",
          status: f.application_link
            ? "edited"
            : rec.application_link
              ? "set"
              : "missing",
          edited: !!f.application_link,
        },
      },
    };
  }

  const recentLog = (n = 10) => doc.log.slice(0, n);

  return {
    applyAll,
    save,
    verify,
    get,
    verifiedAt,
    overrideFor,
    recentLog,
    validate,
  };
}

module.exports = { createOverrides, validate, LABELS };
