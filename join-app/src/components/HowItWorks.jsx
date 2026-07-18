import { useState } from 'react';

const STEPS = {
  students: [
    { n: '1', title: 'Tell us what you’re looking for.', body: 'Field, budget, target degree — thirty seconds, and it drives everything after.' },
    { n: '2', title: 'Get a matched shortlist.', body: 'Ranked universities with real video from the campuses on it, not stock photos.' },
    { n: '3', title: 'Chat, save, apply.', body: "Talk to students already there, save what fits, and apply when you're ready." },
  ],
  universities: [
    { n: '1', title: 'We set up your profile.', body: 'Programs, tuition, scholarships — added and kept current, not a one-time form.' },
    { n: '2', title: 'You show up in the feed.', body: "Your listing reaches students matching your criteria who are actively deciding." },
    { n: '3', title: 'You watch the dashboard.', body: 'Search, comparison, and drop-off data — in real time, not a quarterly report.' },
  ],
};

export default function HowItWorks() {
  const [tab, setTab] = useState('students');
  const steps = STEPS[tab];

  return (
    <section className="bg-teal-50">
      <div className="max-w-4xl mx-auto px-6 py-20">
        <h2 className="text-2xl sm:text-3xl font-extrabold text-navy-900 text-center">How it works</h2>

        <div className="mt-8 flex justify-center">
          <div className="inline-flex rounded-full bg-white border border-navy-900/10 p-1">
            <button
              onClick={() => setTab('students')}
              className={`px-5 py-2 rounded-full text-sm font-semibold transition-colors ${tab === 'students' ? 'bg-navy-900 text-white' : 'text-navy-900/60'}`}
            >
              For students
            </button>
            <button
              onClick={() => setTab('universities')}
              className={`px-5 py-2 rounded-full text-sm font-semibold transition-colors ${tab === 'universities' ? 'bg-navy-900 text-white' : 'text-navy-900/60'}`}
            >
              For universities
            </button>
          </div>
        </div>

        <div className="mt-10 grid sm:grid-cols-3 gap-6">
          {steps.map((s) => (
            <div key={s.n} className="rounded-2xl bg-white border border-navy-900/10 p-6">
              <div className="w-8 h-8 rounded-full bg-teal-500/15 text-teal-600 font-bold flex items-center justify-center text-sm mb-4">
                {s.n}
              </div>
              <p className="font-semibold text-navy-900">{s.title}</p>
              <p className="text-sm text-navy-900/65 mt-2">{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
