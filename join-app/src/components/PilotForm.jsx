import { useState } from 'react';

const initial = { contact_name: '', work_email: '', university_name: '', country: '', message: '' };

export default function PilotForm() {
  const [fields, setFields] = useState(initial);
  const [status, setStatus] = useState('idle'); // idle | loading | done | error
  const [error, setError] = useState('');

  const set = (key) => (e) => setFields((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setStatus('loading');
    setError('');
    try {
      const res = await fetch('/api/pilot-leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
      setStatus('done');
    } catch (err) {
      setStatus('error');
      setError(err.message || 'Something went wrong. Try again.');
    }
  }

  if (status === 'done') {
    return (
      <div className="rounded-2xl bg-white border border-navy-900/10 px-6 py-6 text-navy-900 shadow-sm">
        <p className="font-semibold text-lg">Got it — thank you.</p>
        <p className="text-sm text-navy-900/70 mt-1">Someone from Universo will reach out within a couple of days to set up a call.</p>
      </div>
    );
  }

  const inputCls =
    'w-full rounded-lg px-4 py-2.5 text-navy-900 placeholder:text-navy-900/40 border border-navy-900/15 bg-white focus:outline-none focus:ring-2 focus:ring-teal-500';

  return (
    <form onSubmit={submit} className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-xl">
      <div className="sm:col-span-1">
        <label htmlFor="pilot-name" className="block text-sm font-medium text-navy-900/80 mb-1">Your name</label>
        <input id="pilot-name" required value={fields.contact_name} onChange={set('contact_name')} className={inputCls} />
      </div>
      <div className="sm:col-span-1">
        <label htmlFor="pilot-email" className="block text-sm font-medium text-navy-900/80 mb-1">Work email</label>
        <input id="pilot-email" type="email" required value={fields.work_email} onChange={set('work_email')} className={inputCls} />
      </div>
      <div className="sm:col-span-1">
        <label htmlFor="pilot-uni" className="block text-sm font-medium text-navy-900/80 mb-1">University</label>
        <input id="pilot-uni" required value={fields.university_name} onChange={set('university_name')} className={inputCls} />
      </div>
      <div className="sm:col-span-1">
        <label htmlFor="pilot-country" className="block text-sm font-medium text-navy-900/80 mb-1">Country</label>
        <input id="pilot-country" value={fields.country} onChange={set('country')} className={inputCls} />
      </div>
      <div className="sm:col-span-2">
        <label htmlFor="pilot-message" className="block text-sm font-medium text-navy-900/80 mb-1">Anything we should know? (optional)</label>
        <textarea id="pilot-message" rows={3} value={fields.message} onChange={set('message')} className={inputCls} />
      </div>
      <div className="sm:col-span-2">
        <button
          type="submit"
          disabled={status === 'loading'}
          className="rounded-full bg-navy-900 hover:bg-navy-800 disabled:opacity-60 text-white font-semibold px-7 py-3 transition-colors"
        >
          {status === 'loading' ? 'Sending…' : 'Talk to us'}
        </button>
        {status === 'error' && <p className="text-sm text-red-600 mt-2">{error}</p>}
      </div>
    </form>
  );
}
