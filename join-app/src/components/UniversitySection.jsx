import PilotForm from './PilotForm.jsx';

const points = [
  {
    title: 'See the drop-off, not just the click.',
    body: 'Funnel data on what students search, compare, and abandon before you ever hear from them.',
  },
  {
    title: 'A channel, not a listing.',
    body: "Reach students inside the feed they're already using to decide, not a static page they scroll past.",
  },
  {
    title: 'Built with universities, not just for them.',
    body: 'We surveyed all 37 Finnish higher-education institutions before writing a line of this.',
  },
];

export default function UniversitySection() {
  return (
    <section id="universities" className="bg-white text-navy-900 scroll-mt-6">
      <div className="max-w-5xl mx-auto px-6 py-20">
        <p className="text-gold-600 font-bold text-xs tracking-[0.18em] mb-4">FOR UNIVERSITIES</p>
        <h2 className="text-2xl sm:text-4xl font-extrabold leading-tight max-w-2xl">
          Your international recruitment budget is going somewhere. You don't know where it's
          working.
        </h2>
        <p className="mt-6 text-navy-900/70 max-w-2xl">
          Fairs, agents, and ranking-site placements all cost real money, and none of them tell
          you what a prospective student actually did before they dropped off — what they
          searched, what they compared you against, where they stopped reading.
        </p>
        <p className="mt-4 text-navy-900/70 max-w-2xl">
          Universo gives you that: a live view of search and engagement behavior from students
          actively deciding where to apply, plus a direct channel to reach them — not just
          another listing.
        </p>

        <div className="mt-12 grid sm:grid-cols-3 gap-6">
          {points.map((p) => (
            <div key={p.title} className="rounded-2xl bg-navy-900/[0.03] border border-navy-900/10 p-6">
              <p className="font-semibold">{p.title}</p>
              <p className="text-sm text-navy-900/65 mt-2">{p.body}</p>
            </div>
          ))}
        </div>

        <div className="mt-14">
          <p className="font-semibold mb-3">Want to see it before it's live everywhere? Talk to us.</p>
          <PilotForm />
        </div>
      </div>
    </section>
  );
}
