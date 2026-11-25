"use strict";

/**
 * Landing pages for what students actually type into Google: "study in Finland",
 * "universities in Berlin", "study medicine in Europe", "Stipendium Hungaricum
 * eligibility". Pure: data in, HTML out.
 *
 * Same honesty rules as everywhere else:
 *  - counts, enrolment and fields come from the register (ETER) or our research;
 *  - a tuition figure or deadline appears only when hand-researched;
 *  - living cost is always labelled as our own country-level estimate;
 *  - a scholarship deadline that has passed is shown as past, never as upcoming.
 * A page exists only where there is enough real data to be useful (see the MIN_*
 * thresholds) — no empty or near-duplicate pages made for search engines. That is
 * also why there are no country × field pages: in most countries nearly every
 * large university offers nearly every field, so those lists would be copies.
 */

const { esc } = require("./ssr");
const { FIELDS, inferFieldsFromName } = require("./fields");
const { forCountry } = require("./estimates");
const { isEU } = require("./countries");

const MIN_COUNTRY = 5; // universities before a country page is worth having
const MIN_CITY = 4;
const MIN_CITY_VERIFIED = 2;

// Register spelling -> the name people search for in English.
const CITY_EN = {
  Milano: "Milan",
  Torino: "Turin",
  València: "Valencia",
  "Den Haag": "The Hague",
};
const cityName = (c) => CITY_EN[c] || c;

const slug = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const num = (n) => Number(n || 0).toLocaleString("en-US");
const inCountry = (c) =>
  /^(Netherlands|United Kingdom)$/.test(c) ? `the ${c}` : c;
const isPublic = (u) => /^Public/.test(u.legal_status || "");
/**
 * "15", "at least 15", or "" where a public count would mislead. ETER files most UK
 * universities as "private government-dependent", so "5 of 245 public" is true in
 * the register's terms and wrong in a student's; and our hand-researched records
 * carry no legal status, so a count that skips them is only a floor.
 */
const publicText = (unis) => {
  const n = unis.filter(isPublic).length;
  if (n / unis.length < 0.2) return "";
  return (unis.some((u) => !u.legal_status) ? "at least " : "") + num(n);
};
// Enrolment is missing on hand-researched records. Ranking or adding up what is left
// would quietly drop e.g. Helsinki from "largest in Finland" — so don't.
const enrolmentKnown = (unis) =>
  unis.every((u) => u.student_count || u.source !== "curated");
// Hand-researched first (richest facts), then in-depth profiles, then by size.
const bySize = (a, b) =>
  Number(b.source === "curated") - Number(a.source === "curated") ||
  Number(!!b.verified) - Number(!!a.verified) ||
  (b.student_count || 0) - (a.student_count || 0) ||
  a.name.localeCompare(b.name);
const clip = (s, n = 155) => {
  const t = String(s || "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length <= n
    ? t
    : t.slice(0, n - 1).replace(/[\s,;:·—-]+\S*$/, "") + "…";
};

/** A researched tuition figure, or "" — never an estimate. */
function tuitionText(u) {
  const t = u.tuition_range;
  if (!t || u.tuition_source !== "curated_research") return "";
  if (t.min === 0 && t.max === 0) return "No tuition fee";
  const f = (n) => "€" + num(n);
  return t.min === t.max
    ? `${f(t.min)} / ${t.period}`
    : `${f(t.min)}–${f(t.max)} / ${t.period}`;
}

const uniLink = (u) =>
  `<a href="/university/${esc(u.id)}" data-link>${esc(u.name)}</a>`;

function crumbs(items) {
  return `<nav class="seo-crumbs" aria-label="Breadcrumb">${items
    .map(([label, href], i) =>
      i === items.length - 1 || !href
        ? `<span aria-current="page">${esc(label)}</span>`
        : `<a href="${esc(href)}">${esc(label)}</a>`,
    )
    .join('<span aria-hidden="true"> › </span>')}</nav>`;
}
const jsonLd = (data) =>
  `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", ...data }).replace(/</g, "\\u003c")}</script>`;
const breadcrumbLd = (origin, items) =>
  jsonLd({
    "@type": "BreadcrumbList",
    itemListElement: items.map(([name, href], i) => ({
      "@type": "ListItem",
      position: i + 1,
      name,
      ...(href ? { item: origin + href } : {}),
    })),
  });
const itemListLd = (origin, name, unis) =>
  jsonLd({
    "@type": "ItemList",
    name,
    numberOfItems: unis.length,
    itemListElement: unis.slice(0, 50).map((u, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: u.name,
      url: `${origin}/university/${u.id}`,
    })),
  });

