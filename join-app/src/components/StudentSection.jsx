import WaitlistForm from './WaitlistForm.jsx';
import Reveal from './Reveal.jsx';

const points = [
  {
    title: 'A feed, not a spreadsheet.',
    body: "Short video from students and campuses — not a wall of PDF brochures nobody opens.",
  },
  {
    title: 'Matched to your profile.',
    body: 'Field, budget, target degree — a ranked shortlist that shows its reasoning, not just a filter.',
  },
  {
    title: "Talk to someone who's already there.",
    body: 'Direct chat with current students and other applicants, not a contact form that goes nowhere.',
  },
];

export default function StudentSection() {
  return (
    <section id="students" className="bg-navy-900 text-white scroll-mt-6">
      <div className="max-w-5xl mx-auto px-6 py-20">
        <p className="text-teal-500 font-bold text-xs tracking-[0.18em] mb-4">FOR STUDENTS — FREE, ALWAYS</p>
        <h2 className="text-2xl sm:text-4xl font-extrabold leading-tight max-w-2xl">
          Choosing where to study abroad is a one-shot decision. Most people don't get a do-over.
        </h2>
        <p className="mt-6 text-white/75 max-w-2xl">
          Right now, that shot goes to whoever has an agent, a counselor, an older sibling who
          already did it, or the luck to land on the right forum thread. Everyone else pieces it
          together from ranking sites, Facebook groups, and a university page that hasn't been
          updated since 2019.
        </p>
        <p className="mt-4 text-white/75 max-w-2xl">
          Universo puts 7,500+ EU university records, real program details, and a feed people
          actually watch in one place — for a well-connected applicant and a first-generation one
          alike.
        </p>

        <div className="mt-12 grid sm:grid-cols-3 gap-6">
          {points.map((p, i) => (
            <Reveal key={p.title} delayMs={i * 80} className="rounded-2xl bg-white/5 border border-white/10 p-6">
              <p className="font-semibold">{p.title}</p>
              <p className="text-sm text-white/65 mt-2">{p.body}</p>
            </Reveal>
          ))}
        </div>

        <div className="mt-14">
          <p className="font-semibold mb-3">Get early access.</p>
          <WaitlistForm />
        </div>
      </div>
    </section>
  );
}
