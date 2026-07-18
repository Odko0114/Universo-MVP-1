import Reveal from './Reveal.jsx';

export default function FounderNote() {
  return (
    <section className="bg-navy-800 text-white">
      <Reveal className="max-w-3xl mx-auto px-6 py-16 text-center">
        <p className="text-lg sm:text-xl leading-relaxed text-white/90">
          "We spent months talking to every one of Finland's 37 higher-education
          institutions before writing a line of this. The pattern was always the
          same: students who had someone to ask got in somewhere good, and
          students who didn't were guessing. That gap is the whole reason
          Universo exists."
        </p>
        <p className="mt-5 text-sm text-white/60 font-semibold tracking-wide">— Odko &amp; Mir, Universo founders</p>
      </Reveal>
    </section>
  );
}