const chips = (links) =>
  `<ul class="seo-chips">${links.map(([label, href, n]) => `<li><a href="${esc(href)}">${esc(label)}${n ? ` <span>${num(n)}</span>` : ""}</a></li>`).join("")}</ul>`;

const CTA = `<aside class="seo-cta"><div><strong>Not sure where you fit?</strong><p>Tell Universo your field, budget and country and see the universities that match. Free for students, always.</p></div><a class="btn btn--gold" href="/account?mode=register&amp;src=guide">Get matched free</a></aside>`;

function uniTable(list, { city = true } = {}) {
  // data-after / data-before spell the column out on phones, where the header row
  // is hidden and the cells run together on one line.
  const td = (v, attr = "") =>
    v ? `<td${attr}>${esc(v)}</td>` : '<td class="nil">—</td>';
  return `<div class="seo-table"><table><thead><tr><th scope="col">University</th>${city ? '<th scope="col">City</th>' : ""}<th scope="col">Type</th><th scope="col">Students</th><th scope="col">Tuition (international)</th></tr></thead><tbody>${list
    .map(
      (u) =>
        `<tr><th scope="row">${uniLink(u)}</th>${city ? td(cityName(u.city)) : ""}${td(u.legal_status)}${td(u.student_count && num(u.student_count), ' data-after=" students"')}${tuitionText(u) ? td(tuitionText(u), ' data-before="Tuition "') : '<td class="dim">Check official site</td>'}</tr>`,
    )
    .join("")}</tbody></table></div>`;
}
const faq = (qa) =>
  `<section class="seo-faq"><h2>Common questions</h2>${qa.map(([q, a]) => `<h3>${esc(q)}</h3><p>${a}</p>`).join("")}</section>`;

const SOURCE = `<p class="seo-source">Institution facts come from the European Tertiary Education Register (ETER, reference year 2023) and, where shown, Universo's own research on official university pages. Always confirm fees, deadlines and entry rules on the university's website before you apply.</p>`;

/**
 * @param {{universities:object[], scholarships:object[], now?:() => number}} src
 */
