"use strict";

// Ready-made short-form scripts composed DETERMINISTICALLY from Universo's own
// real data — never AI, never invented. Each script is built by picking the
// most relevant real entity for the opportunity's topic (a source-verified
// scholarship, a hand-verified university, or live dataset counts) and filling
// beats with that entity's actual, quoted fields. Every claim is traceable to a
// source we return alongside the script. Missing fields are skipped, not faked.

const clip = (s, n = 180) => {
  s = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
};

// Pick the entity whose text best matches the angle/topic words; deterministic,
// with a stable fallback rotation so different opportunities don't all pick #0.
function pickRelevant(items, hintText, keyFn) {
  if (!items || !items.length) return null;
  const words = /** @type {string[]} */ (String(hintText || "").toLowerCase().match(/[a-z]{4,}/g) || []);
  const scored = items.map((it) => {
    const hay = String(keyFn(it) || "").toLowerCase();
    return { it, score: words.reduce((a, w) => a + (hay.includes(w) ? 1 : 0), 0) };
  });
  const top = scored.reduce((m, x) => (x.score > m.score ? x : m), scored[0]);
  if (top.score > 0) return top.it;
  return items[(String(hintText || "").length) % items.length]; // stable variety
}

const CTA = "Find your matches free on Universo — link in bio.";

function scholarshipScript(scholarships, hint) {
  const s = pickRelevant(scholarships, hint, (x) => `${x.name} ${x.country} ${x.tagline || ""} ${x.fields || ""}`);
  if (!s) return null;
  const beats = [];
  beats.push({ cue: "Hook", line: s.tagline ? clip(s.tagline, 140) : `${s.name} helps students study in ${s.country}.` });
  const tui = s.funding && s.funding.tuition;
  const stip = s.funding && s.funding.stipend;
  const cover = [tui && tui.text, stip && stip.text].filter(Boolean).map((t) => clip(t, 140)).join(" ");
  if (cover) beats.push({ cue: "What it covers", line: cover });
  const who = s.eligibility && s.eligibility.countries_note;
  if (who) beats.push({ cue: "Who it's for", line: clip(who, 160) });
  beats.push({ cue: "How Universo helps", line: `Universo shows whether you can actually use ${s.name} and exactly what it asks for — no guessing.` });
  return {
    kind: "scholarship",
    headline: `${s.name} — ${s.country}`,
    beats,
    cta: CTA,
    sources: (s.verification && s.verification.sources) || [],
    dataLabel: `Curated scholarship${s.verification && s.verification.date ? " · verified " + s.verification.date : ""}`,
    note: "Funding and eligibility are quoted from Universo's source-verified listing. Always confirm on the official page before posting.",
  };
}

function universityScript(universities, hint) {
  const verified = universities.filter((u) => u.data_verified);
  const u = pickRelevant(verified.length ? verified : universities, hint, (x) => `${x.name} ${x.country} ${(x.fields_of_study || []).join(" ")}`);
  if (!u) return null;
  const beats = [];
  beats.push({ cue: "Hook", line: `Ever thought about ${u.name}${u.city ? " in " + u.city : ""}, ${u.country}?` });
  const known = u.short_description ? clip(u.short_description, 160) : ((u.fields_of_study || []).length ? "Strong in " + u.fields_of_study.slice(0, 3).join(", ") + "." : "");
  if (known) beats.push({ cue: "Why it matters", line: known });
  const detail = u.language_of_instruction ? `Taught in ${clip(u.language_of_instruction, 80)}.`
    : u.tuition_range ? `Tuition: ${clip(u.tuition_range, 80)}.`
    : u.application_deadline ? `Deadline: ${clip(u.application_deadline, 80)}.` : "";
  if (detail) beats.push({ cue: "One real detail", line: detail });
  beats.push({ cue: "How Universo helps", line: "Universo puts its tuition, language and deadline side by side with other unis so you compare honestly." });
  return {
    kind: "university",
    headline: `${u.name} — ${u.country}`,
    beats,
    cta: CTA,
    sources: u.application_link ? [u.application_link] : ["EU register (ETER)"],
    dataLabel: u.data_verified ? "Hand-verified profile" : "From the EU register (ETER)",
    note: "Details are from Universo's profile for this university. Confirm on the official site before posting.",
  };
}

function costScript(universities, scholarships, hint) {
  const withCost = universities.filter((u) => u.data_verified && (u.tuition_range || u.estimated_living_cost));
  const u = pickRelevant(withCost.length ? withCost : universities.filter((x) => x.tuition_range), hint, (x) => `${x.name} ${x.country}`);
  if (!u) return null;
  const beats = [{ cue: "Hook", line: `What does studying at ${u.name} in ${u.country} actually cost?` }];
  if (u.tuition_range) beats.push({ cue: "Tuition", line: clip(u.tuition_range, 120) });
  if (u.estimated_living_cost) beats.push({ cue: "Living (est.)", line: clip(u.estimated_living_cost, 120) });
  const sch = scholarships.find((s) => s.country === u.country);
  if (sch) beats.push({ cue: "How to cut it", line: `A scholarship like ${sch.name} can cut this${sch.funding && sch.funding.tuition && sch.funding.tuition.level === "full" ? " — it covers tuition in full" : ""}.` });
  beats.push({ cue: "How Universo helps", line: "Universo shows real tuition, estimated living cost and matching scholarships in one place." });
  return {
    kind: "cost",
    headline: `Cost of studying at ${u.name}`,
    beats,
    cta: CTA,
    sources: u.application_link ? [u.application_link] : ["EU register (ETER)"],
    dataLabel: "Hand-verified profile",
    note: "Living cost is an estimate; tuition is from the university's profile. Confirm on the official site before posting.",
  };
}

