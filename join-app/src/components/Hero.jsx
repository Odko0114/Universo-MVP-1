function Logo() {
  return (
    <svg viewBox="0 0 200 200" className="w-7 h-7" xmlns="http://www.w3.org/2000/svg">
      <path fill="currentColor" d="M18 20 C -6 80 40 165 100 190 C 96 140 90 60 88 15 Z" />
      <path fill="currentColor" d="M182 20 C 206 80 160 165 100 190 C 104 140 110 60 112 15 Z" />
    </svg>
  );
}

export default function Hero() {
  return (
    <header className="relative overflow-hidden bg-gradient-to-b from-navy-900 to-navy-700 text-white">
      <div className="pointer-events-none absolute inset-0 -z-0" aria-hidden="true">
        <div className="join-blob join-blob--teal absolute w-72 h-72 rounded-full bg-teal-500 opacity-25 blur-3xl -top-10 -left-10" />
        <div className="join-blob join-blob--gold absolute w-72 h-72 rounded-full bg-gold-500 opacity-20 blur-3xl top-1/3 -right-16" />
      </div>

      <div className="relative max-w-5xl mx-auto px-6 pt-8 pb-2 flex items-center gap-2">
        <Logo />
        <span className="font-bold italic text-lg tracking-tight">Universo</span>
      </div>

      <div className="relative max-w-4xl mx-auto px-6 pt-14 pb-20 text-center">
        <p className="text-gold-500 font-bold text-xs tracking-[0.18em] mb-5">SAME START. EQUAL CHANCE.</p>
        <h1 className="text-3xl sm:text-5xl font-extrabold leading-tight tracking-tight">
          You get one shot at choosing a university abroad.
          <br className="hidden sm:block" /> It shouldn't come down to who you know.
        </h1>
        <p className="mt-6 text-white/75 text-base sm:text-lg max-w-2xl mx-auto">
          Universo gives every international student the same information a well-connected
          one already has — and gives universities a real channel to the students they're
          currently missing.
        </p>

        <div className="mt-10 grid sm:grid-cols-2 gap-4 max-w-2xl mx-auto text-left">
          <a
            href="#students"
            className="rounded-2xl bg-white/10 hover:bg-white/15 border border-white/15 px-6 py-5 transition-colors"
          >
            <p className="text-sm text-teal-500 font-semibold mb-1">I'M A STUDENT</p>
            <p className="font-semibold">Find a fit, not just a ranking.</p>
            <p className="text-sm text-white/60 mt-1">Free, always. Join the waitlist ↓</p>
          </a>
          <a
            href="#universities"
            className="rounded-2xl bg-white/10 hover:bg-white/15 border border-white/15 px-6 py-5 transition-colors"
          >
            <p className="text-sm text-gold-500 font-semibold mb-1">I'M A UNIVERSITY</p>
            <p className="font-semibold">Reach applicants you can't see today.</p>
            <p className="text-sm text-white/60 mt-1">Book a pilot ↓</p>
          </a>
        </div>

        <p className="mt-12 text-xs text-white/50">
          2nd place, Into.Seinäjoki Space Pitch 2025 · Built after surveying all 37 Finnish higher-education institutions
        </p>
      </div>
    </header>
  );
}
