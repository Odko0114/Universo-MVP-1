"use strict";

/**
 * Match-explanation layer.
 *
 * The DEFAULT, always-on output is a structured, honest line built purely from
 * the match components that actually fired (lib/match.js) — no model, no cost,
 * no latency, and impossible to hallucinate because it only ever restates real
 * data. That's also the spec's designated fallback, so it's what ships live.
 *
 * The LLM path (one cached sentence per student-profile × university) is fully
 * wired but OFF until an API key is present. It never runs per page load: an
 * explanation is generated when a profile or a university's matched data
 * changes, cached, and served from cache thereafter. With no key configured,
 * generate() simply returns the structured line — a drop-in seam, no behaviour
 * change until you switch it on.
 */

const crypto = require("crypto");

const LLM_KEY =
  process.env.UNIVERSO_LLM_KEY || process.env.ANTHROPIC_API_KEY || "";
const LLM_ENABLED = !!LLM_KEY;

// Short chip labels for the compressed per-card reason and the anonymous /
// no-personalization fallback.
function tags(components) {
  return (components || []).map((c) => {
    switch (c.key) {
      case "field":
        return c.label.replace(/^Offers /, ""); // "Computer Science"
      case "city":
        return c.label.replace(/^In a |^In an /, ""); // "mid-size city"
      case "country":
        return c.label.replace(/ \(a country you picked\)$/, "");
      case "verified":
        return "Verified profile";
      case "budget":
        return c.label; // "In your budget" / "No tuition fee"
      default:
        return c.label;
    }
  });
}

/**
 * The structured one-line explanation shown on the profile page (and used as
 * the LLM fallback). Honest when the overlap is thin, per the spec.
 * @param {object[]} components  fired soft-score components
 * @param {string[]} [flags]     unconfirmed-data notes from the hard filters
 */
function structuredLine(components, flags = []) {
  const t = tags(components);
  const flagNote = flags.includes("tuition_unconfirmed")
    ? " Tuition isn’t confirmed for this university yet — check the official site."
    : "";

  if (t.length === 0) {
    return (
      "No strong matches to your profile yet — the details below can still help you compare." +
      flagNote
    );
  }
  if (t.length === 1) {
    return `Limited overlap with your profile — mainly: ${t[0]}.` + flagNote;
  }
  // 2+ real matches: state them plainly, no "perfect match" fluff.
  const last = t[t.length - 1];
  const head = t.slice(0, -1).join(", ");
  return `Fits your profile: ${head} and ${last}.` + flagNote;
}

/** Compressed single reason for a Discover list item (the ranking is self-explanatory). */
function compressedReason(components) {
  const t = tags(components);
  if (!t.length) return "";
  return t.slice(0, 2).join(" · ");
}

// ---- LLM seam (dormant until a key is configured) --------------------------

const cache = new Map(); // key -> sentence
const keyFor = (student, uni, components) =>
  crypto
    .createHash("sha1")
    .update(
      JSON.stringify([
        student.fields_of_interest,
        student.degree_level,
        student.budget_max_eur_year,
        student.preferred_languages,
        student.city_preference,
        student.country_preference,
        uni.id,
        components.map((c) => c.key),
      ]),
    )
    .digest("hex");

/**
 * Return a one-sentence explanation. With no API key this is the structured
 * line (instant). With a key it would return a cached model sentence, generating
 * on cache-miss. Written so enabling it is purely an env-var change.
 */
async function generate(student, uni, components, flags = []) {
  if (!LLM_ENABLED) return structuredLine(components, flags);

  const k = keyFor(student, uni, components);
  if (cache.has(k)) return cache.get(k);

  try {
    const sentence = await callModel(student, uni, components); // eslint-disable-line no-use-before-define
    cache.set(k, sentence);
    return sentence;
  } catch {
    // Any model failure falls back to the honest structured line.
    return structuredLine(components, flags);
  }
}

/**
 * The actual model call. Intentionally minimal and only reached when
 * LLM_ENABLED. Uses the current Anthropic Messages API shape; the system
 * instruction pins it to citing only matched attributes.
 */
async function callModel(student, uni, components) {
  const system =
    "Given a student profile and a matched university's specific matching attributes, write one sentence " +
    "(max 25 words) explaining why this university fits this student. Only reference attributes explicitly " +
    'listed as matched. Do not use generic phrases like "great fit" or "perfect match" without citing what ' +
    "matched. If fewer than 2 attributes matched, say so plainly rather than overstating the fit.";
  const userMsg = JSON.stringify({
    student: {
      fields_of_interest: student.fields_of_interest,
      degree_level: student.degree_level,
      budget_max_eur_year: student.budget_max_eur_year,
      preferred_languages: student.preferred_languages,
      city_preference: student.city_preference,
    },
    university: { name: uni.name, country: uni.country },
    matched_attributes: components.map((c) => c.label),
  });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": LLM_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.UNIVERSO_LLM_MODEL || "claude-haiku-4-5-20251001",
      max_tokens: 80,
      system,
      messages: [{ role: "user", content: userMsg }],
    }),
  });
  if (!res.ok) throw new Error(`model ${res.status}`);
  const data = await res.json();
  const text = (data.content || [])
    .map((b) => b.text || "")
    .join("")
    .trim();
  if (!text) throw new Error("empty model response");
  return text;
}

module.exports = {
  tags,
  structuredLine,
  compressedReason,
  generate,
  LLM_ENABLED,
};
