"use strict";

/**
 * Country-level scholarship POINTERS: real, named, government/EU-run funding
 * schemes a student from that country's host country may be eligible for.
 *
 * This is deliberately NOT per-university data (no free dataset lists which
 * specific scholarships each of ~12,500 universities individually offers), and
 * deliberately NOT specific amounts/deadlines (those change yearly and we have
 * no reliable source for them). What we can state safely and honestly is that
 * these named, real programs exist for that country — students still need to
 * check current eligibility and amounts on the official page, which is why
 * every entry carries a `verify: true` flag the UI surfaces plainly.
 */

const { isEU } = require("./countries");

// Available EU-wide, on top of whatever the host country itself offers.
const EU_WIDE = [
  {
    name: "Erasmus Mundus Joint Master Degrees",
    scope: "eu-wide",
    website: "https://erasmus-plus.ec.europa.eu",
    note: "EU-funded full scholarships for joint master’s programs taught across multiple European universities.",
  },
];

// One or two well-known, real national schemes per country. Not exhaustive —
// a pointer to start research, not a guarantee of eligibility or amount.
const COUNTRY_SCHOLARSHIPS = {
  Germany: [
    {
      name: "DAAD Scholarships",
      scope: "country",
      website: "https://www.daad.de",
      note: "Germany’s national academic exchange service; the largest funder of international study/research in Germany.",
    },
  ],
  France: [
    {
      name: "Eiffel Excellence Scholarship",
      scope: "country",
      website: "https://www.campusfrance.org",
      note: "French government scholarship for outstanding international Master’s and PhD applicants.",
    },
  ],
  Netherlands: [
    {
      name: "Holland Scholarship",
      scope: "country",
      website: "https://www.studyinholland.nl",
      note: "Dutch government + university scholarship for non-EEA students starting a Bachelor’s or Master’s.",
    },
  ],
  Belgium: [
    {
      name: "VLIR-UOS Scholarships",
      scope: "country",
      website: "https://www.vliruos.be",
      note: "Flemish government scholarships for students from developing countries.",
    },
  ],
  Spain: [
    {
      name: "MAEC-AECID Scholarships",
      scope: "country",
      website: "https://www.aecid.es",
      note: "Spanish government cooperation scholarships for international postgraduate study.",
    },
  ],
  Italy: [
    {
      name: "Invest Your Talent in Italy",
      scope: "country",
      website: "https://www.investyourtalent.it",
      note: "Italian government program combining scholarships with internship placement in select Master’s programs.",
    },
  ],
  Poland: [
    {
      name: "NAWA Scholarships",
      scope: "country",
      website: "https://nawa.gov.pl",
      note: "Polish National Agency for Academic Exchange funding for international students and researchers.",
    },
  ],
  Sweden: [
    {
      name: "Swedish Institute Scholarships",
      scope: "country",
      website: "https://si.se",
      note: "Full scholarships for Master’s students from eligible countries.",
    },
  ],
  Finland: [
    {
      name: "Finland Scholarship",
      scope: "country",
      website: "https://www.studyinfinland.fi",
      note: "Tuition-fee-paying students from outside the EU/EEA can apply for at least a 100% tuition waiver plus living grant in the first year.",
    },
  ],
  Denmark: [
    {
      name: "Danish Government Scholarships",
      scope: "country",
      website: "https://ufm.dk",
      note: "Tuition waivers and stipends for highly-qualified non-EU/EEA students, awarded via individual universities.",
    },
  ],
  Austria: [
    {
      name: "OeAD Scholarships",
      scope: "country",
      website: "https://oead.at",
      note: "Austria’s national agency for international mobility and cooperation in education.",
    },
  ],
  Portugal: [
    {
      name: "Instituto Camões / FCT Grants",
      scope: "country",
      website: "https://www.instituto-camoes.pt",
      note: "Portuguese state scholarships and research grants for international students.",
    },
  ],
  Ireland: [
    {
      name: "Government of Ireland International Scholarships",
      scope: "country",
      website: "https://hea.ie",
      note: "Tuition waiver plus stipend for non-EU students, awarded competitively each year.",
    },
  ],
  Hungary: [
    {
      name: "Stipendium Hungaricum",
      scope: "country",
      website: "https://stipendiumhungaricum.hu",
      note: "Hungarian government scholarship covering tuition, accommodation and a monthly stipend.",
    },
  ],
  Czechia: [
    {
      name: "Government of Czechia Scholarships",
      scope: "country",
      website: "https://www.mzv.cz",
      note: "Scholarships for students from designated developing countries to study in Czechia.",
    },
  ],
  Greece: [
    {
      name: "IKY State Scholarships",
      scope: "country",
      website: "https://www.iky.gr",
      note: "Greek State Scholarships Foundation funding for international postgraduate study.",
    },
  ],
  Slovakia: [
    {
      name: "National Scholarship Programme of Slovakia",
      scope: "country",
      website: "https://www.scholarships.sk",
      note: "Slovak government funding for international students, PhD candidates and researchers.",
    },
  ],
  Slovenia: [
    {
      name: "Ad Futura Scholarships",
      scope: "country",
      website: "https://www.ad-futura.si",
      note: "Slovenian public fund scholarships for international study and research stays.",
    },
  ],
  Croatia: [
    {
      name: "CEEPUS Scholarships",
      scope: "country",
      website: "https://www.ceepus.info",
      note: "Central European exchange program covering mobility across the region, including Croatia.",
    },
  ],
  Bulgaria: [
    {
      name: "Bulgarian Government Scholarships",
      scope: "country",
      website: "https://www.mon.bg",
      note: "Scholarships awarded via bilateral agreements between Bulgaria and partner countries.",
    },
  ],
  Romania: [
    {
      name: "Romanian State Scholarships",
      scope: "country",
      website: "https://www.roscholarship.ro",
      note: "Scholarships for international students under Romanian government agreements.",
    },
  ],
  Lithuania: [
    {
      name: "Lithuanian State Scholarships",
      scope: "country",
      website: "https://www.smpf.lt",
      note: "National scholarships supporting incoming international students and researchers.",
    },
  ],
  "United Kingdom": [
    {
      name: "Chevening Scholarships",
      scope: "country",
      website: "https://www.chevening.org",
      note: "UK government’s global scholarship program for future leaders, fully funded one-year Master’s.",
    },
  ],
  "United States": [
    {
      name: "Fulbright Foreign Student Program",
      scope: "country",
      website: "https://foreign.fulbrightonline.org",
      note: "The US government’s flagship international exchange program, run per home country.",
    },
  ],
  Switzerland: [
    {
      name: "Swiss Government Excellence Scholarships",
      scope: "country",
      website: "https://www.sbfi.admin.ch",
      note: "For postgraduate researchers and artists, awarded through Swiss embassies.",
    },
  ],
  Norway: [
    {
      name: "Norwegian Government Scholarship Schemes",
      scope: "country",
      website: "https://www.studyinnorway.no",
      note: "Most Norwegian public universities charge no tuition; a small number of targeted scholarships cover living costs.",
    },
  ],
  Canada: [
    {
      name: "Vanier Canada Graduate Scholarships",
      scope: "country",
      website: "https://vanier.gc.ca",
      note: "For doctoral students demonstrating leadership and research excellence.",
    },
  ],
  Australia: [
    {
      name: "Australia Awards",
      scope: "country",
      website: "https://www.dfat.gov.au",
      note: "Australian government scholarships for students from eligible Indo-Pacific, African and other partner countries.",
    },
  ],
  Japan: [
    {
      name: "MEXT Scholarships",
      scope: "country",
      website: "https://www.studyinjapan.go.jp",
      note: "Japanese government scholarship covering tuition, a monthly stipend and travel costs.",
    },
  ],
  China: [
    {
      name: "Chinese Government Scholarship (CSC)",
      scope: "country",
      website: "https://www.campuschina.org",
      note: "Full and partial scholarships administered by the China Scholarship Council.",
    },
  ],
  "South Korea": [
    {
      name: "Korean Government Scholarship Program (KGSP)",
      scope: "country",
      website: "https://www.studyinkorea.go.kr",
      note: "Covers tuition, airfare, a monthly allowance and Korean language training.",
    },
  ],
  Türkiye: [
    {
      name: "Türkiye Scholarships (Türkiye Bursları)",
      scope: "country",
      website: "https://www.turkiyeburslari.gov.tr",
      note: "Fully-funded Turkish government scholarship open to applicants worldwide.",
    },
  ],
};