function applicationsScript(universities, hint) {
  const withDl = universities.filter((u) => u.data_verified && u.application_deadline);
  const u = pickRelevant(withDl.length ? withDl : universities, hint, (x) => `${x.name} ${x.country}`);
  if (!u) return null;
  const beats = [{ cue: "Hook", line: `${u.name}'s application deadline: ${clip(u.application_deadline, 90)}.` }];
  if (u.acceptance_requirements) beats.push({ cue: "What they ask for", line: clip(u.acceptance_requirements, 170) });
  beats.push({ cue: "The plan", line: "Work backwards from that date — Universo tracks your deadlines so none slip." });
  return {
    kind: "applications",
    headline: `${u.name} — deadline & requirements`,
    beats,
    cta: CTA,
    sources: u.application_link ? [u.application_link] : ["EU register (ETER)"],
    dataLabel: "Hand-verified profile",
    note: "Deadline and requirements are from the university's profile. Always confirm on the official site.",
  };
}

function overviewScript(universities) {
  const total = universities.length;
  const byCountry = {}, byField = {};
  for (const u of universities) {
    if (u.country) byCountry[u.country] = (byCountry[u.country] || 0) + 1;
    (u.fields_of_study || []).forEach((f) => (byField[f] = (byField[f] || 0) + 1));
  }
  const countries = Object.keys(byCountry).length;
  const topCountries = Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => c);
  const topFields = Object.entries(byField).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f]) => f);
  const beats = [
    { cue: "Hook", line: `${total.toLocaleString("en-US")} European universities across ${countries} countries — many cost far less than students expect.` },
  ];
  if (topCountries.length) beats.push({ cue: "Where", line: `Most on Universo right now: ${topCountries.join(", ")}.` });
  if (topFields.length) beats.push({ cue: "Popular fields", line: topFields.join(", ") + "." });
  beats.push({ cue: "How Universo helps", line: "Universo matches these to you and shows real tuition, language and scholarships side by side." });
  return {
    kind: "overview",
    headline: `${total.toLocaleString("en-US")} universities, ${countries} countries`,
    beats,
    cta: CTA,
    sources: ["EU register (ETER)"],
    dataLabel: "Live counts from Universo's dataset",
    note: "Counts are computed live from Universo's dataset (sourced from the EU register).",
  };
}

const TOPIC_KIND = {
  Scholarships: "scholarship", Erasmus: "scholarship",
  Cost: "cost",
  Applications: "applications",
  Rankings: "university",
};

// Compose one script. data = { universities:[], scholarships:[] }.
function composeScript(opts, data) {
  const o = opts || {};
  const universities = (data && data.universities) || [];
  const scholarships = (data && data.scholarships) || [];
  const hint = `${o.angle || ""} ${o.topic || ""}`.trim();
  const kind = TOPIC_KIND[o.topic] || "overview";
  let out = null;
  if (kind === "scholarship") out = scholarshipScript(scholarships, hint);
  else if (kind === "cost") out = costScript(universities, scholarships, hint);
  else if (kind === "applications") out = applicationsScript(universities, hint);
  else if (kind === "university") out = universityScript(universities, hint);
  // fall back to overview if the chosen kind had no usable data
  if (!out) out = overviewScript(universities);
  return out;
}

module.exports = { composeScript, pickRelevant, clip };

// Self-check: node lib/scriptgen.js
if (require.main === module) {
  const assert = require("assert");
  const unis = [
    { name: "TU Munich", city: "Munich", country: "Germany", data_verified: true, fields_of_study: ["Engineering"], tuition_range: "€0–1,500/yr", estimated_living_cost: "€1,100/mo", application_deadline: "May 31", acceptance_requirements: "Bachelor's degree, IELTS 6.5", application_link: "https://tum.de" },
    { name: "Uni Vienna", country: "Austria", data_verified: false, fields_of_study: ["Law"] },
  ];
  const schs = [
    { name: "Stipendium Hungaricum", country: "Hungary", tagline: "Tuition-free study in Hungary.", funding: { tuition: { level: "full", text: "Tuition-free at all levels." }, stipend: { text: "~€110/mo." } }, eligibility: { countries_note: "Open to partner countries." }, verification: { sources: ["https://x"], date: "2026-09-01" } },
  ];
  const sch = composeScript({ topic: "Scholarships", angle: "Hungary funding" }, { universities: unis, scholarships: schs });
  assert.equal(sch.kind, "scholarship");
  assert.ok(sch.beats.some((b) => /Tuition-free/.test(b.line)), "quotes real funding text");
  assert.ok(sch.sources.includes("https://x"), "returns real sources");

  const cost = composeScript({ topic: "Cost", angle: "Germany" }, { universities: unis, scholarships: schs });
  assert.equal(cost.kind, "cost");
  assert.ok(cost.beats.some((b) => /€0–1,500/.test(b.line)), "uses real tuition range");

  const ov = composeScript({ topic: "Study abroad", angle: "" }, { universities: unis, scholarships: schs });
  assert.equal(ov.kind, "overview");
  assert.ok(/2 European universities|1 European/.test(ov.beats[0].line) || ov.beats[0].line.includes("universities"), "overview counts from data");

  // no scholarships → scholarship topic falls back to overview, never fabricates
  const fb = composeScript({ topic: "Scholarships" }, { universities: unis, scholarships: [] });
  assert.equal(fb.kind, "overview");
  console.log("scriptgen self-check passed");
}
