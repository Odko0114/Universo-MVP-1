"use strict";

/**
 * Server-side rendering for SEO. The app is a vanilla SPA, but a discovery
 * product lives or dies on organic search over its ~12,500 profile pages — a
 * client-only SPA serves crawlers an empty shell. So for real navigations to
 * `/` and `/university/:id` we inject per-page <title>/description/Open-Graph
 * tags and a rendered content snapshot into the shell. The SPA then takes over
 * for client-side navigation (progressive enhancement).
 */

const esc = (s) =>
  String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

/**
 * `noindex: true`  → "noindex, nofollow" (account/ops pages: no unique public
 *                     content and nothing worth crawling onward).
 * `noindex: 'follow'` → "noindex, follow" (thin register-only profiles: keep
 *                     them out of the index, but still crawl their links).
 * @param {{ title:string, description:string, canonical?:string, image?:string, noindex?:boolean|'follow' }} opts
 */
function metaTags({ title, description, canonical, image, noindex }) {
  const t = esc(title);
  const d = esc(description);
  const robots = noindex === "follow" ? "noindex, follow" : "noindex, nofollow";
  const tags = [
    `<title>${t}</title>`,
    `<meta name="description" content="${d}" />`,
    noindex ? `<meta name="robots" content="${robots}" />` : "",
    canonical ? `<link rel="canonical" href="${esc(canonical)}" />` : "",
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${t}" />`,
    `<meta property="og:description" content="${d}" />`,
    canonical ? `<meta property="og:url" content="${esc(canonical)}" />` : "",
    image ? `<meta property="og:image" content="${esc(image)}" />` : "",
    `<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}" />`,
  ];
  return tags.filter(Boolean).join("\n  ");
}

/** Inject meta + rendered view content into the static index.html template. */
function injectSSR(template, { metaHtml, viewHtml }) {
  let html = template;
  // Replace the default <title> + description with per-page meta.
  html = html.replace(/<title>[\s\S]*?<\/title>/, "");
  html = html.replace(/<meta name="description"[^>]*>/, "");
  html = html.replace("</head>", `  ${metaHtml}\n</head>`);
  if (viewHtml) {
    html = html.replace(
      /(<main id="view"[^>]*>)[\s\S]*?(<\/main>)/,
      (_m, open, close) => `${open}${viewHtml}${close}`,
    );
  }
  return html;
}

function fmtMoney(r) {
  if (!r) return null;
  if (r.min === 0 && r.max === 0) return "No tuition fee";
  const f = (n) => `€${Number(n).toLocaleString("en-US")}`;
  return r.min === r.max
    ? `${f(r.min)}/${r.period}`
    : `${f(r.min)}–${f(r.max)}/${r.period}`;
}

/** Verified language requirement inner (crawlable). Empty unless verified/varies. */
function languageInnerSsr(lr) {
  if (!lr || lr.state === "none") return "";
  if (lr.state === "varies")
    return `<p><strong>Language:</strong> requirements vary by programme — this university doesn't set one requirement for every programme. Check the programme you're applying to.</p>`;
  const tests = (lr.tests || [])
    .map(
      (t) =>
        `<li>${esc(t.test)}: ${esc(t.min_score)}${t.note ? ` (${esc(t.note)})` : ""}</li>`,
    )
    .join("");
  const alts = (lr.alternatives || []).length
    ? `<p>Also accepted / exemptions: ${lr.alternatives.map(esc).join("; ")}.</p>`
    : "";
  return `<p><strong>Language:</strong> ${esc(lr.language || "English")}${lr.level ? ` · ${esc(lr.level)}` : ""}</p>
    <ul>${tests}</ul>
    ${alts}
    ${lr.conditions ? `<p>${esc(lr.conditions)}</p>` : ""}
    <p>Verified${lr.source_title ? ` from ${esc(lr.source_title)}` : ""}${lr.verification && lr.verification.date ? ` (${esc(lr.verification.date)})` : ""}.${lr.source_url ? ` <a href="${esc(lr.source_url)}" rel="noopener">View official requirement</a>.` : ""}</p>`;
}

/**
 * Crawlable "Entry requirements" — ONE section. Verified language leads; the
 * university's broader free-text requirements follow as context. When there's
 * neither, the section is omitted entirely (option a) — the profile's ETER
 * banner already tells the reader the rest lives on the official site.
 */
function entryRequirementsBlock(u) {
  const lang = languageInnerSsr(u.language_requirements);
  const text = u.acceptance_requirements
    ? `<p>${esc(u.acceptance_requirements)}</p>`
    : "";
  if (!lang && !text) return "";
  return `<h2>Entry requirements</h2>${lang}${text}`;
}

