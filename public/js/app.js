/* Universo SPA — History-API router + views. Vanilla JS, no build step.
   Uses real paths (not hash) so the server can render each page for crawlers. */
(function () {
  "use strict";

  const view = document.getElementById("view");
  const PAGE_SIZE = 48;

  // Matching-profile option lists — the field list MUST mirror lib/fields.js
  // (both sides of the match draw from the same closed set).
  const MATCH = {
    FIELDS: [
      "Computer Science",
      "Engineering",
      "Business",
      "Law",
      "Medicine",
      "Natural Sciences",
      "Social Sciences",
      "Arts & Design",
      "Education",
      "Agriculture & Veterinary",
      "Hospitality & Services",
    ],
    LANGUAGES: [
      "English",
      "German",
      "French",
      "Spanish",
      "Italian",
      "Dutch",
      "Polish",
      "Portuguese",
      "Danish",
      "Swedish",
      "Finnish",
      "Czech",
      "Hungarian",
      "Romanian",
      "Greek",
    ],
    DEGREES: ["Bachelor", "Master", "PhD"],
    CITY: [
      ["large", "Large city"],
      ["mid", "Mid-size city"],
      ["small", "Small town"],
    ],
  };
  // Per-university application status (mirrors lib/journey.js#APPLICATION_STATUSES).
  const APP_STATUSES = [
    ["considering", "Considering"],
    ["researching", "Researching"],
    ["applied", "Applied"],
    ["offer", "Offer received"],
    ["rejected", "Not accepted"],
  ];
  // Working copy of the profile while an onboarding/edit form is open.
  let draft = null;
  const emptyDraft = () => ({
    fields_of_interest: [],
    budget_max_eur_year: "",
    preferred_languages: [],
    degree_level: "",
    city_preference: "",
    country_preference: [],
    home_country: "",
  });

  const state = {
    user: null,
    savedIds: new Set(),
    filterMeta: null,
    // scope 'verified' (default) shows the complete-profile tier; 'all' adds
    // the full register (thin records, clearly labeled).
    // sort '' means "let the server decide" — which is match-ranking for a
    // student with a profile. It used to default to 'name', which silently
    // suppressed match ranking in the UI because an explicit sort always wins.
    // page is 1-based and drives the offset sent to the API.
    discover: {
      q: "",
      scope: "verified",
      country: "",
      region: "",
      type: "",
      field: "",
      language: "",
      degree: "",
      maxTuition: "",
      sort: "",
      page: 1,
    },
    results: { items: [], total: 0, offset: 0, hasMore: false, loading: false },
  };

  // ---- helpers ------------------------------------------------------------
  const esc = (s) =>
    String(s == null ? "" : s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );

  const initials = (name) =>
    String(name || "")
      .replace(/\b(The|University|of|and|de|di|du|College)\b/gi, "")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0] || "")
      .join("")
      .toUpperCase() || "U";

  // Card cover fallbacks: a fixed set of brand-adjacent gradients (navy/teal/
  // deep tones) picked deterministically per university. Replaces the old
  // random-hue generator, which produced muddy browns/purples that made the
  // directory look like a database dump rather than one designed product.
  const COVERS = [
    ["#0B1F3A", "#14528a"],
    ["#0d3b4f", "#14b8a6"],
    ["#12294d", "#0d9488"],
    ["#1b3a66", "#2a6f97"],
    ["#0B1F3A", "#3a5a8c"],
    ["#123f3a", "#0f766e"],
    ["#1e3a5f", "#468faf"],
    ["#0f2e4d", "#1a7f8c"],
  ];
  function gradient(seed) {
    let h = 0;
    for (let i = 0; i < String(seed).length; i++)
      h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    const [a, b] = COVERS[h % COVERS.length];
    return `linear-gradient(135deg, ${a}, ${b})`;
  }

  // Inline SVG icons (stroke follows currentColor) — replaces the raw emoji
  // that made empty states and section markers read as placeholders.
  const ICONS = {
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    bookmark: '<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/>',
    alert:
      '<path d="M12 3 2 21h20L12 3z"/><path d="M12 10v5"/><circle cx="12" cy="18" r=".5"/>',
    check: '<circle cx="12" cy="12" r="10"/><path d="M8 12.5l2.5 2.5L16 9"/>',
    pin: '<path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
    award:
      '<circle cx="12" cy="9" r="5"/><path d="M8.5 13.5 7 22l5-2.5L17 22l-1.5-8.5"/>',
    spark:
      '<path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l2.5 2.5M16.5 16.5 19 19M19 5l-2.5 2.5M7.5 16.5 5 19"/>',
  };
  const icon = (name, size = 44) =>
    `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;

  // Consistent, designed empty/locked/error states (previously a lone emoji
  // floating in whitespace).
  function emptyState({ iconName, title, sub, ctaHref, ctaLabel, secondary }) {
    return `
      <div class="empty-card">
        <div class="empty-card__icon">${icon(iconName)}</div>
        <h3>${esc(title)}</h3>
        ${sub ? `<p class="muted">${esc(sub)}</p>` : ""}
        <div class="empty-card__actions">
          ${ctaHref ? `<a class="btn btn--primary" href="${esc(ctaHref)}">${esc(ctaLabel)}</a>` : ""}
          ${secondary || ""}
        </div>
      </div>`;
  }

  function domainOf(u) {
    if (u.domain) return u.domain;
    const url = u.application_link || u.website || "";
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  }

  function logoHtml(u, cls) {
    const d = domainOf(u);
    const img = d
      ? `<img src="${esc(API.logoUrl(d))}" alt="" loading="lazy" onerror="this.remove()">`
      : "";
    return `<span class="logo ${cls || ""}">${esc(initials(u.name))}${img}</span>`;
  }

  const nfmt = (n) => Number(n).toLocaleString("en-US");

  const money = (r) => {
    if (!r) return null;
    if (r.min === 0 && r.max === 0) return "No tuition fee";
    const fmt = (n) => `€${nfmt(n)}`;
    return r.min === r.max
      ? `${fmt(r.min)}/${r.period}`
      : `${fmt(r.min)}–${fmt(r.max)}/${r.period}`;
  };

  // Neutral, non-personalized facts line shown to anonymous visitors on a
  // profile — no "fits you" claim (they have no profile). Tuition is only a
  // figure when hand-researched (honest-tuition rule); estimates are omitted.
  function quickFactsLine(u) {
    const bits = [];
    const langs = (u.language_of_instruction || []).slice(0, 2).join(", ");
    if (langs) bits.push(`Teaches in ${langs}`);
    if (u.legal_status)
      bits.push(
        `${u.legal_status} ${(u.institution_type || "university").toLowerCase()}`,
      );
    else if (u.institution_type) bits.push(u.institution_type);
    const t = money(u.tuition_range);
    if (t && u.tuition_source === "curated_research") bits.push(t);
    return bits.map(esc).join(" · ");
  }

  let toastTimer;
  function toast(msg, isError) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.className = "toast show" + (isError ? " err" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = "toast"), 2800);
  }

  function setActiveNav(name) {
    document.querySelectorAll("[data-nav]").forEach((a) => {
      const active = a.dataset.nav === name;
      a.classList.toggle("is-active", active);
      if (active) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }

  const deviceGuess = () => (window.innerWidth < 700 ? "mobile" : "desktop");
  const trackPageview = (path) =>
    API.track({ type: "pageview", path, device: deviceGuess() });
  const trackProfileView = (uni) =>
    API.track({
      type: "profile_view",
      path: location.pathname,
      uni,
      device: deviceGuess(),
    });
  const trackFilter = (filter, value) =>
    API.track({
      type: "filter_used",
      filter,
      value: String(value),
      device: deviceGuess(),
    });

  // ---- History-API router -------------------------------------------------
  function navigate(pathname, replace) {
    if (pathname !== location.pathname) {
      history[replace ? "replaceState" : "pushState"]({}, "", pathname);
    }
    render();
  }

  // Intercept same-origin link clicks so navigation stays a SPA transition.
  // Standalone pages (B2B pitch, partner dashboard, admin) are NOT SPA routes —
  // those need a real page load.
  const STANDALONE_PATHS = ["/for-universities", "/partners", "/admin"];
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a");
    if (!a) return;
    const href = a.getAttribute("href");
    if (
      !href ||
      !href.startsWith("/") ||
      a.target === "_blank" ||
      a.hasAttribute("download")
    )
      return;
    if (
      STANDALONE_PATHS.some(
        (p) =>
          href === p || href.startsWith(p + "#") || href.startsWith(p + "?"),
      )
    )
      return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(href);
  });
  window.addEventListener("popstate", render);

  const go = navigate;

  // ---- university card ----------------------------------------------------
  function metaChips(u) {
    const chips = [];
    if (u.ranking && u.ranking.world_rank) {
      chips.push(
        `<span class="chip chip--rank">${icon("award", 13)} #${esc(u.ranking.world_rank)} world</span>`,
      );
    }
    // Tuition chip only for hand-researched figures — estimate ranges are not
    // shown as numbers anywhere (see the profile view's "Check official site").
    const t = money(u.tuition_range);
    if (t && u.tuition_source === "curated_research") {
      chips.push(`<span class="chip chip--gold">${esc(t)}</span>`);
    }
    const langs = (u.language_of_instruction || []).slice(0, 2).join(", ");
    if (langs)
      chips.push(`<span class="chip chip--plain">${esc(langs)}</span>`);
    if ((u.degree_levels || []).length)
      chips.push(
        `<span class="chip">${esc(u.degree_levels.join(" · "))}</span>`,
      );
    else if (u.institution_type)
      chips.push(`<span class="chip">${esc(u.institution_type)}</span>`);
    return chips.join("");
  }

  // Real cached photo when the server has already resolved one (never
  // triggers a fresh lookup from the grid — see server.js `withPhoto`), a
  // subtle building glyph over the brand gradient otherwise, so a missing
  // photo reads as a deliberate placeholder rather than a broken image.
  function coverStyle(u) {
    return u.cover_photo_url
      ? `background:linear-gradient(rgba(11,31,58,.15),rgba(11,31,58,.55)),url('${esc(u.cover_photo_url)}') center/cover no-repeat`
      : `background:${gradient(u.id)}`;
  }
  const PLACEHOLDER_GLYPH =
    '<svg class="uni-card__glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M3 21h18M4 21V9l8-5 8 5v12M9 21v-6h6v6"/></svg>';

  function uniCard(u) {
    const saved = state.savedIds.has(u.id);
    return `
      <article class="uni-card">
        <a class="uni-card__cover" href="/university/${esc(u.id)}" style="${coverStyle(u)}" aria-label="${esc(u.name)}">
          ${!u.cover_photo_url ? PLACEHOLDER_GLYPH : ""}
          ${
            u.source === "curated"
              ? '<span class="uni-card__tier">★ Curated</span>'
              : u.verified
                ? '<span class="uni-card__tier uni-card__tier--verified">✓ Verified profile</span>'
                : ""
          }
          <span class="uni-card__badge">${esc(u.country)}</span>
          <span class="uni-card__loc">${esc(u.city || u.country)}</span>
        </a>
        <div class="uni-card__body">
          <div class="uni-card__title">
            ${logoHtml(u, "logo--card")}
            <div><a href="/university/${esc(u.id)}"><h3 class="uni-card__name">${esc(u.name)}</h3></a></div>
          </div>
          <p class="uni-card__desc">${esc(u.short_description || "")}</p>
          <div class="uni-card__meta">${metaChips(u)}</div>
          ${(u.match_reasons || []).length ? `<p class="match-why">🎯 ${esc(u.match_reasons.join(" · "))}</p>` : ""}
          <div class="card-actions">
            <a class="btn btn--ghost btn--sm" href="/university/${esc(u.id)}" style="flex:1">View</a>
            <button class="btn btn--sm ${saved ? "btn--saved" : "btn--primary"}" data-save="${esc(u.id)}" style="flex:1">
              ${saved ? `${icon("bookmark", 15)} Saved` : "＋ Save"}
            </button>
          </div>
        </div>
      </article>`;
  }

  // Reflect a save/unsave on every visible button for that university WITHOUT
  // re-rendering the page — a full render() here reset the scroll position, so
  // saving something mid-list yanked the user back to the top.
  function paintSaveButtons(id) {
    const saved = state.savedIds.has(id);
    document
      .querySelectorAll(`[data-save="${CSS.escape(id)}"]`)
      .forEach((b) => {
        b.classList.toggle("btn--saved", saved);
        b.classList.toggle(
          "btn--primary",
          !saved && b.classList.contains("btn--sm"),
        );
        b.classList.toggle(
          "btn--ghost",
          !saved && !b.classList.contains("btn--sm"),
        );
        b.innerHTML = saved ? `${icon("bookmark", 15)} Saved` : "＋ Save";
        b.disabled = false;
      });
  }

  async function handleSaveClick(id, btn) {
    if (!state.user) {
      // Lightweight inline prompt, not a hard redirect: the button itself
      // becomes the sign-up link so the visitor keeps their place in the list.
      const next = encodeURIComponent(location.pathname);
      btn.outerHTML = `<a class="btn btn--sm btn--gold" style="flex:1" href="/account?mode=register&src=save-prompt&next=${next}">Sign up to save →</a>`;
      toast("Saving needs a free account — it takes 30 seconds");
      return;
    }
    const wasSaved = state.savedIds.has(id);
    btn.disabled = true;
    try {
      if (wasSaved) {
        await API.unsave(id);
        state.savedIds.delete(id);
        toast("Removed from saved");
      } else {
        await API.save(id);
        state.savedIds.add(id);
        toast("Saved to your list");
      }
      paintSaveButtons(id);
      // Only the Saved list actually changes shape when an item is removed.
      if (location.pathname.startsWith("/saved")) render();
    } catch (e) {
      toast(e.message, true);
      btn.disabled = false;
    }
  }

  document.addEventListener("click", (e) => {
    const saveBtn = e.target.closest("[data-save]");
    if (saveBtn) handleSaveClick(saveBtn.dataset.save, saveBtn);
    if (e.target.closest("[data-chip]")) onDraftClick(e);
  });

  // =========================================================================
  // Views
  // =========================================================================
  // ---- Discover state <-> URL --------------------------------------------
  // Filters, search, scope, sort and page live in the query string, so a
  // filtered view is shareable and survives a reload/refresh.
  function discoverFromUrl() {
    const p = new URLSearchParams(location.search);
    const d = state.discover;
    d.q = p.get("q") || "";
    d.scope = p.get("scope") === "all" ? "all" : "verified";
    d.country = p.get("country") || "";
    d.region = p.get("region") || "";
    d.type = p.get("type") || "";
    d.field = p.get("field") || "";
    d.language = p.get("language") || "";
    d.degree = p.get("degree") || "";
    d.maxTuition = p.get("maxTuition") || "";
    d.sort = p.get("sort") || "";
    d.page = Math.max(1, parseInt(p.get("page"), 10) || 1);
  }

  function syncDiscoverUrl() {
    const d = state.discover;
    const p = new URLSearchParams();
    // Only non-default values are written, so a clean browse stays at /discover.
    if (d.q) p.set("q", d.q);
    if (d.scope === "all") p.set("scope", "all");
    [
      "country",
      "region",
      "type",
      "field",
      "language",
      "degree",
      "maxTuition",
      "sort",
    ].forEach((k) => {
      if (d[k]) p.set(k, d[k]);
    });
    if (d.page > 1) p.set("page", String(d.page));
    const qs = p.toString();
    history.replaceState({}, "", "/discover" + (qs ? `?${qs}` : ""));
  }

  async function renderDiscover() {
    // Browsing is public — no account needed. Only actions (saving,
    // recommendations) gate on login, at the moment of the action.
    discoverFromUrl();
    setActiveNav("discover");
    document.title = "Discover universities in Europe — Universo";
    const d = state.discover;

    if (!state.filterMeta) {
      try {
        state.filterMeta = await API.filters();
      } catch {
        state.filterMeta = {
          countries: [],
          institution_types: [],
          fields_of_study: [],
          languages: [],
          degree_levels: [],
        };
      }
    }
    const m = state.filterMeta;
    const opts = (arr, sel) =>
      (arr || [])
        .map(
          (v) =>
            `<option value="${esc(v)}" ${v === sel ? "selected" : ""}>${esc(v)}</option>`,
        )
        .join("");
    const budgets = [
      ["", "Any budget"],
      ["1000", "Under €1,000/yr"],
      ["3000", "Under €3,000/yr"],
      ["6000", "Under €6,000/yr"],
      ["12000", "Under €12,000/yr"],
      ["20000", "Under €20,000/yr"],
    ];

    const niche =
      d.region === "EU" && d.language === "English" && d.maxTuition === "6000";
    const counts = m.counts || {};
    const verifiedN = counts.verified ? nfmt(counts.verified) : "300";
    const totalN = counts.total ? nfmt(counts.total) : "4,000+";
    const registerN =
      counts.total && counts.verified
        ? nfmt(counts.total - counts.verified)
        : "3,700+";
    const profiled = !!(state.user && state.user.profile_completed);

    view.innerHTML = `
      ${
        !state.user
          ? `
      <div class="signup-banner">
        <span><strong>Same Start. Equal Chance.</strong> Save a shortlist and get matched — free, always.</span>
        <a class="btn btn--gold btn--sm" href="/account?mode=register&src=banner">Sign up free</a>
      </div>`
          : ""
      }
      <section class="hero">
        <p class="hero__tagline">Same Start. Equal Chance.</p>
        <h1>Find your university <span class="accent">in Europe</span></h1>
        <p><strong>${totalN}</strong> European universities listed — <strong>${verifiedN}</strong> with a complete, checked profile (photo, official enrolment data, scholarships). The rest are entries from the official European register; open any profile to see exactly what we do and don't know about it.</p>
      </section>

      <div class="scope-row" role="group" aria-label="Result scope">
        <button class="niche-btn ${d.scope === "verified" ? "is-active" : ""}" id="scope-verified" type="button" aria-pressed="${d.scope === "verified"}">✓ Verified profiles (${verifiedN})</button>
        <button class="niche-btn ${d.scope === "all" ? "is-active" : ""}" id="scope-all" type="button" aria-pressed="${d.scope === "all"}">Include unverified register entries (${registerN})</button>
      </div>

      <button class="niche-btn ${niche ? "is-active" : ""}" id="niche-toggle" type="button">
        🇪🇺 ${niche ? "✓ " : ""}Affordable, English-taught, EU
      </button>

      <div id="recommended-wrap"></div>

      <form class="searchbar" role="search" onsubmit="return false">
        <label for="q" class="sr-only">Search universities</label>
        <input id="q" type="search" placeholder="Search by name, city, program…" value="${esc(d.q)}" autocomplete="off" />
      </form>

      <div class="filters">
        <div class="field"><label for="f-country">Country</label><select id="f-country"><option value="">All countries</option>${opts(m.countries, d.country)}</select></div>
        <div class="field"><label for="f-type">Institution type</label><select id="f-type"><option value="">All types</option>${opts(m.institution_types, d.type)}</select></div>
        <div class="field"><label for="f-field">Field of study</label><select id="f-field"><option value="">All fields</option>${opts(m.fields_of_study, d.field)}</select></div>
        <div class="field"><label for="f-language">Language</label><select id="f-language"><option value="">Any language</option>${opts(m.languages, d.language)}</select></div>
        <div class="field"><label for="f-degree">Degree level</label><select id="f-degree"><option value="">Any degree</option>${opts(m.degree_levels, d.degree)}</select></div>
        <div class="field"><label for="f-budget">Tuition budget</label><select id="f-budget">${budgets.map(([v, l]) => `<option value="${v}" ${v === d.maxTuition ? "selected" : ""}>${l}</option>`).join("")}</select></div>
        <div class="field field--wide"><label for="f-sort">Sort by</label><select id="f-sort">
          <option value="" ${d.sort === "" ? "selected" : ""}>${profiled ? "Best match (your profile)" : "Verified first, then A–Z"}</option>
          <option value="name" ${d.sort === "name" ? "selected" : ""}>Name (A–Z)</option>
          <option value="size" ${d.sort === "size" ? "selected" : ""}>Largest (students)</option>
          <option value="tuition" ${d.sort === "tuition" ? "selected" : ""}>Lowest tuition</option>
          <option value="popular" ${d.sort === "popular" ? "selected" : ""}>Most popular</option>
        </select></div>
      </div>

      <div class="filters-row">
        <span id="result-count" class="muted" aria-live="polite">Loading…</span>
        <button class="link-btn" id="clear-filters">Clear all</button>
      </div>
      <p class="hint muted" id="filter-hint"></p>
      <div id="results" class="grid">${'<div class="skeleton"></div>'.repeat(6)}</div>
      <div id="loadmore-wrap" class="loadmore-wrap"></div>`;

    // Any filter change resets to page 1 — staying on page 7 of a narrower
    // result set would land the visitor on an empty page.
    const applyChange = () => {
      d.page = 1;
      syncDiscoverUrl();
      loadResults(true);
    };

    const qEl = document.getElementById("q");
    let searchTimer;
    qEl.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        d.q = qEl.value.trim();
        applyChange();
      }, 300);
    });
    const bind = (id, key) => {
      const el = document.getElementById(id);
      if (el)
        el.addEventListener("change", (e) => {
          d[key] = e.target.value;
          if (e.target.value) trackFilter(key, e.target.value);
          applyChange();
        });
    };
    bind("f-country", "country");
    bind("f-type", "type");
    bind("f-field", "field");
    bind("f-language", "language");
    bind("f-degree", "degree");
    bind("f-budget", "maxTuition");
    bind("f-sort", "sort");
    document.getElementById("clear-filters").addEventListener("click", () => {
      history.replaceState({}, "", "/discover"); // drop every param, then re-read
      renderDiscover();
    });
    document.getElementById("scope-verified").addEventListener("click", () => {
      if (d.scope !== "verified") {
        d.scope = "verified";
        d.page = 1;
        trackFilter("scope", "verified");
        syncDiscoverUrl();
        renderDiscover();
      }
    });
    document.getElementById("scope-all").addEventListener("click", () => {
      if (d.scope !== "all") {
        d.scope = "all";
        d.page = 1;
        trackFilter("scope", "all");
        syncDiscoverUrl();
        renderDiscover();
      }
    });
    document.getElementById("niche-toggle").addEventListener("click", () => {
      if (niche) {
        d.region = "";
        d.language = "";
        d.maxTuition = "";
      } else {
        d.region = "EU";
        d.language = "English";
        d.maxTuition = "6000";
        trackFilter("niche", "eu-affordable-english");
      }
      d.page = 1;
      syncDiscoverUrl();
      renderDiscover();
    });

    loadResults(true);
    loadRecommendations();
  }

  async function loadRecommendations() {
    const wrap = document.getElementById("recommended-wrap");
    if (!wrap || !state.user) {
      if (wrap) wrap.innerHTML = "";
      return;
    }
    try {
      const { universities } = await API.recommendations(6);
      if (!universities.length) {
        wrap.innerHTML = "";
        return;
      }
      wrap.innerHTML = `
        <div class="section-head" style="margin-top:4px">
          <h2>Recommended for you</h2>
          <span class="muted" style="font-size:.8rem">Matched to your profile</span>
        </div>
        <div class="grid grid--rec">${universities.map(uniCard).join("")}</div>`;
    } catch {
      wrap.innerHTML = "";
    }
  }

  /**
   * Numbered pager: « Prev, a sliding window of page numbers around the
   * current one (with ellipses and always-visible first/last), Next ».
   */
  function pagerHtml(page, totalPages) {
    const btn = (p, label, opts = {}) =>
      `<button class="pager__btn ${opts.current ? "is-current" : ""}" ${opts.disabled ? "disabled" : `data-page="${p}"`} ${opts.current ? 'aria-current="page"' : ""}>${label}</button>`;
    const gap = '<span class="pager__gap">…</span>';

    const nums = [];
    const windowSize = 2; // pages either side of the current one
    const lo = Math.max(1, page - windowSize);
    const hi = Math.min(totalPages, page + windowSize);
    if (lo > 1) {
      nums.push(btn(1, "1"));
      if (lo > 2) nums.push(gap);
    }
    for (let p = lo; p <= hi; p++)
      nums.push(btn(p, String(p), { current: p === page }));
    if (hi < totalPages) {
      if (hi < totalPages - 1) nums.push(gap);
      nums.push(btn(totalPages, String(totalPages)));
    }

    return `<nav class="pager" aria-label="Pagination">
      ${btn(page - 1, "‹ Prev", { disabled: page === 1 })}
      ${nums.join("")}
      ${btn(page + 1, "Next ›", { disabled: page === totalPages })}
    </nav>`;
  }

  async function loadResults(reset) {
    const d = state.discover;
    const box = document.getElementById("results");
    const countEl = document.getElementById("result-count");
    const hintEl = document.getElementById("filter-hint");
    const moreWrap = document.getElementById("loadmore-wrap");
    if (!box) return;

    if (reset) {
      state.results = {
        items: [],
        total: 0,
        offset: 0,
        hasMore: false,
        loading: true,
      };
      box.innerHTML = '<div class="skeleton"></div>'.repeat(6);
    }
    const offset = (d.page - 1) * PAGE_SIZE;
    if (hintEl) {
      const narrowing = d.field || d.language || d.degree || d.maxTuition;
      hintEl.textContent = narrowing
        ? "Field, language, degree and tuition filters apply to in-depth curated profiles only."
        : "";
    }

    try {
      const res = await API.universities({
        q: d.q,
        verified: d.scope === "verified" ? "1" : "",
        country: d.country,
        region: d.region,
        type: d.type,
        field: d.field,
        language: d.language,
        degree: d.degree,
        maxTuition: d.maxTuition,
        sort: d.sort,
        offset,
        limit: PAGE_SIZE,
      });
      state.results.total = res.count;
      state.results.items = res.universities; // one page at a time, not accumulated

      const totalPages = Math.max(1, Math.ceil(res.count / PAGE_SIZE));
      // A stale deep link (e.g. ?page=40 after narrowing) lands past the end —
      // bounce back to the last real page instead of showing nothing.
      if (d.page > totalPages && res.count > 0) {
        d.page = totalPages;
        syncDiscoverUrl();
        return loadResults(true);
      }

      const from = res.count ? offset + 1 : 0;
      const to = Math.min(offset + PAGE_SIZE, res.count);
      countEl.textContent = res.count
        ? `${nfmt(res.count)} ${res.count === 1 ? "university" : "universities"} · showing ${nfmt(from)}–${nfmt(to)} (page ${d.page} of ${nfmt(totalPages)})`
        : "No universities";

      box.innerHTML = state.results.items.length
        ? state.results.items.map(uniCard).join("")
        : `<div style="grid-column:1/-1">${emptyState({
            iconName: "search",
            title: "No universities match these filters",
            sub: "Nothing in the catalogue matches that combination. Try a broader search term, or clear the filters to start again.",
            secondary:
              '<button class="btn btn--primary" id="empty-clear">Clear all filters</button>',
          })}</div>`;
      const emptyClear = document.getElementById("empty-clear");
      if (emptyClear)
        emptyClear.addEventListener("click", () => {
          history.replaceState({}, "", "/discover");
          renderDiscover();
        });

      moreWrap.innerHTML = totalPages > 1 ? pagerHtml(d.page, totalPages) : "";
      moreWrap.querySelectorAll("[data-page]").forEach((b) =>
        b.addEventListener("click", () => {
          d.page = Number(b.dataset.page);
          syncDiscoverUrl();
          loadResults(true);
          document
            .querySelector(".searchbar")
            .scrollIntoView({ behavior: "smooth", block: "start" });
        }),
      );
    } catch (e) {
      countEl.textContent = "";
      box.innerHTML = `<div style="grid-column:1/-1">${emptyState({ iconName: "alert", title: "Something went wrong loading results", sub: e.message })}</div>`;
    }
  }

  // ---- My Journey ---------------------------------------------------------
  // A single-call personalized dashboard built from data we already have
  // (profile, saved list, matcher, scholarship pointers). No new API round
  // trips per section — the server assembles it in one GET /me/journey.
  async function renderJourney() {
    if (!state.user) {
      navigate("/account?src=gate&next=%2Fjourney", true);
      return;
    }
    setActiveNav("journey");
    document.title = "Dream Plan — Universo";
    const first = esc((state.user.full_name || "").split(" ")[0] || "there");
    view.innerHTML = `
      <div class="journey">
        <div class="section-head"><h2>Your Dream Plan, ${first}</h2></div>
        <div class="journey-skel">${'<div class="skeleton skeleton--block"></div>'.repeat(3)}</div>
      </div>`;
    let data;
    try {
      data = await API.journey();
    } catch (e) {
      view.innerHTML = emptyState({
        iconName: "alert",
        title: "Couldn’t load your journey",
        sub: e.message,
        ctaHref: "/discover",
        ctaLabel: "Back to discover",
      });
      return;
    }
    // NB: do NOT rebuild state.savedIds from data.saved.universities — that list
    // is capped at 6 for the preview card. state.savedIds is the authoritative
    // full set (loaded at boot); overwriting it here would drop saved-state for
    // anyone with more than 6 saved. The preview cards read the full set fine.

    // ---- build the view (rebuilt in place when a milestone toggles) --------
    function build() {
      const d = data.dream || {};
      const hasDream =
        (d.fields_of_interest || []).length ||
        d.degree_level ||
        (d.country_preference || []).length ||
        d.target_intake ||
        d.career_goal;
      const dreamCard = `
        <div class="card dream-card">
          <div class="section-head" style="margin:0 0 6px"><h3 style="margin:0">Your dream</h3><button class="link-btn" id="edit-dream">${hasDream ? "Edit" : "Define"}</button></div>
          ${
            hasDream
              ? `<p class="dream-statement">${dreamStatement(d)}</p>`
              : `<p class="muted" style="margin:0">Tell us your goal — what to study, at what level, where, and when — so your plan is built around it.</p>`
          }
          <form id="dream-form" hidden class="dream-form">
            <label class="onb-label">Target intake</label>
            <select name="target_intake" class="onb-input">${intakeOptions(d.target_intake)}</select>
            <label class="onb-label" style="margin-top:12px">Career goal <span class="muted">(optional)</span></label>
            <input name="career_goal" class="onb-input" maxlength="120" placeholder="e.g. Become a data scientist" value="${esc(d.career_goal || "")}" />
            <label class="consent" style="margin-top:12px"><input type="checkbox" name="scholarship_required"${d.scholarship_required ? " checked" : ""} /><span>I need a scholarship to make this possible</span></label>
            <div style="display:flex;gap:10px;margin-top:14px">
              <button class="btn btn--primary btn--sm" type="submit" style="flex:1">Save dream</button>
              <button class="btn btn--ghost btn--sm" type="button" id="dream-cancel" style="flex:1">Cancel</button>
            </div>
            <p class="muted" style="font-size:.82rem;margin:10px 0 0">Field, degree and countries come from your <a href="/onboarding">matching profile</a>.</p>
          </form>
        </div>`;

      const nba = data.next_best_action;
      const nextBestCard = nba
        ? `
        <div class="card next-best">
          <div class="next-best__eyebrow">Your next best step</div>
          <h3 class="next-best__title">${esc(nba.title)}</h3>
          <p class="muted" style="margin:6px 0 14px">${esc(nba.body)}</p>
          <a class="btn btn--primary" href="${esc(nba.href)}">${esc(nba.cta)}</a>
        </div>`
        : `
        <div class="card next-best">
          <div class="next-best__eyebrow">You're on track</div>
          <h3 class="next-best__title">Everything's ready 🎉</h3>
          <p class="muted" style="margin:6px 0 0">Profile, applications, documents and scholarships are all in good shape.</p>
        </div>`;

      const readinessCard = `
        <div class="section-head" style="margin-top:22px"><h3 style="margin:0">How ready are you?</h3></div>
        <div class="card">
          <div class="readiness">
            ${data.readiness
              .map(
                (r) => `
              <div class="readiness__row">
                <div class="readiness__head"><span>${esc(r.label)}</span><span class="readiness__pct">${r.score}%</span></div>
                <div class="progress" role="progressbar" aria-valuenow="${r.score}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(r.label)} readiness"><div class="progress__bar" style="width:${r.score}%"></div></div>
                <p class="muted readiness__detail">${esc(r.detail)}</p>
              </div>`,
              )
              .join("")}
          </div>
          <p class="muted" style="font-size:.8rem;margin:14px 0 0">These show how prepared you are — not your chance of admission, which no one can honestly predict.</p>
        </div>`;

      const documentsCard = `
        <div class="section-head" style="margin-top:26px" id="documents"><h3 style="margin:0">Document checklist</h3></div>
        <div class="card">
          <ul class="doc-list">
            ${data.documents
              .map(
                (doc) => `
              <li class="doc-item${doc.done ? " is-done" : ""}">
                <button type="button" class="doc-check" data-document="${esc(doc.key)}" aria-pressed="${doc.done}" title="${doc.done ? "Mark not ready" : "Mark ready"}">${doc.done ? "✓" : ""}</button>
                <div class="doc-body"><strong>${esc(doc.label)}</strong><p class="muted">${esc(doc.hint)}</p></div>
              </li>`,
              )
              .join("")}
          </ul>
          <p class="muted" style="font-size:.8rem;margin:12px 0 0">You track these yourself — Universo never sees or stores your actual documents.</p>
        </div>`;

      const timelineCard = `
        <div class="section-head" style="margin-top:26px"><h3 style="margin:0">Your roadmap</h3></div>
        <div class="card">
          <ol class="timeline">
            ${data.timeline.stages
              .map(
                (s) => `
              <li class="timeline__stage${s.done ? " is-done" : ""}${s.next ? " is-next" : ""}">
                <span class="timeline__dot" aria-hidden="true">${s.done ? "✓" : ""}</span>
                <div class="timeline__body">
                  <div class="timeline__label">${esc(s.label)}${s.next ? ' <span class="chip chip--gold">next</span>' : ""}</div>
                  ${s.next && s.hint ? `<p class="muted timeline__hint">${esc(s.hint)}</p>` : ""}
                </div>
                ${
                  s.kind === "self"
                    ? `<button type="button" class="btn btn--sm ${s.done ? "btn--ghost" : "btn--primary"}" data-milestone="${esc(s.key)}">${s.done ? "Undo" : "Mark done"}</button>`
                    : ""
                }
              </li>`,
              )
              .join("")}
          </ol>
        </div>`;

      const picksCard =
        data.has_profile && data.picks.length
          ? `
        <div class="section-head" style="margin-top:26px"><h3 style="margin:0">Matched to your profile</h3><a class="link-btn" href="/discover">See all</a></div>
        <div class="grid">${data.picks.map(uniCard).join("")}</div>`
          : "";

      const rollup = statusRollup(data.saved.status_counts);
      const savedCard = `
        <div class="section-head" style="margin-top:26px"><h3 style="margin:0">Your shortlist (${data.saved.count})</h3>${data.saved.count ? '<a class="link-btn" href="/saved">View all</a>' : ""}</div>
        ${rollup ? `<p class="muted" style="margin:-4px 0 12px">${esc(rollup)}</p>` : ""}
        ${
          data.saved.count
            ? `<div class="grid">${data.saved.universities.map(uniCard).join("")}</div>`
            : `<div class="card"><p class="muted" style="margin:0">Nothing saved yet — tap “Save” on any university to start comparing your options here.</p></div>`
        }`;

      const scholarshipsCard = data.scholarships.length
        ? `
        <div class="section-head" style="margin-top:26px"><h3 style="margin:0">Scholarship pointers</h3></div>
        <div class="card">
          <p class="muted" style="margin:0 0 12px">Real, named funding schemes for students from <strong>${esc(data.home_country)}</strong>. Always confirm current eligibility, amounts and deadlines on the official page.</p>
          <ul class="journey-scholarships">
            ${data.scholarships
              .map(
                (s) => `
              <li>
                <div><strong>${esc(s.name)}</strong> <span class="chip chip--plain">verify</span></div>
                <p class="muted">${esc(s.note)}</p>
                ${s.website ? `<a href="${esc(s.website)}" target="_blank" rel="noopener noreferrer">Official page ↗</a>` : ""}
              </li>`,
              )
              .join("")}
          </ul>
        </div>`
        : "";

      return `
        <div class="journey">
          <div class="section-head"><h2>Your Dream Plan, ${first}</h2></div>
          ${dreamCard}
          ${nextBestCard}
          ${readinessCard}
          ${timelineCard}
          ${documentsCard}
          ${picksCard}
          ${savedCard}
          ${scholarshipsCard}
        </div>`;
    }

    function recomputeNext() {
      data.timeline.stages.forEach((s) => {
        s.next = false;
      });
      const n = data.timeline.stages.find((s) => !s.done);
      if (n) {
        n.next = true;
        data.timeline.next_key = n.key;
      } else {
        data.timeline.next_key = null;
      }
    }

    // Keys with an in-flight toggle. Guards against rapid clicks racing: a
    // fast done→undo→done could otherwise resolve out of order and leave the
    // server in the wrong state. Persists across paint() (renderJourney scope).
    const milestoneBusy = new Set();

    async function onMilestone(key) {
      const stage = data.timeline.stages.find((s) => s.key === key);
      if (!stage || stage.kind !== "self" || milestoneBusy.has(key)) return;
      const target = !stage.done;
      milestoneBusy.add(key);
      stage.done = target;
      recomputeNext();
      paint(); // optimistic
      try {
        await API.toggleMilestone(key, target);
      } catch (e) {
        stage.done = !target;
        recomputeNext();
        paint();
        toast(e.message, true);
      } finally {
        milestoneBusy.delete(key);
      }
    }

    // Documents change the Documents-readiness bar and possibly the next-best
    // action, so after a successful toggle we refresh the journey payload (one
    // GET) and repaint — keeping readiness + next-best consistent rather than
    // recomputing that logic on the client.
    const docBusy = new Set();
    async function onDocument(key) {
      const doc = data.documents.find((x) => x.key === key);
      if (!doc || docBusy.has(key)) return;
      const target = !doc.done;
      docBusy.add(key);
      doc.done = target;
      paint(); // optimistic check
      try {
        await API.toggleDocument(key, target);
        data = await API.journey();
        paint();
      } catch (e) {
        doc.done = !target;
        paint();
        toast(e.message, true);
      } finally {
        docBusy.delete(key);
      }
    }

    async function onDreamSave(form) {
      const fd = new FormData(form);
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        const { student } = await API.updateDream({
          target_intake: fd.get("target_intake"),
          career_goal: fd.get("career_goal"),
          scholarship_required: fd.get("scholarship_required") === "on",
        });
        state.user = student;
        data = await API.journey(); // scholarship_required feeds readiness
        paint();
        toast("Dream updated");
      } catch (e) {
        btn.disabled = false;
        toast(e.message, true);
      }
    }

    function paint() {
      view.innerHTML = build();
      view.querySelectorAll("[data-milestone]").forEach((btn) => {
        btn.addEventListener("click", () => onMilestone(btn.dataset.milestone));
      });
      view.querySelectorAll("[data-document]").forEach((btn) => {
        btn.addEventListener("click", () => onDocument(btn.dataset.document));
      });
      const editDream = document.getElementById("edit-dream");
      const dreamForm = document.getElementById("dream-form");
      if (editDream && dreamForm) {
        editDream.addEventListener("click", () => {
          dreamForm.hidden = !dreamForm.hidden;
        });
        const cancel = document.getElementById("dream-cancel");
        if (cancel)
          cancel.addEventListener("click", () => {
            dreamForm.hidden = true;
          });
        dreamForm.addEventListener("submit", (e) => {
          e.preventDefault();
          onDreamSave(dreamForm);
        });
      }
    }

    paint();
  }

  async function renderSaved() {
    if (!state.user) {
      navigate("/account?src=gate&next=%2Fsaved", true);
      return;
    }
    setActiveNav("saved");
    document.title = "Saved — Universo";
    view.innerHTML = `<div class="section-head"><h2>Saved universities</h2><span id="cmp-link"></span></div><div id="results" class="grid">${'<div class="skeleton"></div>'.repeat(3)}</div>`;
    try {
      const { universities } = await API.saved();
      state.savedIds = new Set(universities.map((u) => u.id));
      // Comparing needs at least two, so the entry point only appears once it
      // would actually do something.
      if (universities.length >= 2) {
        document.getElementById("cmp-link").innerHTML =
          '<a class="link-btn" href="/compare" data-link>Compare side by side</a>';
      }
      const results = document.getElementById("results");
      results.innerHTML = universities.length
        ? universities.map(savedCell).join("")
        : `<div style="grid-column:1/-1">${emptyState({
            iconName: "bookmark",
            title: "Your shortlist is empty",
            sub: "Tap “Save” on any university to start comparing your options side by side.",
            ctaHref: "/discover",
            ctaLabel: "Browse universities",
          })}</div>`;
      wireStatusSelects(results);
    } catch (e) {
      view.innerHTML = emptyState({
        iconName: "alert",
        title: "Couldn’t load your saved list",
        sub: e.message,
        ctaHref: "/discover",
        ctaLabel: "Back to discover",
      });
    }
  }

  // ---- Compare -------------------------------------------------------------
  // Rows are attributes, columns are universities. The honesty problem a table
  // has and a profile doesn't: a row renders for EVERY university, so a missing
  // value needs a marker that reads as "we don't know" rather than an empty
  // cell, which reads as zero or free. Every gap says "Not verified".
  const UNKNOWN = '<span class="cmp__unknown">Not verified</span>';

  // Same rules as the profile: a tuition figure only when it was actually
  // researched, estimates flagged as estimates. Never a bare number we can't
  // stand behind — see the notes in renderProfile.
  const COMPARE_ROWS = [
    {
      label: "Country",
      get: (u) => esc([u.city, u.country].filter(Boolean).join(", ")),
    },
    {
      label: "Tuition (intl)",
      get: (u) =>
        u.tuition_source === "curated_research" && money(u.tuition_range)
          ? esc(money(u.tuition_range))
          : "",
    },
    {
      label: "Living cost",
      get: (u) => {
        const m = money(u.estimated_living_cost);
        if (!m) return "";
        return u.estimated_living_cost.estimated
          ? `~${esc(m)} <span class="cmp__est">est.</span>`
          : esc(m);
      },
    },
    {
      label: "Language",
      get: (u) =>
        (u.language_of_instruction || []).length
          ? esc(u.language_of_instruction.join(", ")) +
            (u.language_estimated
              ? ' <span class="cmp__est">typical</span>'
              : "")
          : "",
    },
    {
      label: "Degree levels",
      get: (u) => esc((u.degree_levels || []).join(", ")),
    },
    {
      label: "Ranking",
      get: (u) =>
        u.ranking && u.ranking.world_rank
          ? `#${esc(u.ranking.world_rank)} world <span class="cmp__est">${esc(u.ranking.provider)}</span>`
          : "",
    },
    {
      label: "Application deadline",
      get: (u) => esc(u.application_deadline || ""),
    },
    {
      label: "Students",
      get: (u) =>
        u.student_count ? esc(nfmt(u.student_count)) + " enrolled" : "",
    },
  ];

  async function renderCompare() {
    if (!state.user) {
      navigate("/account?src=gate&next=%2Fcompare", true);
      return;
    }
    setActiveNav("saved"); // Compare belongs to the shortlist, which lives under Saved.
    document.title = "Compare — Universo";
    view.innerHTML = `<div class="section-head"><h2>Compare</h2></div><div class="skeleton skeleton--block"></div>`;

    try {
      const { universities } = await API.saved();
      state.savedIds = new Set(universities.map((u) => u.id));

      if (universities.length < 2) {
        view.innerHTML =
          `<div class="section-head"><h2>Compare</h2></div>` +
          emptyState({
            iconName: "bookmark",
            title: universities.length
              ? "Save one more to compare"
              : "Nothing to compare yet",
            sub: universities.length
              ? "Comparing works from two universities up — three to five makes the trade-offs clearest."
              : "Save the universities you're considering and see them side by side.",
            ctaHref: "/discover",
            ctaLabel: "Browse universities",
            secondary: universities.length
              ? '<a class="btn btn--ghost" href="/saved" data-link>View shortlist</a>'
              : "",
          });
        return;
      }

      API.track({
        type: "compare",
        count: universities.length,
        device: deviceGuess(),
      });

      const head = universities
        .map(
          (u) =>
            `<th scope="col"><a href="/university/${esc(u.id)}" data-link>${esc(u.name)}</a></th>`,
        )
        .join("");
      const body = COMPARE_ROWS.map((row) => {
        const cells = universities
          .map((u) => `<td>${row.get(u) || UNKNOWN}</td>`)
          .join("");
        return `<tr><th scope="row">${esc(row.label)}</th>${cells}</tr>`;
      }).join("");

      view.innerHTML = `
        <div class="section-head"><h2>Compare</h2><a class="link-btn" href="/saved" data-link>Back to shortlist</a></div>
        <p class="muted cmp__note">Comparing ${universities.length} saved universities. Blank facts are ones we haven't verified for that university — not zero.</p>
        <div class="cmp-scroll">
          <table class="cmp">
            <thead><tr><th scope="col"><span class="sr-only">Attribute</span></th>${head}</tr></thead>
            <tbody>${body}</tbody>
          </table>
        </div>`;
    } catch (e) {
      view.innerHTML = emptyState({
        iconName: "alert",
        title: "Couldn’t load your comparison",
        sub: e.message,
        ctaHref: "/saved",
        ctaLabel: "Back to shortlist",
      });
    }
  }

  // A saved-list cell = the shared university card plus an editable application
  // status (only shown on Saved — the card itself stays reusable for Discover).
  function savedCell(u) {
    const cur = u.application_status || "considering";
    return `<div class="saved-cell">
      ${uniCard(u)}
      <label class="app-status">
        <span class="app-status__label">Application status</span>
        <select class="app-status__select" data-status-for="${esc(u.id)}">
          ${APP_STATUSES.map(([v, l]) => `<option value="${v}"${v === cur ? " selected" : ""}>${esc(l)}</option>`).join("")}
        </select>
      </label>
    </div>`;
  }

  // An honest one-line dream statement — only the parts the student has set.
  function dreamStatement(d) {
    const fields = (d.fields_of_interest || []).join(", ");
    const countries = (d.country_preference || []).join(", ");
    let s = "Study";
    s += fields
      ? ` <strong>${esc(fields)}</strong>`
      : " <strong>(pick a field)</strong>";
    if (d.degree_level)
      s += ` at <strong>${esc(d.degree_level)}</strong> level`;
    if (countries) s += ` in <strong>${esc(countries)}</strong>`;
    if (d.target_intake)
      s += `, starting <strong>${esc(d.target_intake)}</strong>`;
    s += ".";
    if (d.career_goal)
      s += ` Career goal: <strong>${esc(d.career_goal)}</strong>.`;
    if (d.scholarship_required)
      s += ' <span class="chip chip--gold">scholarship needed</span>';
    return s;
  }

  // Upcoming Fall/Spring intakes for the next ~2.5 years, chronological.
  function intakeOptions(current) {
    const y = new Date().getFullYear();
    const opts = [["", "Not sure yet"]];
    for (let i = 0; i < 3; i++) {
      opts.push([`Fall ${y + i}`, `Fall ${y + i}`]);
      opts.push([`Spring ${y + i + 1}`, `Spring ${y + i + 1}`]);
    }
    return opts
      .map(
        ([v, l]) =>
          `<option value="${v}"${v === current ? " selected" : ""}>${esc(l)}</option>`,
      )
      .join("");
  }

  // "2 considering · 1 applied · 1 offer" — ordered, zero counts skipped.
  function statusRollup(counts) {
    if (!counts) return "";
    return APP_STATUSES.filter(([k]) => counts[k])
      .map(([k, l]) => `${counts[k]} ${l.toLowerCase()}`)
      .join(" · ");
  }

  function wireStatusSelects(root) {
    root.querySelectorAll("[data-status-for]").forEach((sel) => {
      sel.dataset.prev = sel.value;
      sel.addEventListener("change", async () => {
        const id = sel.dataset.statusFor;
        const prev = sel.dataset.prev;
        sel.disabled = true;
        try {
          await API.setApplicationStatus(id, sel.value);
          sel.dataset.prev = sel.value;
          toast("Application status updated");
        } catch (e) {
          sel.value = prev; // revert on failure
          toast(e.message, true);
        } finally {
          sel.disabled = false;
        }
      });
    });
  }

  async function renderProfile(id) {
    setActiveNav("discover");
    view.innerHTML = `<div class="skeleton" style="height:320px"></div>`;
    let u;
    try {
      ({ university: u } = await API.university(id));
    } catch (e) {
      view.innerHTML = `<a class="back-link" href="/discover">← Back</a>${emptyState({ iconName: "alert", title: "University not found", sub: e.message, ctaHref: "/discover", ctaLabel: "Back to discover" })}`;
      return;
    }

    trackProfileView(u.id);
    document.title = `${u.name} — Universo`;
    const saved = state.savedIds.has(u.id);
    const src = u.source || (u.tuition_range ? "curated" : "global");
    const isCurated = src === "curated";

    const facts = [];
    if (u.ranking && u.ranking.world_rank) {
      const nat = u.ranking.national_rank
        ? ` · #${u.ranking.national_rank} nationally`
        : "";
      facts.push([
        "Ranking",
        `#${u.ranking.world_rank} world${nat} (${u.ranking.provider})`,
      ]);
    }
    // A specific tuition figure is shown ONLY when it comes from hand-curated
    // research (tuition_source 'curated_research'). Country-level estimate
    // ranges stay internal (they power the budget filter) — displaying them as
    // numbers reads as fabricated per-university data, which it isn't.
    // If we don't have a researched figure, the row is OMITTED rather than
    // filled with a "Check official site" link — a row that looks answered but
    // isn't isn't honest. The unverified notice below carries that message once.
    const tuit = money(u.tuition_range);
    if (tuit && u.tuition_source === "curated_research")
      facts.push(["Tuition (intl)", tuit]);
    const living = money(u.estimated_living_cost);
    if (living)
      facts.push([
        `Living cost${u.estimated_living_cost.estimated ? " · est." : ""}`,
        u.estimated_living_cost.estimated ? `~${living}` : living,
      ]);
    if (u.institution_type)
      facts.push(["Institution type", u.institution_type]);
    if (u.legal_status) facts.push(["Legal status", u.legal_status]);
    if (u.founded) facts.push(["Founded", String(u.founded)]);
    if (u.student_count)
      facts.push(["Students", `${nfmt(u.student_count)} enrolled`]);
    if ((u.language_of_instruction || []).length)
      facts.push([
        `Language${u.language_estimated ? " · typical" : ""}`,
        u.language_of_instruction.join(", "),
      ]);
    if ((u.degree_levels || []).length)
      facts.push(["Degree levels", u.degree_levels.join(", ")]);
    if (u.application_deadline)
      facts.push(["Application deadline", u.application_deadline]);
    if (u.website)
      facts.push([
        "Website",
        `<a href="${esc(u.website)}" target="_blank" rel="noopener">${esc(domainOf(u))} ↗</a>`,
      ]);

    const HTML_FACTS = new Set(["Website", "Tuition (intl)"]); // rows whose value is pre-built, trusted markup
    const factCards = facts
      .map(
        ([k, v]) =>
          `<div class="info-item"><div class="k">${esc(k)}</div><div class="v">${HTML_FACTS.has(k) ? v : esc(v)}</div></div>`,
      )
      .join("");
    const section = (title, inner) =>
      inner
        ? `<div class="info-card"><h3>${esc(title)}</h3>${inner}</div>`
        : "";
    const taglist = (arr, cls) =>
      (arr || []).length
        ? `<div class="taglist">${arr.map((p) => `<span class="chip ${cls}">${esc(p)}</span>`).join("")}</div>`
        : "";

    function scholarshipsSection(list) {
      if (!list || !list.length) return "";
      const rows = list
        .map(
          (s) => `
        <div class="scholarship-row">
          <div class="scholarship-name">${s.website ? `<a href="${esc(s.website)}" target="_blank" rel="noopener">${esc(s.name)} ↗</a>` : esc(s.name)}</div>
          <p class="scholarship-note muted">${esc(s.note || "")}</p>
        </div>`,
        )
        .join("");
      return `<div class="info-card">
        <h3>Scholarships &amp; funding</h3>
        <p class="muted" style="margin:0 0 10px;font-size:.82rem">General funding routes for students studying in ${esc(u.country)} — not specific to this university. Always confirm current eligibility and amounts on the official page.</p>
        ${rows}
      </div>`;
    }

    const banner = {
      curated:
        "Tuition, deadlines and requirements below are <strong>best-effort estimates</strong> — verify on the university’s official page before you rely on them.",
      eter: "Profile data comes from the <strong>ETER register</strong> (European statistics only). Tuition, programs, deadlines and admission details are not included — check the official website.",
      global:
        "This is a <strong>basic listing</strong> from a global universities directory. Tuition, programs, deadlines and admission details are not included — check the official website.",
    }[src];
    const sourceNote = {
      curated: "Universo curated data",
      eter: `ETER — European Tertiary Education Register${u.ref_year ? `, reference year ${u.ref_year}` : ""}`,
      global: "Global universities directory (Hipolabs open dataset)",
    }[src];

    view.innerHTML = `
      <a class="back-link" href="/discover">← Back to discover</a>
      <div class="profile__cover" id="cover" style="background:${gradient(u.id)}">
        <div class="profile__headline">
          ${logoHtml(u, "logo--profile")}
          <div class="profile__title"><h1>${esc(u.name)}</h1><div class="loc">${icon("pin", 14)} ${esc(u.city ? u.city + ", " : "")}${esc(u.country)}</div></div>
        </div>
      </div>
      <p class="photo-credit" id="photo-credit" hidden></p>

      <div class="profile__actions">
        <button class="btn ${saved ? "btn--saved" : "btn--ghost"}" data-save="${esc(u.id)}">${saved ? `${icon("bookmark", 15)} Saved` : "＋ Save"}</button>
        <button class="btn btn--gold" id="apply-btn">Apply Now ↗</button>
      </div>

      ${
        u.match_explanation
          ? `
        <div class="fit-card">
          <h3>🎯 Why this might fit you</h3>
          <p class="fit-sentence">${esc(u.match_explanation)}</p>
          ${(u.match_reasons || []).length ? `<div class="taglist" style="margin-top:8px">${u.match_reasons.map((r) => `<span class="chip chip--gold">${esc(r)}</span>`).join("")}</div>` : ""}
          <p class="muted" style="margin:8px 0 0;font-size:.8rem">Based on your profile. <a href="/onboarding">Update it</a> to refine your matches.</p>
        </div>`
          : state.user
            ? `
        <div class="fit-card">
          <p style="margin:0">Set up your matching profile to see why this university does or doesn't fit you.</p>
          <a class="btn btn--primary btn--sm" href="/onboarding" style="margin-top:8px">Set up matching (30 sec)</a>
        </div>`
            : `
        <p class="quick-facts muted">${quickFactsLine(u)}</p>
        <div class="signup-nudge">
          <div><strong>Comparing schools?</strong> Create a free account to save this university and see why it fits your field, budget and target degree.</div>
          <a class="btn btn--primary btn--sm" href="/account?mode=register&src=profile&next=${encodeURIComponent("/university/" + u.id)}">Sign up free</a>
        </div>`
      }

      ${
        isCurated
          ? `<div class="verify-flag"><span>${icon("alert", 16)}</span><span>${banner}</span></div>`
          : `<div class="unverified-note">
             <strong>We have not verified tuition, programs or entry requirements for this university yet.</strong>
             Everything on this page comes from the official European register (ETER).
             ${u.website ? `Check <a href="${esc(u.website)}" target="_blank" rel="noopener">the official website</a> for fees and admission details.` : ""}
           </div>`
      }
      <div class="info-card"><h3>Overview</h3><p id="overview-text" style="margin:0;color:var(--ink-soft)">${esc(u.short_description || "")}</p></div>
      ${facts.length ? `<div class="info-card"><h3>Key facts</h3><div class="info-grid">${factCards}</div>${(u.estimated_living_cost && u.estimated_living_cost.estimated) || u.language_estimated ? '<p class="muted" style="margin:10px 0 0;font-size:.82rem">~ / “est.” / “typical” = <strong>country-level estimate</strong>, not verified per-university. Confirm with the university.</p>' : ""}</div>` : ""}
      ${section("Programs offered", taglist(u.programs_offered, "chip"))}
      ${section("Fields of study", taglist(u.fields_of_study, "chip--gold"))}
      ${section("Admission requirements", u.acceptance_requirements ? `<p style="margin:0;color:var(--ink-soft)">${esc(u.acceptance_requirements)}</p>` : "")}
      ${scholarshipsSection(u.scholarships)}

      <div class="info-card" style="text-align:center">
        <p class="muted" style="margin:0 0 10px">${isCurated ? "Ready to start your application?" : "Continue on the official university website"}</p>
        <button class="btn btn--gold btn--block" id="apply-btn-2">${isCurated ? "Apply on official site ↗" : "Visit official website ↗"}</button>
      </div>
      ${
        u.claimed_status === "claimed"
          ? ""
          : `
        <p class="claim-cta">Work at ${esc(u.name)}? <a href="/for-universities#claim">Claim this profile</a> to reach students directly and see your engagement analytics.</p>`
      }
      <p class="source-note muted">Source: ${sourceNote}${u.data_fetched_at ? ` · data as of ${esc(String(u.data_fetched_at).slice(0, 10))}` : ""}.</p>`;

    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(u.name + " university official site")}`;
    const doApply = async () => {
      let link = u.application_link || u.website || "";
      try {
        const r = await API.applyClick(u.id);
        link = r.application_link || link;
      } catch {
        /* still open best link */
      }
      window.open(link || searchUrl, "_blank", "noopener");
    };
    document.getElementById("apply-btn").addEventListener("click", doApply);
    document.getElementById("apply-btn-2").addEventListener("click", doApply);

    API.photo(u.id)
      .then((r) => {
        if (!r) return;
        // A richer Wikipedia overview beats the synthetic one-liner where available.
        if (r.extract) {
          const ov = document.getElementById("overview-text");
          if (ov) ov.textContent = r.extract;
        }
        if (!r.photo_url) return;
        const cover = document.getElementById("cover");
        if (cover) {
          cover.style.background = `linear-gradient(rgba(11,31,58,.30), rgba(11,31,58,.60)), url("${r.photo_url}") center/cover no-repeat`;
          cover.classList.add("profile__cover--photo");
        }
        if (r.attribution && r.attribution.artist) {
          const c = document.getElementById("photo-credit");
          if (c) {
            const a = r.attribution;
            const credit = `Photo: ${esc(a.artist)}${a.license ? " (" + esc(a.license) + ")" : ""} · Wikimedia Commons`;
            c.innerHTML = a.source
              ? `<a href="${esc(a.source)}" target="_blank" rel="noopener">${credit}</a>`
              : credit;
            c.hidden = false;
          }
        }
      })
      .catch(() => {});
  }

  // ---- account ------------------------------------------------------------
  // Where to send the user after auth + which CTA brought them here (funnel
  // attribution). Captured from the URL when the account page renders.
  let authCtx = { next: "", src: "" };

  function renderAccount(initialMode) {
    setActiveNav("account");
    document.title = "Account — Universo";
    if (state.user) return renderAccountLoggedIn();
    const params = new URLSearchParams(location.search);
    const next = params.get("next") || "";
    authCtx = {
      next: next.startsWith("/") ? next : "",
      src: params.get("src") || "",
    };
    renderAuthForms(initialMode === "register" ? "register" : "login");
  }

  function renderAccountLoggedIn() {
    const u = state.user;
    const savedCount = state.savedIds.size;
    view.innerHTML = `
      <div class="section-head"><h2>Your account</h2></div>
      <div class="card">
        <div class="account-head">
          <div class="avatar">${esc(initials(u.full_name))}</div>
          <div><h2 style="margin:0;font-size:1.2rem">${esc(u.full_name)}</h2>
            <div class="muted">${esc(u.email)} <button class="link-btn" id="change-email-toggle" style="font-size:.85em">Change</button></div>
          </div>
        </div>
        <form id="change-email-form" hidden style="margin-top:10px">
          <div id="change-email-error" class="form-error" hidden></div>
          <div class="form-group"><label style="font-size:.85rem">New email</label><input type="email" name="new_email" required autocomplete="email" /></div>
          <div class="form-group"><label style="font-size:.85rem">Current password</label><input type="password" name="password" required autocomplete="current-password" /></div>
          <div style="display:flex;gap:10px">
            <button class="btn btn--primary btn--sm" type="submit" id="change-email-submit" style="flex:1">Update email</button>
            <button class="btn btn--ghost btn--sm" type="button" id="change-email-cancel" style="flex:1">Cancel</button>
          </div>
        </form>
        ${
          u.email_verification_required && !u.email_verified
            ? `
        <div class="auth-gate-note" style="margin-top:14px">
          ${icon("alert", 16)}
          <span>Please verify your email — check your inbox for the link, or <button class="link-btn" id="resend-verification" style="font:inherit">resend it</button>.</span>
        </div>`
            : ""
        }
        <div class="section-head" style="margin:14px 2px 8px"><h3 style="font-size:.95rem;margin:0">Matching profile</h3><button class="link-btn" id="edit-profile">Edit</button></div>
        ${
          u.profile_completed
            ? `
        <div class="profile-facts">
          <div class="info-item"><div class="k">Fields of interest</div><div class="v">${(u.fields_of_interest || []).map(esc).join(", ") || "—"}</div></div>
          <div class="info-item"><div class="k">Target degree</div><div class="v">${esc(u.degree_level || "—")}</div></div>
          <div class="info-item"><div class="k">Budget (max €/yr)</div><div class="v">${u.budget_max_eur_year != null ? "€" + nfmt(u.budget_max_eur_year) : "—"}</div></div>
          <div class="info-item"><div class="k">Study languages</div><div class="v">${(u.preferred_languages || []).map(esc).join(", ") || "—"}</div></div>
          <div class="info-item"><div class="k">City preference</div><div class="v">${esc((MATCH.CITY.find((c) => c[0] === u.city_preference) || [, "—"])[1])}</div></div>
          <div class="info-item"><div class="k">Countries</div><div class="v">${(u.country_preference || []).map(esc).join(", ") || "No preference"}</div></div>
        </div>`
            : `
        <div class="fit-card" style="margin-top:0">
          <p style="margin:0">Set your profile to switch on personalized matching — ranked results and a "why this fits" line on every university.</p>
          <button class="btn btn--primary btn--sm" id="start-onboarding" style="margin-top:10px">Set up matching (30 sec)</button>
        </div>`
        }
        <div style="margin-top:18px;display:flex;gap:10px">
          <a class="btn btn--ghost" href="/saved" style="flex:1">View saved (${savedCount})</a>
          <button class="btn btn--primary" id="logout" style="flex:1">Log out</button>
        </div>
        <hr class="divider" />
        <h3 style="font-size:.95rem;margin:0 0 8px">Security</h3>
        <p class="muted" style="margin:0 0 10px;font-size:.85rem">Signed in somewhere you don't recognize, or lost a device? End every other session — you'll need to log back in here too.</p>
        <button class="btn btn--ghost btn--sm" id="logout-everywhere" style="width:100%">Log out of all devices</button>
        <hr class="divider" />
        <h3 style="font-size:.95rem;margin:0 0 8px">Your data (GDPR)</h3>
        <p class="muted" style="margin:0 0 10px;font-size:.85rem">Download everything we store about you, or delete your account permanently.</p>
        <div style="display:flex;gap:10px">
          <button class="btn btn--ghost btn--sm" id="export-data" style="flex:1">Export my data</button>
          <button class="btn btn--sm btn--danger" id="delete-account" style="flex:1">Delete account</button>
        </div>
      </div>`;

    const changeEmailForm = document.getElementById("change-email-form");
    document
      .getElementById("change-email-toggle")
      .addEventListener("click", () => {
        changeEmailForm.hidden = !changeEmailForm.hidden;
      });
    document
      .getElementById("change-email-cancel")
      .addEventListener("click", () => {
        changeEmailForm.hidden = true;
        changeEmailForm.reset();
        document.getElementById("change-email-error").hidden = true;
      });
    changeEmailForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const errBox = document.getElementById("change-email-error");
      errBox.hidden = true;
      const fd = new FormData(changeEmailForm);
      const btn = document.getElementById("change-email-submit");
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>';
      try {
        const { student } = await API.changeEmail(
          fd.get("new_email"),
          fd.get("password"),
        );
        state.user = student;
        toast(
          student.email_verification_required
            ? "Email updated — check your inbox to verify it"
            : "Email updated",
        );
        renderAccountLoggedIn();
      } catch (err) {
        errBox.textContent = err.message;
        errBox.hidden = false;
        btn.disabled = false;
        btn.textContent = "Update email";
      }
    });

    const resendBtn = document.getElementById("resend-verification");
    if (resendBtn)
      resendBtn.addEventListener("click", async () => {
        resendBtn.disabled = true;
        try {
          await API.resendVerification();
          toast("Verification email sent");
        } catch (e) {
          toast(e.message, true);
        } finally {
          resendBtn.disabled = false;
        }
      });
    document.getElementById("logout").addEventListener("click", async () => {
      try {
        await API.logout();
      } catch {
        /* ignore */
      }
      state.user = null;
      state.savedIds = new Set();
      toast("Logged out");
      go("/discover");
    });
    document
      .getElementById("logout-everywhere")
      .addEventListener("click", async () => {
        if (
          !confirm(
            "End every other session? You'll be logged out here too and need to log back in.",
          )
        )
          return;
        try {
          await API.logoutEverywhere();
          state.user = null;
          state.savedIds = new Set();
          toast("Logged out everywhere");
          go("/discover");
        } catch (e) {
          toast(e.message, true);
        }
      });
    document
      .getElementById("export-data")
      .addEventListener("click", async () => {
        try {
          const data = await API.exportData();
          const blob = new Blob([JSON.stringify(data, null, 2)], {
            type: "application/json",
          });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = "universo-my-data.json";
          a.click();
          URL.revokeObjectURL(a.href);
          toast("Data exported");
        } catch (e) {
          toast(e.message, true);
        }
      });
    document
      .getElementById("delete-account")
      .addEventListener("click", async () => {
        if (
          !confirm(
            "Permanently delete your account and saved list? This cannot be undone.",
          )
        )
          return;
        try {
          await API.deleteAccount();
          state.user = null;
          state.savedIds = new Set();
          toast("Account deleted");
          location.href = "/";
        } catch (e) {
          toast(e.message, true);
        }
      });
    const startBtn = document.getElementById("start-onboarding");
    if (startBtn) startBtn.addEventListener("click", () => go("/onboarding"));
    document
      .getElementById("edit-profile")
      .addEventListener("click", () => go("/onboarding"));
  }

  // ---- matching profile: control builders ---------------------------------
  // A toggle-chip multi-select backed by the module-level `draft`. Clicks are
  // handled by one delegated listener that mutates draft and re-renders.
  function chips(key, options, opts) {
    const max = opts && opts.max;
    const sel = draft[key];
    return `<div class="chip-select" data-chipset="${key}">${options
      .map((o) => {
        const [val, label] = Array.isArray(o) ? o : [o, o];
        const on = Array.isArray(sel) ? sel.includes(val) : sel === val;
        return `<button type="button" class="pick ${on ? "is-on" : ""}" data-chip="${key}" data-val="${esc(val)}"${max ? ` data-max="${max}"` : ""}>${esc(label)}</button>`;
      })
      .join("")}</div>`;
  }

  function onDraftClick(e) {
    const chip = e.target.closest("[data-chip]");
    if (!chip) return;
    const key = chip.dataset.chip;
    const val = chip.dataset.val;
    const cur = draft[key];
    if (Array.isArray(cur)) {
      const i = cur.indexOf(val);
      if (i >= 0) cur.splice(i, 1);
      else {
        const max = Number(chip.dataset.max || 0);
        if (!max || cur.length < max) cur.push(val);
        else toast(`Pick up to ${max}`, true);
      }
    } else {
      draft[key] = cur === val ? "" : val; // single-select toggle
    }
    render(); // cheap re-render of the current onboarding step / editor
  }

  // ---- onboarding wizard (also the /account editor) -----------------------
  const ONBOARD_STEPS = [
    {
      key: "fields",
      title: "What do you want to study?",
      sub: "Pick up to 3 — this drives your matches.",
    },
    {
      key: "degree",
      title: "Level & budget",
      sub: "What are you aiming for, and what can you afford per year?",
    },
    {
      key: "langs",
      title: "Which languages can you study in?",
      sub: "Not your nationality — the languages you could take a degree in.",
    },
    {
      key: "place",
      title: "Where would you like to be?",
      sub: "All optional — leave blank for no preference.",
    },
  ];

  async function renderOnboarding() {
    if (!state.user) {
      navigate("/account?mode=register&next=%2Fonboarding", true);
      return;
    }
    // Onboarding is a focused wizard, not one of the four tabs — highlighting
    // Account claimed the user was somewhere they weren't. No tab is the honest
    // answer here; setActiveNav(null) matches nothing and clears them all.
    setActiveNav(null);
    document.title = "Set up matching — Universo";
    // The country step needs the facet list — load it once, then re-render.
    if (!state.filterMeta) {
      try {
        state.filterMeta = await API.filters();
        render();
        return;
      } catch {
        state.filterMeta = { countries: [] };
      }
    }
    if (!draft) {
      const u = state.user;
      draft = {
        fields_of_interest: [...(u.fields_of_interest || [])],
        budget_max_eur_year:
          u.budget_max_eur_year != null ? String(u.budget_max_eur_year) : "",
        preferred_languages: [...(u.preferred_languages || [])],
        degree_level: u.degree_level || "",
        city_preference: u.city_preference || "",
        country_preference: [...(u.country_preference || [])],
        home_country: u.home_country || u.country_of_origin || "",
      };
      draft._step = 0;
    }
    const step = ONBOARD_STEPS[draft._step];
    const countries = (state.filterMeta && state.filterMeta.countries) || [];

    let body = "";
    if (step.key === "fields") {
      body = chips("fields_of_interest", MATCH.FIELDS, { max: 3 });
    } else if (step.key === "degree") {
      body = `<label class="onb-label">Target degree</label>${chips("degree_level", MATCH.DEGREES)}
        <label class="onb-label" style="margin-top:16px">Max tuition you can afford (€ / year)</label>
        <input id="onb-budget" type="number" min="0" step="500" inputmode="numeric" placeholder="e.g. 6000" value="${esc(draft.budget_max_eur_year)}" class="onb-input" />`;
    } else if (step.key === "langs") {
      body = chips("preferred_languages", MATCH.LANGUAGES, { max: 6 });
    } else {
      body = `<label class="onb-label">City size</label>${chips("city_preference", MATCH.CITY)}
        <label class="onb-label" style="margin-top:16px">Countries (optional — pick any)</label>${chips("country_preference", countries)}
        <label class="onb-label" style="margin-top:16px">Home country (for language/visa context only)</label>
        <input id="onb-home" type="text" placeholder="e.g. Mongolia" value="${esc(draft.home_country)}" class="onb-input" />`;
    }

    const last = draft._step === ONBOARD_STEPS.length - 1;
    view.innerHTML = `
      <div class="onb">
        <div class="onb-progress">${ONBOARD_STEPS.map((_, i) => `<span class="${i <= draft._step ? "on" : ""}"></span>`).join("")}</div>
        <p class="muted" style="margin:0 0 2px">Step ${draft._step + 1} of ${ONBOARD_STEPS.length}</p>
        <h2 style="margin:0 0 4px">${esc(step.title)}</h2>
        <p class="muted" style="margin:0 0 16px">${esc(step.sub)}</p>
        ${body}
        <div class="onb-nav">
          ${draft._step > 0 ? '<button class="btn btn--ghost" id="onb-back">Back</button>' : '<a class="btn btn--ghost" href="/discover">Skip for now</a>'}
          <button class="btn btn--primary" id="onb-next">${last ? "Save & see matches" : "Next"}</button>
        </div>
      </div>`;

    const budgetEl = document.getElementById("onb-budget");
    if (budgetEl)
      budgetEl.addEventListener("input", (e) => {
        draft.budget_max_eur_year = e.target.value;
      });
    const homeEl = document.getElementById("onb-home");
    if (homeEl)
      homeEl.addEventListener("input", (e) => {
        draft.home_country = e.target.value;
      });
    const backBtn = document.getElementById("onb-back");
    if (backBtn)
      backBtn.addEventListener("click", () => {
        draft._step--;
        render();
      });
    document.getElementById("onb-next").addEventListener("click", async () => {
      if (!last) {
        draft._step++;
        render();
        return;
      }
      const btn = document.getElementById("onb-next");
      btn.disabled = true;
      btn.textContent = "Saving…";
      try {
        const payload = {
          fields_of_interest: draft.fields_of_interest,
          budget_max_eur_year:
            draft.budget_max_eur_year === ""
              ? null
              : Number(draft.budget_max_eur_year),
          preferred_languages: draft.preferred_languages,
          degree_level: draft.degree_level,
          city_preference: draft.city_preference,
          country_preference: draft.country_preference,
          home_country: draft.home_country,
        };
        const { student } = await API.updateProfile(payload);
        state.user = student;
        draft = null;
        toast("Matching is on — results are now ranked for you");
        go("/discover");
      } catch (e) {
        toast(e.message, true);
        btn.disabled = false;
        btn.textContent = "Save & see matches";
      }
    });
  }

  function renderAuthForms(mode) {
    setActiveNav("account");
    const isLogin = mode === "login";
    // The gate message explains WHY the visitor landed here instead of the
    // page they clicked toward — a silent bounce reads as a broken link.
    const gateNote =
      authCtx.src === "gate"
        ? `<div class="auth-gate-note">${icon("lock", 16)} <span>Universo is free — create an account (or log in) to start exploring universities.</span></div>`
        : "";
    view.innerHTML = `
      <div class="auth-card">
        <div class="auth-card__brand">
          <span class="brand__mark" aria-hidden="true">
            <svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
              <path fill="currentColor" d="M18 20 C -6 80 40 165 100 190 C 96 140 90 60 88 15 Z"/>
              <path fill="currentColor" d="M182 20 C 206 80 160 165 100 190 C 104 140 110 60 112 15 Z"/>
            </svg>
          </span>
          <div>
            <div class="auth-card__name">Universo</div>
            <div class="auth-card__tag">Same Start. Equal Chance.</div>
          </div>
        </div>
        <div class="card auth-card__body">
          ${gateNote}
          <div class="tabs"><button class="${isLogin ? "is-active" : ""}" data-mode="login">Log in</button><button class="${!isLogin ? "is-active" : ""}" data-mode="register">Sign up</button></div>
          <div id="auth-error" class="form-error" hidden></div>
          ${isLogin ? loginForm() : registerForm()}
        </div>
      </div>`;
    view
      .querySelectorAll("[data-mode]")
      .forEach((b) =>
        b.addEventListener("click", () => renderAuthForms(b.dataset.mode)),
      );
    if (isLogin) wireLogin();
    else wireRegister();
  }

  function loginForm() {
    return `<h2>Welcome back</h2><p class="muted" style="margin-top:0">Log in to pick up your shortlist where you left off.</p>
      <form id="login-form">
        <div class="form-group"><label>Email</label><input type="email" name="email" required autocomplete="email" /></div>
        <div class="form-group"><label>Password</label><input type="password" name="password" required autocomplete="current-password" /></div>
        <button class="btn btn--primary btn--block" type="submit" id="login-submit">Log in</button>
        <p class="auth-fineprint"><a href="/forgot-password">Forgot your password?</a></p>
      </form>`;
  }

  function registerForm() {
    return `<h2>Create your free account</h2><p class="muted" style="margin-top:0">300 verified EU profiles plus 4,000 more European institutions — save a shortlist and get matches for your profile.</p>
      <form id="register-form">
        <div class="form-group"><label>Full name *</label><input type="text" name="full_name" required autocomplete="name" /></div>
        <div class="form-group"><label>Email *</label><input type="email" name="email" required autocomplete="email" /></div>
        <div class="form-group"><label>Password * <span class="muted">(min 8 characters)</span></label><input type="password" name="password" required minlength="8" autocomplete="new-password" /></div>
        <div class="form-group"><label>Country of origin</label><input type="text" name="country_of_origin" placeholder="e.g. Mongolia" /></div>
        <div class="form-group"><label>Field of interest</label><input type="text" name="field_of_interest" placeholder="e.g. Computer Science" /></div>
        <div class="form-group"><label>Target degree level</label><select name="target_degree_level"><option value="">Select…</option><option>Bachelor</option><option>Master</option><option>PhD</option></select></div>
        <div class="form-group"><label class="consent"><input type="checkbox" name="consent" /><span>I have read and accept the <a href="/privacy">privacy policy</a>, and consent to Universo storing my account data. *</span></label></div>
        <div class="form-group"><label class="consent"><input type="checkbox" name="updates_optin" /><span>Email me when new universities and scholarships are added. <span class="muted">(optional, unsubscribe any time)</span></span></label></div>
        <button class="btn btn--primary btn--block" type="submit" id="register-submit">Create account</button>
        <p class="muted auth-fineprint">Free for students, always. We never sell your data.</p>
      </form>`;
  }

  function showAuthError(msg) {
    const box = document.getElementById("auth-error");
    box.textContent = msg;
    box.hidden = !msg;
  }

  async function afterAuth(data, isNew) {
    state.user = data.student;
    state.savedIds = new Set(data.student.saved_universities || []);
    toast(`Welcome, ${data.student.full_name.split(" ")[0]}!`);
    // A brand-new account with no matching profile yet goes through onboarding
    // once (unless they were mid-flow toward a specific page). Everyone else
    // lands where they were headed.
    const next =
      authCtx.next ||
      (isNew && !data.student.profile_completed ? "/onboarding" : "/discover");
    go(next);
    authCtx = { next: "", src: "" };
  }

  function wireLogin() {
    const form = document.getElementById("login-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      showAuthError("");
      const btn = document.getElementById("login-submit");
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>';
      const fd = new FormData(form);
      try {
        await afterAuth(
          await API.login({
            email: fd.get("email"),
            password: fd.get("password"),
          }),
        );
      } catch (err) {
        showAuthError(err.message);
        btn.disabled = false;
        btn.textContent = "Log in";
      }
    });
  }

  function wireRegister() {
    const form = document.getElementById("register-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      showAuthError("");
      const fd = new FormData(form);
      if (!fd.get("consent")) {
        showAuthError("Please accept the privacy policy to continue.");
        return;
      }
      const btn = document.getElementById("register-submit");
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>';
      try {
        await afterAuth(
          await API.register({
            full_name: fd.get("full_name"),
            email: fd.get("email"),
            password: fd.get("password"),
            country_of_origin: fd.get("country_of_origin"),
            field_of_interest: fd.get("field_of_interest"),
            target_degree_level: fd.get("target_degree_level"),
            consent: fd.get("consent") === "on",
            updates_optin: fd.get("updates_optin") === "on",
            src: authCtx.src || undefined,
          }),
          true,
        );
      } catch (err) {
        showAuthError(err.message);
        btn.disabled = false;
        btn.textContent = "Create account";
      }
    });
  }

  function renderPrivacy() {
    setActiveNav("account");
    document.title = "Privacy — Universo";
    view.innerHTML = `
      <a class="back-link" href="/account">← Back</a>
      <div class="card" style="max-width:640px">
        <h2>Privacy policy</h2>
        <p class="muted">Placeholder for MVP — replace with a reviewed policy before public launch.</p>
        <p>Universo stores the account details you provide (name, email, country of origin, field of interest, target degree level) and the universities you save. Your password is stored only as a secure bcrypt hash.</p>
        <p>We record anonymous, non-identifying behavioral events — page views, searches, filters used, saves, and Apply-Now clicks — to understand how the site is used and improve it. These are tied to a random anonymous browser id (a cookie), never to your name or email, and we do not send your details to any university. An internal, password-protected admin dashboard uses this data in aggregate (traffic, popular universities, funnel and retention metrics) — it is not sold or shared with third parties.</p>
        <p>You can <strong>export</strong> your account data, or <strong>permanently delete</strong> your account at any time from the Account page. Deleting your account also erases the anonymous behavioral history linked to it.</p>
      </div>`;
  }

  // =========================================================================
  // Email verification + password reset
  // =========================================================================

  async function renderVerifyEmail() {
    setActiveNav("account");
    document.title = "Verify email — Universo";
    const token = new URLSearchParams(location.search).get("token") || "";
    if (!token) {
      view.innerHTML = emptyState({
        iconName: "alert",
        title: "Missing verification link",
        sub: "This link looks incomplete. Open the link from your email again, or request a new one from your account.",
        ctaHref: "/account",
        ctaLabel: "Go to account",
      });
      return;
    }
    view.innerHTML = `<div class="empty-card"><div class="empty-card__icon">${icon("spark")}</div><h3>Verifying your email…</h3></div>`;
    try {
      await API.verifyEmail(token);
      if (state.user) state.user.email_verified = true;
      toast("Email verified");
      view.innerHTML = emptyState({
        iconName: "check",
        title: "You're verified",
        sub: "Your Universo account is fully active.",
        ctaHref: state.user ? "/account" : "/account?mode=login",
        ctaLabel: state.user ? "Go to account" : "Log in",
      });
    } catch (e) {
      view.innerHTML = emptyState({
        iconName: "alert",
        title: "This link is invalid or has expired",
        sub: e.message,
        ctaHref: "/account",
        ctaLabel: "Go to account",
      });
    }
  }

  function renderForgotPassword() {
    setActiveNav("account");
    document.title = "Reset your password — Universo";
    view.innerHTML = `
      <div class="auth-card">
        <div class="card auth-card__body">
          <h2>Reset your password</h2>
          <p class="muted" style="margin-top:0">Enter your account email — we'll send a reset link if it matches an account.</p>
          <div id="auth-error" class="form-error" hidden></div>
          <div id="forgot-success" class="form-success" hidden>Check your email for a reset link. It expires in 1 hour.</div>
          <form id="forgot-form">
            <div class="form-group"><label>Email</label><input type="email" name="email" required autocomplete="email" /></div>
            <button class="btn btn--primary btn--block" type="submit" id="forgot-submit">Send reset link</button>
          </form>
          <p class="auth-fineprint"><a href="/account?mode=login">Back to log in</a></p>
        </div>
      </div>`;
    const form = document.getElementById("forgot-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      showAuthError("");
      const btn = document.getElementById("forgot-submit");
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>';
      const fd = new FormData(form);
      try {
        await API.forgotPassword(fd.get("email"));
        form.hidden = true;
        document.getElementById("forgot-success").hidden = false;
      } catch (err) {
        showAuthError(err.message);
        btn.disabled = false;
        btn.textContent = "Send reset link";
      }
    });
  }

  function renderResetPassword() {
    setActiveNav("account");
    document.title = "Choose a new password — Universo";
    const token = new URLSearchParams(location.search).get("token") || "";
    if (!token) {
      view.innerHTML = emptyState({
        iconName: "alert",
        title: "Missing reset link",
        sub: "Open the link from your email again, or request a new one.",
        ctaHref: "/forgot-password",
        ctaLabel: "Request a new link",
      });
      return;
    }
    view.innerHTML = `
      <div class="auth-card">
        <div class="card auth-card__body">
          <h2>Choose a new password</h2>
          <div id="auth-error" class="form-error" hidden></div>
          <form id="reset-form">
            <div class="form-group"><label>New password <span class="muted">(min 8 characters)</span></label><input type="password" name="password" required minlength="8" autocomplete="new-password" /></div>
            <button class="btn btn--primary btn--block" type="submit" id="reset-submit">Set new password</button>
          </form>
        </div>
      </div>`;
    document
      .getElementById("reset-form")
      .addEventListener("submit", async (e) => {
        e.preventDefault();
        showAuthError("");
        const form = e.target;
        const btn = document.getElementById("reset-submit");
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span>';
        const fd = new FormData(form);
        try {
          await API.resetPassword(token, fd.get("password"));
          // The server clears the session on reset — every device (including
          // this one) needs to log in fresh with the new password.
          state.user = null;
          state.savedIds = new Set();
          toast("Password updated — log in with your new password");
          navigate("/account?mode=login", true);
        } catch (err) {
          showAuthError(err.message);
          btn.disabled = false;
          btn.textContent = "Set new password";
        }
      });
  }

  // =========================================================================
  // Router + error boundary
  // =========================================================================
  function render() {
    const parts = location.pathname.split("/").filter(Boolean);
    window.scrollTo(0, 0);
    view.focus({ preventScroll: true });

    // "/" is the marketing landing page, served as its own static page — the
    // SPA should never actually be asked to render it. If it ever is (e.g. a
    // stale link), send the visitor on into the app rather than show nothing.
    if (parts.length === 0) {
      navigate("/discover", true);
      return;
    }

    // Profile views are tracked inside renderProfile (with the university id,
    // once it's confirmed to exist); every other route is a generic pageview.
    // The very first render is skipped for /discover — the server records that
    // pageview itself (so anonymous first visits are counted even without JS),
    // and beaconing here too would double-count it.
    const isProfile = parts[0] === "university" && parts[1];
    const serverCounted = !render._ranOnce && parts[0] === "discover";
    render._ranOnce = true;
    if (!isProfile && !serverCounted) trackPageview(location.pathname);

    let p;
    try {
      if (parts[0] === "discover") p = renderDiscover();
      else if (parts[0] === "journey") p = renderJourney();
      else if (parts[0] === "saved") p = renderSaved();
      else if (parts[0] === "compare") p = renderCompare();
      else if (parts[0] === "onboarding") p = renderOnboarding();
      else if (parts[0] === "account")
        p = renderAccount(new URLSearchParams(location.search).get("mode"));
      else if (parts[0] === "privacy") p = renderPrivacy();
      else if (parts[0] === "verify-email") p = renderVerifyEmail();
      else if (parts[0] === "forgot-password") p = renderForgotPassword();
      else if (parts[0] === "reset-password") p = renderResetPassword();
      else if (isProfile) p = renderProfile(decodeURIComponent(parts[1]));
      else p = renderDiscover();
    } catch (e) {
      return showCrash(e);
    }
    if (p && p.catch) p.catch(showCrash);
  }

  function showCrash(e) {
    console.error(e);
    view.innerHTML = emptyState({
      iconName: "alert",
      title: "Something went wrong",
      sub: (e && e.message) || "Unexpected error",
      ctaHref: "/discover",
      ctaLabel: "Back to discover",
    });
  }

  async function boot() {
    // A valid session cookie authenticates us; otherwise we're anonymous.
    try {
      const { student } = await API.me();
      state.user = student;
      state.savedIds = new Set(student.saved_universities || []);
    } catch {
      state.user = null;
    }
    render();
  }

  boot();
})();
