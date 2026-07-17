/* Universo SPA — History-API router + views. Vanilla JS, no build step.
   Uses real paths (not hash) so the server can render each page for crawlers. */
(function () {
  'use strict';

  const view = document.getElementById('view');
  const PAGE_SIZE = 48;

  const state = {
    user: null,
    savedIds: new Set(),
    filterMeta: null,
    discover: { q: '', country: '', region: '', type: '', field: '', language: '', degree: '', maxTuition: '', sort: 'name' },
    results: { items: [], total: 0, offset: 0, hasMore: false, loading: false },
  };

  // ---- helpers ------------------------------------------------------------
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const initials = (name) =>
    String(name || '').replace(/\b(The|University|of|and|de|di|du|College)\b/gi, '')
      .trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || 'U';

  // Card cover fallbacks: a fixed set of brand-adjacent gradients (navy/teal/
  // deep tones) picked deterministically per university. Replaces the old
  // random-hue generator, which produced muddy browns/purples that made the
  // directory look like a database dump rather than one designed product.
  const COVERS = [
    ['#0B1F3A', '#14528a'], ['#0d3b4f', '#14b8a6'], ['#12294d', '#0d9488'],
    ['#1b3a66', '#2a6f97'], ['#0B1F3A', '#3a5a8c'], ['#123f3a', '#0f766e'],
    ['#1e3a5f', '#468faf'], ['#0f2e4d', '#1a7f8c'],
  ];
  function gradient(seed) {
    let h = 0;
    for (let i = 0; i < String(seed).length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
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
    alert: '<path d="M12 3 2 21h20L12 3z"/><path d="M12 10v5"/><circle cx="12" cy="18" r=".5"/>',
    spark: '<path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l2.5 2.5M16.5 16.5 19 19M19 5l-2.5 2.5M7.5 16.5 5 19"/>',
  };
  const icon = (name, size = 44) =>
    `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

  // Consistent, designed empty/locked/error states (previously a lone emoji
  // floating in whitespace).
  function emptyState({ iconName, title, sub, ctaHref, ctaLabel, secondary }) {
    return `
      <div class="empty-card">
        <div class="empty-card__icon">${icon(iconName)}</div>
        <h3>${esc(title)}</h3>
        ${sub ? `<p class="muted">${esc(sub)}</p>` : ''}
        <div class="empty-card__actions">
          ${ctaHref ? `<a class="btn btn--primary" href="${esc(ctaHref)}">${esc(ctaLabel)}</a>` : ''}
          ${secondary || ''}
        </div>
      </div>`;
  }

  function domainOf(u) {
    if (u.domain) return u.domain;
    const url = u.application_link || u.website || '';
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
  }

  function logoHtml(u, cls) {
    const d = domainOf(u);
    const img = d
      ? `<img src="${esc(API.logoUrl(d))}" alt="" loading="lazy" onerror="this.remove()">`
      : '';
    return `<span class="logo ${cls || ''}">${esc(initials(u.name))}${img}</span>`;
  }

  const nfmt = (n) => Number(n).toLocaleString('en-US');

  const money = (r) => {
    if (!r) return null;
    if (r.min === 0 && r.max === 0) return 'No tuition fee';
    const fmt = (n) => `€${nfmt(n)}`;
    return r.min === r.max ? `${fmt(r.min)}/${r.period}` : `${fmt(r.min)}–${fmt(r.max)}/${r.period}`;
  };

  let toastTimer;
  function toast(msg, isError) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = 'toast'), 2800);
  }

  function setActiveNav(name) {
    document.querySelectorAll('[data-nav]').forEach((a) => {
      const active = a.dataset.nav === name;
      a.classList.toggle('is-active', active);
      if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }

  const deviceGuess = () => (window.innerWidth < 700 ? 'mobile' : 'desktop');
  const trackPageview = (path) => API.track({ type: 'pageview', path, device: deviceGuess() });
  const trackProfileView = (uni) => API.track({ type: 'profile_view', path: location.pathname, uni, device: deviceGuess() });
  const trackFilter = (filter, value) => API.track({ type: 'filter_used', filter, value: String(value), device: deviceGuess() });

  // ---- History-API router -------------------------------------------------
  function navigate(pathname, replace) {
    if (pathname !== location.pathname) {
      history[replace ? 'replaceState' : 'pushState']({}, '', pathname);
    }
    render();
  }

  // Intercept same-origin link clicks so navigation stays a SPA transition.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || !href.startsWith('/') || a.target === '_blank' || a.hasAttribute('download')) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(href);
  });
  window.addEventListener('popstate', render);

  const go = navigate;

  // ---- university card ----------------------------------------------------
  function metaChips(u) {
    const chips = [];
    if (u.ranking && u.ranking.world_rank) {
      chips.push(`<span class="chip chip--rank">🏆 #${esc(u.ranking.world_rank)} world</span>`);
    }
    const t = money(u.tuition_range);
    if (t) {
      const prefix = u.tuition_range.estimated ? '~' : '';
      chips.push(`<span class="chip chip--gold">${prefix}${esc(t)}</span>`);
    }
    const langs = (u.language_of_instruction || []).slice(0, 2).join(', ');
    if (langs) chips.push(`<span class="chip chip--plain">${esc(langs)}</span>`);
    if ((u.degree_levels || []).length) chips.push(`<span class="chip">${esc(u.degree_levels.join(' · '))}</span>`);
    else if (u.institution_type) chips.push(`<span class="chip">${esc(u.institution_type)}</span>`);
    return chips.join('');
  }

  function uniCard(u) {
    const saved = state.savedIds.has(u.id);
    return `
      <article class="uni-card">
        <a class="uni-card__cover" href="/university/${esc(u.id)}" style="background:${gradient(u.id)}" aria-label="${esc(u.name)}">
          ${u.source === 'curated' ? '<span class="uni-card__tier">★ Curated</span>' : ''}
          <span class="uni-card__badge">${esc(u.country)}</span>
          <span class="uni-card__loc">${esc(u.city || u.country)}</span>
        </a>
        <div class="uni-card__body">
          <div class="uni-card__title">
            ${logoHtml(u, 'logo--card')}
            <div><a href="/university/${esc(u.id)}"><h3 class="uni-card__name">${esc(u.name)}</h3></a></div>
          </div>
          <p class="uni-card__desc">${esc(u.short_description || '')}</p>
          <div class="uni-card__meta">${metaChips(u)}</div>
          ${(u.match_reasons || []).length ? `<p class="match-why">🎯 ${esc(u.match_reasons.join(' · '))}</p>` : ''}
          <div class="card-actions">
            <a class="btn btn--ghost btn--sm" href="/university/${esc(u.id)}" style="flex:1">View</a>
            <button class="btn btn--sm ${saved ? 'btn--saved' : 'btn--primary'}" data-save="${esc(u.id)}" style="flex:1">
              ${saved ? '🔖 Saved' : '＋ Save'}
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
    document.querySelectorAll(`[data-save="${CSS.escape(id)}"]`).forEach((b) => {
      b.classList.toggle('btn--saved', saved);
      b.classList.toggle('btn--primary', !saved && b.classList.contains('btn--sm'));
      b.classList.toggle('btn--ghost', !saved && !b.classList.contains('btn--sm'));
      b.innerHTML = saved ? '🔖 Saved' : '＋ Save';
      b.disabled = false;
    });
  }

  async function handleSaveClick(id, btn) {
    if (!state.user) {
      toast('Create a free account to save universities', true);
      go(`/account?mode=register&next=${encodeURIComponent(location.pathname)}`);
      return;
    }
    const wasSaved = state.savedIds.has(id);
    btn.disabled = true;
    try {
      if (wasSaved) { await API.unsave(id); state.savedIds.delete(id); toast('Removed from saved'); }
      else { await API.save(id); state.savedIds.add(id); toast('Saved to your list'); }
      paintSaveButtons(id);
      // Only the Saved list actually changes shape when an item is removed.
      if (location.pathname.startsWith('/saved')) render();
    } catch (e) { toast(e.message, true); btn.disabled = false; }
  }

  document.addEventListener('click', (e) => {
    const saveBtn = e.target.closest('[data-save]');
    if (saveBtn) handleSaveClick(saveBtn.dataset.save, saveBtn);
  });

  // =========================================================================
  // Views
  // =========================================================================
  async function renderDiscover() {
    // The app requires an account (mirrors the server-side gate on /discover,
    // for SPA navigations that never hit the server route).
    if (!state.user) { navigate('/account?mode=register&src=gate&next=%2Fdiscover', true); return; }
    setActiveNav('discover');
    document.title = 'Discover universities abroad — Universo';
    const d = state.discover;

    if (!state.filterMeta) {
      try { state.filterMeta = await API.filters(); }
      catch { state.filterMeta = { countries: [], institution_types: [], fields_of_study: [], languages: [], degree_levels: [] }; }
    }
    const m = state.filterMeta;
    const opts = (arr, sel) => (arr || []).map((v) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(v)}</option>`).join('');
    const budgets = [['', 'Any budget'], ['1000', 'Under €1,000/yr'], ['3000', 'Under €3,000/yr'], ['6000', 'Under €6,000/yr'], ['12000', 'Under €12,000/yr'], ['20000', 'Under €20,000/yr']];

    const niche = d.region === 'EU' && d.language === 'English' && d.maxTuition === '6000';

    view.innerHTML = `
      <section class="hero">
        <p class="hero__tagline">Same Start. Equal Chance.</p>
        <h1>Find your university <span class="accent">abroad</span></h1>
        <p>Search <strong>12,000+</strong> universities across <strong>${m.countries.length || '190'}</strong> countries worldwide — with deeper detail for Europe and in-depth curated profiles.</p>
      </section>

      <button class="niche-btn ${niche ? 'is-active' : ''}" id="niche-toggle" type="button">
        🇪🇺 ${niche ? '✓ ' : ''}Affordable, English-taught, EU
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
        <div class="field"><label for="f-budget">Tuition budget</label><select id="f-budget">${budgets.map(([v, l]) => `<option value="${v}" ${v === d.maxTuition ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label for="f-sort">Sort by</label><select id="f-sort">
          <option value="name" ${d.sort === 'name' ? 'selected' : ''}>Name (A–Z)</option>
          <option value="size" ${d.sort === 'size' ? 'selected' : ''}>Largest (students)</option>
          <option value="tuition" ${d.sort === 'tuition' ? 'selected' : ''}>Lowest tuition</option>
          <option value="popular" ${d.sort === 'popular' ? 'selected' : ''}>Most popular</option>
        </select></div>
      </div>

      <div class="filters-row">
        <span id="result-count" class="muted" aria-live="polite">Loading…</span>
        <button class="link-btn" id="clear-filters">Clear all</button>
      </div>
      <p class="hint muted" id="filter-hint"></p>
      <div id="results" class="grid">${'<div class="skeleton"></div>'.repeat(6)}</div>
      <div id="loadmore-wrap" class="loadmore-wrap"></div>`;

    const qEl = document.getElementById('q');
    let searchTimer;
    qEl.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { d.q = qEl.value.trim(); loadResults(true); }, 300); });
    const bind = (id, key) => { const el = document.getElementById(id); if (el) el.addEventListener('change', (e) => { d[key] = e.target.value; if (e.target.value) trackFilter(key, e.target.value); loadResults(true); }); };
    bind('f-country', 'country'); bind('f-type', 'type'); bind('f-field', 'field');
    bind('f-language', 'language'); bind('f-degree', 'degree'); bind('f-budget', 'maxTuition'); bind('f-sort', 'sort');
    document.getElementById('clear-filters').addEventListener('click', () => {
      state.discover = { q: '', country: '', region: '', type: '', field: '', language: '', degree: '', maxTuition: '', sort: 'name' };
      renderDiscover();
    });
    document.getElementById('niche-toggle').addEventListener('click', () => {
      if (niche) { d.region = ''; d.language = ''; d.maxTuition = ''; }
      else { d.region = 'EU'; d.language = 'English'; d.maxTuition = '6000'; trackFilter('niche', 'eu-affordable-english'); }
      renderDiscover();
    });

    loadResults(true);
    loadRecommendations();
  }

  async function loadRecommendations() {
    const wrap = document.getElementById('recommended-wrap');
    if (!wrap || !state.user) { if (wrap) wrap.innerHTML = ''; return; }
    try {
      const { universities } = await API.recommendations(6);
      if (!universities.length) { wrap.innerHTML = ''; return; }
      wrap.innerHTML = `
        <div class="section-head" style="margin-top:4px">
          <h2>Recommended for you</h2>
          <span class="muted" style="font-size:.8rem">Matched to your profile</span>
        </div>
        <div class="grid grid--rec">${universities.map(uniCard).join('')}</div>`;
    } catch { wrap.innerHTML = ''; }
  }

  async function loadResults(reset) {
    const d = state.discover;
    const box = document.getElementById('results');
    const countEl = document.getElementById('result-count');
    const hintEl = document.getElementById('filter-hint');
    const moreWrap = document.getElementById('loadmore-wrap');
    if (!box) return;

    if (reset) { state.results = { items: [], total: 0, offset: 0, hasMore: false, loading: true }; box.innerHTML = '<div class="skeleton"></div>'.repeat(6); }
    if (hintEl) {
      const narrowing = d.field || d.language || d.degree || d.maxTuition;
      hintEl.textContent = narrowing ? 'Field, language, degree and tuition filters apply to in-depth curated profiles only.' : '';
    }

    try {
      const res = await API.universities({ q: d.q, country: d.country, region: d.region, type: d.type, field: d.field, language: d.language, degree: d.degree, maxTuition: d.maxTuition, sort: d.sort, offset: state.results.offset, limit: PAGE_SIZE });
      state.results.total = res.count;
      state.results.hasMore = res.has_more;
      state.results.items = reset ? res.universities : state.results.items.concat(res.universities);

      countEl.textContent = `${nfmt(res.count)} ${res.count === 1 ? 'university' : 'universities'}`;
      box.innerHTML = state.results.items.length
        ? state.results.items.map(uniCard).join('')
        : `<div style="grid-column:1/-1">${emptyState({
            iconName: 'search',
            title: 'No matches for that combination',
            sub: 'Try a broader search term, or clear one of the active filters.',
            secondary: '<button class="btn btn--ghost" id="empty-clear">Clear all filters</button>',
          })}</div>`;
      const emptyClear = document.getElementById('empty-clear');
      if (emptyClear) emptyClear.addEventListener('click', () => {
        state.discover = { q: '', country: '', region: '', type: '', field: '', language: '', degree: '', maxTuition: '', sort: 'name' };
        renderDiscover();
      });

      moreWrap.innerHTML = state.results.hasMore
        ? `<button class="btn btn--ghost" id="load-more">Load more (${nfmt(state.results.total - state.results.items.length)} more)</button>`
        : (state.results.items.length > PAGE_SIZE ? '<p class="muted end-note">That’s all of them.</p>' : '');
      const moreBtn = document.getElementById('load-more');
      if (moreBtn) moreBtn.addEventListener('click', () => { state.results.offset += PAGE_SIZE; loadResults(false); });
    } catch (e) {
      countEl.textContent = '';
      box.innerHTML = `<div style="grid-column:1/-1">${emptyState({ iconName: 'alert', title: 'Something went wrong loading results', sub: e.message })}</div>`;
    }
  }

  async function renderSaved() {
    if (!state.user) { navigate('/account?src=gate&next=%2Fsaved', true); return; }
    setActiveNav('saved');
    document.title = 'Saved — Universo';
    view.innerHTML = `<div class="section-head"><h2>Saved universities</h2></div><div id="results" class="grid">${'<div class="skeleton"></div>'.repeat(3)}</div>`;
    try {
      const { universities } = await API.saved();
      state.savedIds = new Set(universities.map((u) => u.id));
      document.getElementById('results').innerHTML = universities.length
        ? universities.map(uniCard).join('')
        : `<div style="grid-column:1/-1">${emptyState({
            iconName: 'bookmark',
            title: 'Your shortlist is empty',
            sub: 'Tap “Save” on any university to start comparing your options side by side.',
            ctaHref: '/discover', ctaLabel: 'Browse universities',
          })}</div>`;
    } catch (e) {
      view.innerHTML = emptyState({ iconName: 'alert', title: 'Couldn’t load your saved list', sub: e.message, ctaHref: '/discover', ctaLabel: 'Back to discover' });
    }
  }

  async function renderProfile(id) {
    setActiveNav('discover');
    view.innerHTML = `<div class="skeleton" style="height:320px"></div>`;
    let u;
    try { ({ university: u } = await API.university(id)); }
    catch (e) {
      view.innerHTML = `<a class="back-link" href="/discover">← Back</a>${emptyState({ iconName: 'alert', title: 'University not found', sub: e.message, ctaHref: '/discover', ctaLabel: 'Back to discover' })}`;
      return;
    }

    trackProfileView(u.id);
    document.title = `${u.name} — Universo`;
    const saved = state.savedIds.has(u.id);
    const src = u.source || (u.tuition_range ? 'curated' : 'global');
    const isCurated = src === 'curated';

    const facts = [];
    if (u.ranking && u.ranking.world_rank) {
      const nat = u.ranking.national_rank ? ` · #${u.ranking.national_rank} nationally` : '';
      facts.push(['Ranking', `🏆 #${u.ranking.world_rank} world${nat} (${u.ranking.provider})`]);
    }
    const tuit = money(u.tuition_range);
    if (tuit) facts.push([`Tuition (intl)${u.tuition_range.estimated ? ' · est.' : ''}`, u.tuition_range.estimated ? `~${tuit}` : tuit]);
    const living = money(u.estimated_living_cost);
    if (living) facts.push([`Living cost${u.estimated_living_cost.estimated ? ' · est.' : ''}`, u.estimated_living_cost.estimated ? `~${living}` : living]);
    if (u.institution_type) facts.push(['Institution type', u.institution_type]);
    if (u.legal_status) facts.push(['Legal status', u.legal_status]);
    if (u.founded) facts.push(['Founded', String(u.founded)]);
    if (u.student_count) facts.push(['Students', `${nfmt(u.student_count)} enrolled`]);
    if ((u.language_of_instruction || []).length) facts.push([`Language${u.language_estimated ? ' · typical' : ''}`, u.language_of_instruction.join(', ')]);
    if ((u.degree_levels || []).length) facts.push(['Degree levels', u.degree_levels.join(', ')]);
    if (u.application_deadline) facts.push(['Application deadline', u.application_deadline]);
    if (u.website) facts.push(['Website', `<a href="${esc(u.website)}" target="_blank" rel="noopener">${esc(domainOf(u))} ↗</a>`]);

    const factCards = facts.map(([k, v]) => `<div class="info-item"><div class="k">${esc(k)}</div><div class="v">${k === 'Website' ? v : esc(v)}</div></div>`).join('');
    const section = (title, inner) => inner ? `<div class="info-card"><h3>${esc(title)}</h3>${inner}</div>` : '';
    const taglist = (arr, cls) => (arr || []).length ? `<div class="taglist">${arr.map((p) => `<span class="chip ${cls}">${esc(p)}</span>`).join('')}</div>` : '';

    function scholarshipsSection(list) {
      if (!list || !list.length) return '';
      const rows = list.map((s) => `
        <div class="scholarship-row">
          <div class="scholarship-name">${s.website ? `<a href="${esc(s.website)}" target="_blank" rel="noopener">${esc(s.name)} ↗</a>` : esc(s.name)}</div>
          <p class="scholarship-note muted">${esc(s.note || '')}</p>
        </div>`).join('');
      return `<div class="info-card">
        <h3>Scholarships &amp; funding</h3>
        <p class="muted" style="margin:0 0 10px;font-size:.82rem">General funding routes for students studying in ${esc(u.country)} — not specific to this university. Always confirm current eligibility and amounts on the official page.</p>
        ${rows}
      </div>`;
    }

    const banner = {
      curated: 'Tuition, deadlines and requirements below are <strong>best-effort estimates</strong> — verify on the university’s official page before you rely on them.',
      eter: 'Profile data comes from the <strong>ETER register</strong> (European statistics only). Tuition, programs, deadlines and admission details are not included — check the official website.',
      global: 'This is a <strong>basic listing</strong> from a global universities directory. Tuition, programs, deadlines and admission details are not included — check the official website.',
    }[src];
    const sourceNote = {
      curated: 'Universo curated data',
      eter: `ETER — European Tertiary Education Register${u.ref_year ? `, reference year ${u.ref_year}` : ''}`,
      global: 'Global universities directory (Hipolabs open dataset)',
    }[src];

    view.innerHTML = `
      <a class="back-link" href="/discover">← Back to discover</a>
      <div class="profile__cover" id="cover" style="background:${gradient(u.id)}">
        <div class="profile__headline">
          ${logoHtml(u, 'logo--profile')}
          <div class="profile__title"><h1>${esc(u.name)}</h1><div class="loc">📍 ${esc(u.city ? u.city + ', ' : '')}${esc(u.country)}</div></div>
        </div>
      </div>
      <p class="photo-credit" id="photo-credit" hidden></p>

      <div class="profile__actions">
        <button class="btn ${saved ? 'btn--saved' : 'btn--ghost'}" data-save="${esc(u.id)}">${saved ? '🔖 Saved' : '＋ Save'}</button>
        <button class="btn btn--gold" id="apply-btn">Apply Now ↗</button>
      </div>

      ${state.user ? '' : `
        <div class="signup-nudge">
          <div><strong>Comparing schools?</strong> Create a free account to save this university, get matched to programs that fit you, and search all 12,000+.</div>
          <a class="btn btn--primary btn--sm" href="/account?mode=register&src=profile&next=${encodeURIComponent('/university/' + u.id)}">Sign up free</a>
        </div>`}

      ${u.data_verified ? '' : `<div class="verify-flag"><span>⚠️</span><span>${banner}</span></div>`}
      <div class="info-card"><h3>Overview</h3><p id="overview-text" style="margin:0;color:var(--ink-soft)">${esc(u.short_description || '')}</p></div>
      ${facts.length ? `<div class="info-card"><h3>Key facts</h3><div class="info-grid">${factCards}</div>${(u.tuition_range && u.tuition_range.estimated) || u.language_estimated ? '<p class="muted" style="margin:10px 0 0;font-size:.82rem">~ / “est.” / “typical” = <strong>country-level estimate</strong>, not verified per-university. Confirm with the university.</p>' : ''}</div>` : ''}
      ${section('Programs offered', taglist(u.programs_offered, 'chip'))}
      ${section('Fields of study', taglist(u.fields_of_study, 'chip--gold'))}
      ${section('Admission requirements', u.acceptance_requirements ? `<p style="margin:0;color:var(--ink-soft)">${esc(u.acceptance_requirements)}</p>` : '')}
      ${scholarshipsSection(u.scholarships)}

      <div class="info-card" style="text-align:center">
        <p class="muted" style="margin:0 0 10px">${isCurated ? 'Ready to start your application?' : 'Continue on the official university website'}</p>
        <button class="btn btn--gold btn--block" id="apply-btn-2">${isCurated ? 'Apply on official site ↗' : 'Visit official website ↗'}</button>
      </div>
      <p class="source-note muted">Source: ${sourceNote}${u.data_fetched_at ? ` · data as of ${esc(String(u.data_fetched_at).slice(0, 10))}` : ''}.</p>`;

    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(u.name + ' university official site')}`;
    const doApply = async () => {
      let link = u.application_link || u.website || '';
      try { const r = await API.applyClick(u.id); link = r.application_link || link; } catch { /* still open best link */ }
      window.open(link || searchUrl, '_blank', 'noopener');
    };
    document.getElementById('apply-btn').addEventListener('click', doApply);
    document.getElementById('apply-btn-2').addEventListener('click', doApply);

    API.photo(u.id).then((r) => {
      if (!r) return;
      // A richer Wikipedia overview beats the synthetic one-liner where available.
      if (r.extract) {
        const ov = document.getElementById('overview-text');
        if (ov) ov.textContent = r.extract;
      }
      if (!r.photo_url) return;
      const cover = document.getElementById('cover');
      if (cover) {
        cover.style.background = `linear-gradient(rgba(11,31,58,.30), rgba(11,31,58,.60)), url("${r.photo_url}") center/cover no-repeat`;
        cover.classList.add('profile__cover--photo');
      }
      if (r.attribution && r.attribution.artist) {
        const c = document.getElementById('photo-credit');
        if (c) {
          const a = r.attribution;
          const credit = `Photo: ${esc(a.artist)}${a.license ? ' (' + esc(a.license) + ')' : ''} · Wikimedia Commons`;
          c.innerHTML = a.source ? `<a href="${esc(a.source)}" target="_blank" rel="noopener">${credit}</a>` : credit;
          c.hidden = false;
        }
      }
    }).catch(() => {});
  }

  // ---- account ------------------------------------------------------------
  // Where to send the user after auth + which CTA brought them here (funnel
  // attribution). Captured from the URL when the account page renders.
  let authCtx = { next: '', src: '' };

  function renderAccount(initialMode) {
    setActiveNav('account');
    document.title = 'Account — Universo';
    if (state.user) return renderAccountLoggedIn();
    const params = new URLSearchParams(location.search);
    const next = params.get('next') || '';
    authCtx = { next: next.startsWith('/') ? next : '', src: params.get('src') || '' };
    renderAuthForms(initialMode === 'register' ? 'register' : 'login');
  }

  function renderAccountLoggedIn() {
    const u = state.user;
    const savedCount = state.savedIds.size;
    view.innerHTML = `
      <div class="section-head"><h2>Your account</h2></div>
      <div class="card">
        <div class="account-head">
          <div class="avatar">${esc(initials(u.full_name))}</div>
          <div><h2 style="margin:0;font-size:1.2rem">${esc(u.full_name)}</h2><div class="muted">${esc(u.email)}</div></div>
        </div>
        <div class="profile-facts">
          <div class="info-item"><div class="k">Country of origin</div><div class="v">${esc(u.country_of_origin || '—')}</div></div>
          <div class="info-item"><div class="k">Field of interest</div><div class="v">${esc(u.field_of_interest || '—')}</div></div>
          <div class="info-item"><div class="k">Target degree</div><div class="v">${esc(u.target_degree_level || '—')}</div></div>
          <div class="info-item"><div class="k">Saved universities</div><div class="v">${savedCount}</div></div>
        </div>
        <div style="margin-top:18px;display:flex;gap:10px">
          <a class="btn btn--ghost" href="/saved" style="flex:1">View saved (${savedCount})</a>
          <button class="btn btn--primary" id="logout" style="flex:1">Log out</button>
        </div>
        <hr class="divider" />
        <h3 style="font-size:.95rem;margin:0 0 8px">Your data (GDPR)</h3>
        <p class="muted" style="margin:0 0 10px;font-size:.85rem">Download everything we store about you, or delete your account permanently.</p>
        <div style="display:flex;gap:10px">
          <button class="btn btn--ghost btn--sm" id="export-data" style="flex:1">Export my data</button>
          <button class="btn btn--sm btn--danger" id="delete-account" style="flex:1">Delete account</button>
        </div>
      </div>`;

    document.getElementById('logout').addEventListener('click', async () => {
      try { await API.logout(); } catch { /* ignore */ }
      state.user = null; state.savedIds = new Set(); toast('Logged out'); go('/discover');
    });
    document.getElementById('export-data').addEventListener('click', async () => {
      try {
        const data = await API.exportData();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = 'universo-my-data.json'; a.click();
        URL.revokeObjectURL(a.href);
        toast('Data exported');
      } catch (e) { toast(e.message, true); }
    });
    document.getElementById('delete-account').addEventListener('click', async () => {
      if (!confirm('Permanently delete your account and saved list? This cannot be undone.')) return;
      try { await API.deleteAccount(); state.user = null; state.savedIds = new Set(); toast('Account deleted'); location.href = '/'; }
      catch (e) { toast(e.message, true); }
    });
  }

  function renderAuthForms(mode) {
    setActiveNav('account');
    const isLogin = mode === 'login';
    // The gate message explains WHY the visitor landed here instead of the
    // page they clicked toward — a silent bounce reads as a broken link.
    const gateNote = authCtx.src === 'gate'
      ? `<div class="auth-gate-note">${icon('lock', 16)} <span>Universo is free — create an account (or log in) to start exploring universities.</span></div>`
      : '';
    view.innerHTML = `
      <div class="auth-card">
        <div class="auth-card__brand">
          <span class="brand__mark" aria-hidden="true">
            <svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
              <path fill="currentColor" d="M14 34 C14 96 44 150 100 184 C96 128 94 66 92 12 C64 16 38 24 14 34 Z"/>
              <path fill="currentColor" d="M186 34 C186 96 156 150 100 184 C104 128 106 66 108 12 C136 16 162 24 186 34 Z"/>
            </svg>
          </span>
          <div>
            <div class="auth-card__name">Universo</div>
            <div class="auth-card__tag">Same Start. Equal Chance.</div>
          </div>
        </div>
        <div class="card auth-card__body">
          ${gateNote}
          <div class="tabs"><button class="${isLogin ? 'is-active' : ''}" data-mode="login">Log in</button><button class="${!isLogin ? 'is-active' : ''}" data-mode="register">Sign up</button></div>
          <div id="auth-error" class="form-error" hidden></div>
          ${isLogin ? loginForm() : registerForm()}
        </div>
      </div>`;
    view.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => renderAuthForms(b.dataset.mode)));
    if (isLogin) wireLogin(); else wireRegister();
  }

  function loginForm() {
    return `<h2>Welcome back</h2><p class="muted" style="margin-top:0">Log in to pick up your shortlist where you left off.</p>
      <form id="login-form">
        <div class="form-group"><label>Email</label><input type="email" name="email" required autocomplete="email" /></div>
        <div class="form-group"><label>Password</label><input type="password" name="password" required autocomplete="current-password" /></div>
        <button class="btn btn--primary btn--block" type="submit" id="login-submit">Log in</button>
      </form>`;
  }

  function registerForm() {
    return `<h2>Create your free account</h2><p class="muted" style="margin-top:0">Search 12,000+ universities, save a shortlist, and get matches for your profile.</p>
      <form id="register-form">
        <div class="form-group"><label>Full name *</label><input type="text" name="full_name" required autocomplete="name" /></div>
        <div class="form-group"><label>Email *</label><input type="email" name="email" required autocomplete="email" /></div>
        <div class="form-group"><label>Password * <span class="muted">(min 8 characters)</span></label><input type="password" name="password" required minlength="8" autocomplete="new-password" /></div>
        <div class="form-group"><label>Country of origin</label><input type="text" name="country_of_origin" placeholder="e.g. Mongolia" /></div>
        <div class="form-group"><label>Field of interest</label><input type="text" name="field_of_interest" placeholder="e.g. Computer Science" /></div>
        <div class="form-group"><label>Target degree level</label><select name="target_degree_level"><option value="">Select…</option><option>Bachelor</option><option>Master</option><option>PhD</option></select></div>
        <div class="form-group"><label class="consent"><input type="checkbox" name="consent" /><span>I have read and accept the <a href="/privacy">privacy policy</a>, and consent to Universo storing my account data. *</span></label></div>
        <button class="btn btn--primary btn--block" type="submit" id="register-submit">Create account</button>
        <p class="muted auth-fineprint">Free for students, always. We never sell your data.</p>
      </form>`;
  }

  function showAuthError(msg) { const box = document.getElementById('auth-error'); box.textContent = msg; box.hidden = !msg; }

  async function afterAuth(data) {
    state.user = data.student;
    state.savedIds = new Set(data.student.saved_universities || []);
    toast(`Welcome, ${data.student.full_name.split(' ')[0]}!`);
    go(authCtx.next || '/discover');
    authCtx = { next: '', src: '' };
  }

  function wireLogin() {
    const form = document.getElementById('login-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); showAuthError('');
      const btn = document.getElementById('login-submit');
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
      const fd = new FormData(form);
      try { await afterAuth(await API.login({ email: fd.get('email'), password: fd.get('password') })); }
      catch (err) { showAuthError(err.message); btn.disabled = false; btn.textContent = 'Log in'; }
    });
  }

  function wireRegister() {
    const form = document.getElementById('register-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); showAuthError('');
      const fd = new FormData(form);
      if (!fd.get('consent')) { showAuthError('Please accept the privacy policy to continue.'); return; }
      const btn = document.getElementById('register-submit');
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
      try {
        await afterAuth(await API.register({
          full_name: fd.get('full_name'), email: fd.get('email'), password: fd.get('password'),
          country_of_origin: fd.get('country_of_origin'), field_of_interest: fd.get('field_of_interest'),
          target_degree_level: fd.get('target_degree_level'), consent: fd.get('consent') === 'on',
          src: authCtx.src || undefined,
        }));
      } catch (err) { showAuthError(err.message); btn.disabled = false; btn.textContent = 'Create account'; }
    });
  }

  function renderPrivacy() {
    setActiveNav('account');
    document.title = 'Privacy — Universo';
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
  // Router + error boundary
  // =========================================================================
  function render() {
    const parts = location.pathname.split('/').filter(Boolean);
    window.scrollTo(0, 0);
    view.focus({ preventScroll: true });

    // "/" is the marketing landing page, served as its own static page — the
    // SPA should never actually be asked to render it. If it ever is (e.g. a
    // stale link), send the visitor on into the app rather than show nothing.
    if (parts.length === 0) { navigate('/discover', true); return; }

    // Profile views are tracked inside renderProfile (with the university id,
    // once it's confirmed to exist); every other route is a generic pageview.
    const isProfile = parts[0] === 'university' && parts[1];
    if (!isProfile) trackPageview(location.pathname);

    let p;
    try {
      if (parts[0] === 'discover') p = renderDiscover();
      else if (parts[0] === 'saved') p = renderSaved();
      else if (parts[0] === 'account') p = renderAccount(new URLSearchParams(location.search).get('mode'));
      else if (parts[0] === 'privacy') p = renderPrivacy();
      else if (isProfile) p = renderProfile(decodeURIComponent(parts[1]));
      else p = renderDiscover();
    } catch (e) { return showCrash(e); }
    if (p && p.catch) p.catch(showCrash);
  }

  function showCrash(e) {
    console.error(e);
    view.innerHTML = emptyState({
      iconName: 'alert',
      title: 'Something went wrong',
      sub: (e && e.message) || 'Unexpected error',
      ctaHref: '/discover', ctaLabel: 'Back to discover',
    });
  }

  async function boot() {
    // A valid session cookie authenticates us; otherwise we're anonymous.
    try { const { student } = await API.me(); state.user = student; state.savedIds = new Set(student.saved_universities || []); }
    catch { state.user = null; }
    render();
  }

  boot();
})();