/** Crawlable profile content (mirrors the client view's key facts). */
function profileView(u) {
  const facts = [];
  if (u.ranking && u.ranking.world_rank) {
    const nat = u.ranking.national_rank
      ? ` · #${u.ranking.national_rank} national`
      : "";
    facts.push([
      "Ranking",
      `#${u.ranking.world_rank} world${nat} (${u.ranking.provider})`,
    ]);
  }
  // Tuition renders ONLY as a hand-researched figure. It used to fall back to
  // a "Check official site" link sitting in the value slot, which reads like an
  // answer — a row that looks filled in but tells you nothing. If we don't know
  // the number, the row is omitted entirely and the unverified notice below
  // explains why.
  const t = fmtMoney(u.tuition_range);
  if (t && u.tuition_source === "curated_research")
    facts.push(["Tuition (intl)", t]);
  // Country-level estimate, so it carries the same "est." marker and ~ prefix
  // the client view uses. A crawler seeing a bare figure would treat a national
  // average as a verified per-university cost.
  const living = fmtMoney(u.estimated_living_cost);
  if (living)
    facts.push([
      `Living cost${u.estimated_living_cost.estimated ? " · est." : ""}`,
      u.estimated_living_cost.estimated ? `~${living}` : living,
    ]);
  if ((u.language_of_instruction || []).length)
    facts.push([
      // Was rendered as plain fact here while the client marked it "typical" —
      // the crawlable page was the less honest of the two.
      `Language${u.language_estimated ? " · typical" : ""}`,
      u.language_of_instruction.join(", "),
    ]);
  if ((u.degree_levels || []).length)
    facts.push(["Degree levels", u.degree_levels.join(", ")]);
  if (u.application_deadline)
    facts.push(["Application deadline", u.application_deadline]);
  if (u.institution_type) facts.push(["Institution type", u.institution_type]);
  if (u.legal_status) facts.push(["Legal status", u.legal_status]);
  if (u.founded) facts.push(["Founded", String(u.founded)]);
  if (u.student_count)
    facts.push([
      "Students",
      `${Number(u.student_count).toLocaleString("en-US")} enrolled`,
    ]);
  if (u.website) facts.push(["Website", esc(u.website)]);

  const loc = [u.city, u.country].filter(Boolean).map(esc).join(", ");
  return `
    <article class="ssr">
      <a class="back-link" href="/discover">← Back to discover</a>
      <h1>${esc(u.name)}</h1>
      <p class="loc">${loc}</p>
      <p>${esc(u.short_description || "")}</p>
      <dl>${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>
      ${
        u.source === "curated"
          ? ""
          : `
      <p class="unverified-note">We have not verified tuition, programs or entry requirements for this university yet.
      Everything above comes from the official European register (ETER).
      ${u.website ? `Check <a href="${esc(u.website)}" rel="noopener">the official website</a> for fees and admission details.` : ""}</p>`
      }
      ${(u.programs_offered || []).length ? `<h2>Programs offered</h2><ul>${u.programs_offered.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
      ${(u.fields_of_study || []).length ? `<h2>Fields of study</h2><ul>${u.fields_of_study.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
      ${entryRequirementsBlock(u)}
      <p><a href="${esc(u.application_link || u.website || "#")}" rel="noopener">Visit official website</a></p>
      ${u.claimed_status === "claimed" ? "" : `<p class="claim-cta">Work at ${esc(u.name)}? <a href="/for-universities#claim">Claim this profile</a> to reach students directly and see your engagement analytics.</p>`}
    </article>`;
}

/** Crawlable directory snapshot (first page of results). */
function directoryView(list, total) {
  return `
    <section class="ssr">
      <p class="ssr-banner"><strong>Same Start. Equal Chance.</strong> Choosing a university abroad shouldn't depend on who you know. <a href="/account?mode=register&src=banner">Create a free account</a> to save a shortlist and get matched.</p>
      <h1>Discover universities in Europe</h1>
      <p>Browse ${Number(total).toLocaleString("en-US")} European universities by country, type, field of study and budget — no account needed.</p>
      <ul>${list.map((u) => `<li><a href="/university/${esc(u.id)}">${esc(u.name)}</a> — ${esc([u.city, u.country].filter(Boolean).join(", "))}</li>`).join("")}</ul>
    </section>`;
}

module.exports = { esc, metaTags, injectSSR, profileView, directoryView };