const GENERIC_FALLBACK = [
  {
    name: "National & institutional scholarships",
    scope: "generic",
    website: "",
    note: "Check the university’s official financial-aid page and your home country’s national scholarship or study-abroad portal — most countries and universities offer some form of need- or merit-based aid not listed here.",
  },
];

/**
 * @param {string} country  canonical country name (see lib/countries.js)
 * @returns {object[]} up to ~3 scholarship pointers, each { name, scope, website, note, verify:true }
 */
function scholarshipsFor(country) {
  const list = [
    ...(isEU(country) ? EU_WIDE : []),
    ...(COUNTRY_SCHOLARSHIPS[country] || []),
  ];
  const result = list.length ? list : GENERIC_FALLBACK;
  return result.slice(0, 3).map((s) => ({ ...s, verify: true, key: slug(s.name) }));
}

// Stable id for a scheme, so a student's tracked status survives re-renders.
function slug(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

// Real, well-known OUTBOUND schemes: a home country funding its own citizens to
// study abroad (the mirror of the host-country schemes above). Confirmed, named
// programs only — where we don't have one, students get an honest pointer.
const OUTBOUND_SCHOLARSHIPS = {
  China: [
    {
      name: "China Scholarship Council (CSC)",
      scope: "home",
      website: "https://www.csc.edu.cn",
      note: "State funding for Chinese citizens pursuing study/research abroad.",
    },
  ],
  Kazakhstan: [
    {
      name: "Bolashak International Scholarship",
      scope: "home",
      website: "https://bolashak.gov.kz",
      note: "Kazakhstan’s government scholarship for citizens studying abroad.",
    },
  ],
  Indonesia: [
    {
      name: "LPDP Scholarship",
      scope: "home",
      website: "https://lpdp.kemenkeu.go.id",
      note: "Indonesia’s endowment-fund scholarship for overseas Master’s/PhD study.",
    },
  ],
  Vietnam: [
    {
      name: "VIED Scholarships",
      scope: "home",
      website: "https://vied.vn",
      note: "Vietnam International Education Development — state funding to study abroad.",
    },
  ],
  India: [
    {
      name: "National Overseas Scholarship",
      scope: "home",
      website: "https://nosmsje.gov.in",
      note: "Government of India funding for eligible students’ overseas Master’s/PhD.",
    },
  ],
  Pakistan: [
    {
      name: "HEC Overseas Scholarships",
      scope: "home",
      website: "https://www.hec.gov.pk",
      note: "Higher Education Commission funding for Pakistanis studying abroad.",
    },
  ],
};

// A named home-country outbound scheme where we have one, else an honest pointer
// (no fabricated program name or URL).
function scholarshipsOutbound(homeCountry) {
  const list = OUTBOUND_SCHOLARSHIPS[homeCountry];
  if (list && list.length)
    return list.map((s) => ({ ...s, verify: true, key: slug(s.name) }));
  return [
    {
      name: "Your home country’s overseas study scholarships",
      scope: "home-generic",
      website: "",
      note: "Many governments fund their own citizens to study abroad — check your Ministry of Education or a national scholarship agency.",
      verify: true,
      key: "home-outbound-generic",
    },
  ];
}

/**
 * Scholarships for the countries a student is APPLYING to (host-country funded:
 * DAAD funds study IN Germany, so the destination is the right key — home
 * country was wrong). Grouped by destination, with EU-wide schemes added once
 * if any destination is in the EU.
 * @param {string[]} countries  destination country names
 * @returns {{groups:{country:string,scholarships:object[]}[], eu_wide:object[]}}
 */
function scholarshipsForDestinations(countries) {
  const seen = new Set();
  const groups = [];
  let anyEU = false;
  const tag = (s) => ({ ...s, verify: true, key: slug(s.name) });
  for (const c of countries || []) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    if (isEU(c)) anyEU = true;
    const list = COUNTRY_SCHOLARSHIPS[c];
    if (list && list.length)
      groups.push({ country: c, scholarships: list.map(tag) });
  }
  return { groups, eu_wide: anyEU ? EU_WIDE.map(tag) : [] };
}

module.exports = {
  scholarshipsFor,
  scholarshipsForDestinations,
  scholarshipsOutbound,
  slug,
  EU_WIDE,
  COUNTRY_SCHOLARSHIPS,
  OUTBOUND_SCHOLARSHIPS,
};