function createSeoPages({ universities, scholarships, now = Date.now }) {
  // ---- which pages exist (slugs are fixed at boot; content is read live) ----
  const group = (key) => {
    const m = new Map();
    for (const u of universities) {
      const k = key(u);
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(u);
    }
    return m;
  };
  const countries = new Map(); // slug -> {name, unis}
  for (const [name, unis] of group((u) => u.country))
    if (unis.length >= MIN_COUNTRY)
      countries.set(slug(name), { name, unis: unis.sort(bySize) });

  const cities = new Map(); // slug -> {name, country, unis}
  const cityGroups = [...group((u) => u.city && `${u.city}|${u.country}`)].sort(
    (a, b) => b[1].length - a[1].length,
  );
  for (const [key, unis] of cityGroups) {
    const [raw, country] = key.split("|");
    const s = slug(cityName(raw));
    if (
      unis.length >= MIN_CITY &&
      unis.filter((u) => u.verified).length >= MIN_CITY_VERIFIED &&
      !cities.has(s)
    )
      cities.set(s, {
        name: cityName(raw),
        raw,
        country,
        unis: unis.sort(bySize),
      });
  }
  const fields = new Map(FIELDS.map((f) => [slug(f), f]));

  const countryHref = (name) =>
    countries.has(slug(name)) ? `/study-in/${slug(name)}` : "";
  const cityHref = (u) => {
    const c = u.city && cities.get(slug(cityName(u.city)));
    return c && c.country === u.country
      ? `/universities-in/${slug(c.name)}`
      : "";
  };
  const countryLinks = () =>
    [...countries.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => [c.name, `/study-in/${slug(c.name)}`, c.unis.length]);
  const fieldLinks = () => [...fields].map(([s, f]) => [f, `/study/${s}`]);
  const cityLinks = () =>
    [...cities]
      .sort((a, b) => a[1].name.localeCompare(b[1].name))
      .map(([s, c]) => [c.name, `/universities-in/${s}`, c.unis.length]);

  // The country's own schemes first. (Norway's entry explains there is no general
  // scholarship — useful to read, but it must not be counted as one.)
  const scholarshipsIn = (country) =>
    scholarships
      .filter(
        (s) =>
          (s.country === country && !/\(no general/i.test(s.name)) ||
          (s.country === "European Union" && isEU(country)),
      )
      .sort(
        (a, b) => Number(b.country === country) - Number(a.country === country),
      );
  const scholarshipList = (list) =>
    `<ul class="seo-list">${list.map((s) => `<li><a href="/scholarship/${esc(s.key)}">${esc(s.name)}</a><br /><span>${esc(s.tagline || "")}</span></li>`).join("")}</ul>`;
  const offers = (u, f) => (u.fields_offered || []).includes(f);

  // ---------------------------------------------------------------- hub
  function hub(origin) {
    const trail = [["Home", "/"], ["Study in Europe"]];
    const totalPublic = universities.filter(isPublic).length;
    return {
      path: "/study-in-europe",
      title: "Study in Europe: countries, subjects & scholarships | Universo",
      description: clip(
        `Compare ${num(universities.length)} universities in ${countries.size} European countries: what you can study, where, what it costs and which scholarships are real. Free for international students.`,
      ),
      head: breadcrumbLd(origin, trail),
      view: `<article class="seo">${crumbs(trail)}
        <h1>Study in Europe as an international student</h1>
        <p class="seo-lead">Universo lists ${num(universities.length)} higher-education institutions from Europe's official register — at least ${num(totalPublic)} of them public. Start with a country, a subject, a city or a scholarship.</p>
        <h2>Choose a country</h2>${chips(countryLinks())}
        <h2>Choose a subject</h2>${chips(fieldLinks())}
        <h2>Choose a city</h2>${chips(cityLinks())}
        <h2>Scholarships checked against official pages</h2>${scholarshipList(scholarships)}
        ${CTA}${SOURCE}</article>`,
    };
  }

  // ------------------------------------------------------------ country
  function country(s, origin) {
    const c = countries.get(s);
    if (!c) return null;
    const { name, unis } = c;
    const place = inCountry(name);
    const trail = [
      ["Home", "/"],
      ["Study in Europe", "/study-in-europe"],
      [name],
    ];
    const pub = publicText(unis);
    const largest = (enrolmentKnown(unis) ? unis : [])
      .filter((u) => u.student_count)
      .sort((a, b) => b.student_count - a.student_count)
      .slice(0, 5);
    const researched = unis.filter((u) => tuitionText(u));
    const withDeadline = unis.filter((u) => u.application_deadline);
    const sch = scholarshipsIn(name);
    const est = forCountry(name);
    const main = unis.slice(0, 40);
    const rest = unis.slice(40, 160);
    const fieldCounts = FIELDS.map((f) => [
      f,
      `/study/${slug(f)}`,
      unis.filter((u) => offers(u, f)).length,
    ])
      .filter((x) => x[2])
      .sort((a, b) => b[2] - a[2]);
    const cityList = [...cities]
      .filter(([, x]) => x.country === name)
      .map(([cs, x]) => [x.name, `/universities-in/${cs}`, x.unis.length]);
    const living = `€${num(est.living[0])}–${num(est.living[1])} a month`;

    const qa = [
      [
        `How many universities are there in ${place}?`,
        `Universo lists ${num(unis.length)} higher-education institutions in ${esc(place)}${pub ? `, ${pub} of them public` : ""}. The list comes from ETER, the European register, so it includes universities, universities of applied sciences and smaller specialised schools.`,
      ],
    ];
    if (largest.length >= 3)
      qa.push([
        `What are the largest universities in ${place}?`,
        `By enrolment in the register: ${largest.map((u) => `${uniLink(u)} (about ${num(u.student_count)} students)`).join(", ")}.`,
      ]);
    qa.push([
      `How much does it cost to live in ${place} as a student?`,
      `As a rough guide, plan for about ${living} including rent. This is Universo's own country-level estimate, not an official figure: capital cities cost more and smaller towns less.`,
    ]);
    qa.push([
      `How much is tuition in ${place} for international students?`,
      researched.length
        ? `It depends on the university, the programme and your nationality. Figures we have checked: ${researched
            .slice(0, 6)
            .map((u) => `${uniLink(u)} — ${esc(tuitionText(u))}`)
            .join("; ")}.`
        : `It depends on the university, the programme and your nationality. We have not verified fees for universities in ${esc(place)} yet, so we show none rather than guess. Each profile links to the official website.`,
    ]);
    if (sch.length)
      qa.push([
        `Are there scholarships to study in ${place}?`,
        `These are the schemes we have checked against their official pages: ${sch.map((x) => `<a href="/scholarship/${esc(x.key)}">${esc(x.name)}</a>`).join(", ")}. Each has its own nationality and degree rules, so read the eligibility first.`,
      ]);
    if (withDeadline.length)
      qa.push([
        `When are the application deadlines in ${place}?`,
        `Deadlines differ by university and programme. Ones we have on record: ${withDeadline
          .slice(0, 5)
          .map((u) => `${uniLink(u)} — ${esc(u.application_deadline)}`)
          .join("; ")}. Confirm the exact date on the official page.`,
      ]);

    return {
      path: `/study-in/${s}`,
      title: `Study in ${place}: ${unis.length} universities, costs${sch.length ? " & scholarships" : " & how to apply"} | Universo`,
      description: clip(
        `Universities in ${place} for international students: ${unis.length} institutions${pub ? ` (${pub} public)` : ""}, living costs, ${sch.length ? "real scholarships, " : ""}subjects and official application links.`,
      ),
      head:
        breadcrumbLd(origin, trail) +
        itemListLd(origin, `Universities in ${name}`, main),
      view: `<article class="seo">${crumbs(trail)}
        <h1>Study in ${esc(place)}</h1>
        <p class="seo-lead">${num(unis.length)} higher-education institutions in ${esc(place)}${pub ? `, ${pub} of them public` : ""}. Compare them, see what they teach, and find funding you can actually apply for.</p>
        <dl class="seo-facts"><div><dt>Universities</dt><dd>${num(unis.length)}</dd></div>${pub ? `<div><dt>Public</dt><dd>${pub.replace("at least ", "")}${pub.startsWith("at") ? "+" : ""}</dd></div>` : ""}<div><dt>Living cost · est.</dt><dd>~€${num(est.living[0])}–${num(est.living[1])}/mo</dd></div>${sch.length ? `<div><dt>Scholarships checked</dt><dd>${sch.length}</dd></div>` : ""}</dl>
        <h2>Universities in ${esc(place)}</h2>${uniTable(main)}
        ${rest.length ? `<h3>More universities in ${esc(place)}</h3><ul class="seo-more">${rest.map((u) => `<li>${uniLink(u)}${u.city ? ` <span>${esc(cityName(u.city))}</span>` : ""}</li>`).join("")}</ul>` : ""}
        ${unis.length > 160 ? `<p><a href="/discover?scope=all&amp;country=${encodeURIComponent(name)}">See all ${num(unis.length)} in Discover</a></p>` : ""}
        ${sch.length ? `<h2>Scholarships to study in ${esc(place)}</h2>${scholarshipList(sch)}` : ""}
        ${cityList.length ? `<h2>Student cities in ${esc(place)}</h2>${chips(cityList)}` : ""}
        ${fieldCounts.length ? `<h2>What you can study in ${esc(place)}</h2><p>Number of institutions in ${esc(place)} active in each subject area.</p>${chips(fieldCounts)}` : ""}
        ${faq(qa)}${CTA}
        <h2>Other countries</h2>${chips(countryLinks().filter((x) => x[0] !== name))}
        ${SOURCE}</article>`,
    };
  }

  // -------------------------------------------------------------- field
  function field(s, origin) {
    const f = fields.get(s);
    if (!f) return null;
    const trail = [["Home", "/"], ["Study in Europe", "/study-in-europe"], [f]];
    const all = universities.filter((u) => offers(u, f));
    // Only the programmes whose own title names this subject.
    const programmes = all
      .filter((u) => u.source === "curated")
      .map((u) => ({
        u,
        list: (u.programs_offered || []).filter(
          (p) =>
            p.toLowerCase().includes(f.toLowerCase()) ||
            inferFieldsFromName(p).includes(f),
        ),
      }))
      .filter((x) => x.list.length);
    const byCountry = [...countries.values()]
      .map((c) => ({ ...c, has: c.unis.filter((u) => offers(u, f)) }))
      .filter((c) => c.has.length >= 3)
      .sort((a, b) => b.has.length - a.has.length);
    const featured = all.filter((u) => u.verified).sort(bySize);
    const lower =
      f === "Arts & Design"
        ? "arts and design"
        : f.toLowerCase().replace(/&/g, "and");
    return {
      path: `/study/${s}`,
      title: `Study ${lower} in Europe: ${all.length} universities by country | Universo`,
      description: clip(
        `Where to study ${lower} in Europe: ${all.length} universities in ${byCountry.length} countries, with enrolment, official links and scholarships for international students.`,
      ),
      head:
        breadcrumbLd(origin, trail) +
        itemListLd(origin, `Universities for ${lower} in Europe`, featured),
      view: `<article class="seo">${crumbs(trail)}
        <h1>Study ${esc(lower)} in Europe</h1>
        <p class="seo-lead">${num(all.length)} institutions in ${byCountry.length} European countries are active in ${esc(lower)}. Subject areas come from the European register; check each university for the exact programme, language and degree level.</p>
        <h2>By country</h2>${chips(byCountry.map((c) => [c.name, `/study-in/${slug(c.name)}`, c.has.length]))}
        ${programmes.length ? `<h2>Programmes we have on record</h2><ul class="seo-list">${programmes.map((x) => `<li>${uniLink(x.u)} <span>${esc([cityName(x.u.city), x.u.country].filter(Boolean).join(", "))}</span><br /><span>${x.list.map(esc).join(" · ")}</span></li>`).join("")}</ul>` : ""}
        <h2>Universities for ${esc(lower)}</h2>
        ${byCountry
          .slice(0, 12)
          .map(
            (c) =>
              `<h3><a href="/study-in/${slug(c.name)}">${esc(c.name)}</a></h3><ul class="seo-more">${[
                ...c.has,
              ]
                .sort(bySize)
                .slice(0, 8)
                .map(
                  (u) =>
                    `<li>${uniLink(u)}${u.city ? ` <span>${esc(cityName(u.city))}</span>` : ""}</li>`,
                )
                .join("")}</ul>`,
          )
          .join("")}
        ${CTA}<h2>Other subjects</h2>${chips(fieldLinks().filter((x) => x[0] !== f))}${SOURCE}</article>`,
    };
  }

  // --------------------------------------------------------------- city
  function city(s, origin) {
    const c = cities.get(s);
    if (!c) return null;
    const { name, country: cn, unis } = c;
    const trail = [
      ["Home", "/"],
      ["Study in Europe", "/study-in-europe"],
      [cn, countryHref(cn)],
      [name],
    ];
    const pub = publicText(unis);
    const sch = scholarshipsIn(cn);
    const students = enrolmentKnown(unis)
      ? unis.reduce((a, u) => a + (u.student_count || 0), 0)
      : 0;
    return {
      path: `/universities-in/${s}`,
      title: `Universities in ${name}: ${unis.length} places to study | Universo`,
      description: clip(
        `All ${unis.length} universities and colleges in ${name}, ${cn}${pub ? ` (${pub} public)` : ""}: size, type, researched tuition and official links for international students.`,
      ),
      head:
        breadcrumbLd(origin, trail) +
        itemListLd(origin, `Universities in ${name}`, unis),
      view: `<article class="seo">${crumbs(trail)}
        <h1>Universities in ${esc(name)}</h1>
        <p class="seo-lead">${num(unis.length)} higher-education institutions in ${esc(name)}, ${esc(cn)}${pub ? `, ${pub} of them public` : ""}${students ? `, with about ${num(students)} students enrolled between them` : ""}.</p>
        ${uniTable(unis.slice(0, 150), { city: false })}
        ${sch.length ? `<h2>Scholarships to study in ${esc(inCountry(cn))}</h2>${scholarshipList(sch)}` : ""}
        ${CTA}
        <p><a href="${esc(countryHref(cn))}">All universities in ${esc(inCountry(cn))}</a></p>
        <h2>Other student cities</h2>${chips(cityLinks().filter((x) => x[0] !== name))}${SOURCE}</article>`,
    };
  }

  // -------------------------------------------------------- scholarships
  function scholarshipIndex(origin) {
    const trail = [["Home", "/"], ["Scholarships"]];
    return {
      path: "/scholarships",
      title:
        "Scholarships to study in Europe: eligibility & funding | Universo",
      description: clip(
        `${scholarships.length} real scholarships for international students, each checked against its official page: who can apply, what it pays, deadlines and how to apply.`,
      ),
      head: breadcrumbLd(origin, trail),
      view: `<article class="seo">${crumbs(trail)}<h1>Scholarships for international students</h1>
        <p class="seo-lead">${scholarships.length} schemes, each checked against its own official pages: who can apply, what it covers and how.</p>
        ${scholarshipList(scholarships)}</article>`,
      more: "",
    };
  }

  const dateText = (iso) =>
    new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  /** A passed deadline must never read like an upcoming one. */
  function deadlineHtml(a) {
    if (!a) return "";
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(a.deadline || "") ? a.deadline : "";
    const past = iso && Date.parse(iso + "T23:59:59Z") < now();
    if (past)
      return `<p>The last deadline we checked was ${dateText(iso)}, which has passed. Look for the next round on the official page.</p>`;
    const bits = [
      iso ? `<strong>${dateText(iso)}</strong>` : "",
      a.deadline_note ? esc(a.deadline_note) : "",
    ].filter(Boolean);
    return bits.length ? `<p>${bits.join(" — ")}</p>` : "";
  }

  function scholarship(key, origin) {
    const s = scholarships.find((x) => x.key === key);
    if (!s) return null;
    const trail = [["Home", "/"], ["Scholarships", "/scholarships"], [s.name]];
    const e = s.eligibility || {};
    const a = s.application || {};
    const fund = Object.entries(s.funding || {}).filter(([, v]) => v && v.text);
    const li = (arr) =>
      `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
    const places = (s.university_ids || [])
      .map((id) => universities.find((u) => u.id === id))
      .filter(Boolean);
    const checked = s.verification && s.verification.date;
    return {
      path: `/scholarship/${s.key}`,
      lastmod: checked,
      title: `${s.name}: eligibility, funding & how to apply | Universo`,
      description: clip(
        s.tagline || `${s.name}: who can apply, what it pays and how to apply.`,
      ),
      head: breadcrumbLd(origin, trail),
      view: `<article class="seo">${crumbs(trail)}<h1>${esc(s.name)}</h1>
        <p class="seo-lead">${esc(s.tagline || "")}</p>
        ${s.provider ? `<p>Provided by ${esc(s.provider)}${s.country ? ` · ${esc(s.country)}` : ""}</p>` : ""}
        ${(s.degree_levels || []).length ? `<h2>Degree levels</h2><p>${s.degree_levels.map(esc).join(", ")}</p>` : ""}
        ${fund.length ? `<h2>What it covers</h2><ul>${fund.map(([k, v]) => `<li><strong>${esc(k[0].toUpperCase() + k.slice(1))}:</strong> ${esc(v.text)}</li>`).join("")}</ul>` : ""}
        ${
          Object.values(e).some(Boolean)
            ? `<h2>Who can apply</h2>${[
                e.countries_note,
                e.academic,
                e.age,
                e.language,
                e.notes,
              ]
                .filter((x) => typeof x === "string" && x)
                .map((x) => `<p>${esc(x)}</p>`)
                .join("")}`
            : ""
        }
        ${(s.requirements || []).length ? `<h2>Documents you need</h2>${li(s.requirements)}` : ""}
        ${(a.steps || []).length ? `<h2>How to apply</h2>${a.route ? `<p>${esc(a.route)}</p>` : ""}<ol>${a.steps.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>` : ""}
        ${deadlineHtml(a) ? `<h2>Deadline</h2>${deadlineHtml(a)}` : ""}
        ${(s.important || []).length ? `<h2>Good to know</h2>${li(s.important)}` : ""}
        ${checked ? `<p class="seo-source">Checked ${esc(dateText(checked))} against ${(s.verification.sources || []).map((x) => `<a href="${esc(x)}" rel="noopener">${esc(x.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</a>`).join(", ")}.</p>` : ""}</article>`,
      more: places.length
        ? `<h2>Universities linked to ${esc(s.name)}</h2><ul class="seo-more">${places.map((u) => `<li>${uniLink(u)}</li>`).join("")}</ul>`
        : "",
    };
  }

  // ------------------------------------------- extras for /university/:id
  /** Title, description and internal links that make a profile findable. */
  function profile(u, origin) {
    const t = tuitionText(u);
    const has = [
      t ? "tuition" : "",
      u.application_deadline ? "deadlines" : "",
      u.acceptance_requirements ? "requirements" : "",
    ].filter(Boolean);
    const what = has.length
      ? has.length > 1
        ? `${has.slice(0, -1).join(", ")} & ${has[has.length - 1]}`
        : has[0]
      : "subjects, costs & how to apply";
    const loc = [cityName(u.city), u.country].filter(Boolean).join(", ");
    const parts = [
      u.short_description || `${u.name} in ${loc}.`,
      t ? `International tuition ${t}.` : "",
      u.application_deadline ? `Deadline: ${u.application_deadline}.` : "",
      !t && (u.fields_offered || []).length
        ? `Subjects: ${u.fields_offered.slice(0, 4).join(", ")}.`
        : "",
    ];
    const trail = [
      ["Home", "/"],
      ["Study in Europe", "/study-in-europe"],
      ...(countryHref(u.country) ? [[u.country, countryHref(u.country)]] : []),
      [u.name],
    ];
    const peers = (list) => list.filter((x) => x.id !== u.id && x.verified);
    const same = u.city
      ? peers(
          universities.filter(
            (x) => x.city === u.city && x.country === u.country,
          ),
        )
          .sort(bySize)
          .slice(0, 6)
      : [];
    const near = peers(
      universities.filter((x) => x.country === u.country && !same.includes(x)),
    )
      // closest in size first: a useful "similar" list, and it spreads links
      // across every profile instead of always pointing at the same giants
      .sort(
        (x, y) =>
          Math.abs((x.student_count || 0) - (u.student_count || 0)) -
            Math.abs((y.student_count || 0) - (u.student_count || 0)) ||
          x.name.localeCompare(y.name),
      )
      .slice(0, 8);
    const sch = scholarshipsIn(u.country);
    const links = [
      ...(countryHref(u.country)
        ? [[`Study in ${inCountry(u.country)}`, countryHref(u.country)]]
        : []),
      ...(cityHref(u)
        ? [[`Universities in ${cityName(u.city)}`, cityHref(u)]]
        : []),
      ...(u.fields_offered || [])
        .filter((f) => fields.has(slug(f)))
        .slice(0, 6)
        .map((f) => [`${f} in Europe`, `/study/${slug(f)}`]),
    ];
    const ul = (list, city = true) =>
      `<ul class="seo-more">${list.map((x) => `<li>${uniLink(x)}${city && x.city ? ` <span>${esc(cityName(x.city))}</span>` : ""}</li>`).join("")}</ul>`;
    return {
      title: `${u.name}: ${what}${u.country ? ` (${u.country})` : ""} | Universo`,
      description: clip(parts.filter(Boolean).join(" ")),
      head: breadcrumbLd(origin, trail),
      more: `${same.length ? `<h2>Other universities in ${esc(cityName(u.city))}</h2>${ul(same, false)}` : ""}
        ${near.length ? `<h2>Similar universities in ${esc(inCountry(u.country))}</h2>${ul(near)}` : ""}
        ${sch.length ? `<h2>Scholarships to study in ${esc(inCountry(u.country))}</h2>${scholarshipList(sch)}` : ""}
        ${links.length ? `<h2>Keep exploring</h2>${chips(links)}` : ""}`,
    };
  }

  /** Sitewide footer: every hub one click from every page. */
  function footer() {
    const pick = [
      "Finland",
      "Germany",
      "Hungary",
      "Italy",
      "France",
      "Netherlands",
      "Spain",
      "Sweden",
    ]
      .filter((c) => countryHref(c))
      .map(
        (c) =>
          `<li><a href="${countryHref(c)}">Study in ${esc(inCountry(c))}</a></li>`,
      );
    const f = [
      "Computer Science",
      "Engineering",
      "Business",
      "Medicine",
      "Law",
    ].map((x) => `<li><a href="/study/${slug(x)}">${esc(x)}</a></li>`);
    return `<footer class="sitefoot"><div class="sitefoot__in">
      <div><h2>Countries</h2><ul>${pick.join("")}<li><a href="/study-in-europe">All countries</a></li></ul></div>
      <div><h2>Subjects</h2><ul>${f.join("")}<li><a href="/study-in-europe">All subjects</a></li></ul></div>
      <div><h2>Universo</h2><ul><li><a href="/discover">Discover universities</a></li><li><a href="/scholarships">Scholarships</a></li><li><a href="/for-universities">For universities</a></li><li><a href="/privacy">Privacy</a></li><li><a href="/terms">Terms</a></li></ul></div>
    </div></footer>`;
  }

  /** Every indexable page built here, for the sitemap. */
  const paths = () => [
    "/study-in-europe",
    "/scholarships",
    ...[...countries.keys()].map((s) => `/study-in/${s}`),
    ...[...fields.keys()].map((s) => `/study/${s}`),
    ...[...cities.keys()].map((s) => `/universities-in/${s}`),
    ...scholarships.map((s) => `/scholarship/${s.key}`),
  ];

  return {
    hub,
    country,
    field,
    city,
    scholarshipIndex,
    scholarship,
    profile,
    footer,
    paths,
  };
}

module.exports = { createSeoPages, slug, clip };
