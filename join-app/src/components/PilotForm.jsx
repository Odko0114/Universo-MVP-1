import { useState } from 'react';
import Honeypot from './Honeypot.jsx';

const initial = { contact_name: '', work_email: '', university_name: '', country: '', message: '' };

// EU member states first (the platform's actual niche) plus a short list of
// other countries universities in this audience commonly come from. "Other"
// falls back to free text rather than trying to enumerate every country.
const COUNTRIES = [
  'Austria', 'Belgium', 'Bulgaria', 'Croatia', 'Cyprus', 'Czechia', 'Denmark', 'Estonia', 'Finland',
  'France', 'Germany', 'Greece', 'Hungary', 'Ireland', 'Italy', 'Latvia', 'Lithuania', 'Luxembourg',
  'Malta', 'Netherlands', 'Poland', 'Portugal', 'Romania', 'Slovakia', 'Slovenia', 'Spain', 'Sweden',
  'United Kingdom', 'Norway', 'Switzerland', 'Other',
];

export default function PilotForm() {
  const [fields, setFields] = useState(initial);
  const [companyWebsite, setCompanyWebsite] = useState(''); // honeypot — must stay empty
  const [otherCountry, setOtherCountry] = useState('');
  const [status, setStatus] = useState('idle'); // idle | loading | done | error
  const [error, setError] = useState('');

  const set = (key) => (e) => setFields((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setStatus('loading');
    setError('');
    const country = fields.country === 'Other' ? otherCountry : fields.country;
    try {
      const res = await fetch('/api/pilot-leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...fields, country, company_website: companyWebsite }),
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
        <p className="text-sm text-navy-900/70 mt-1">
          We reply to every pilot request within 2 business days. If it's urgent, or you'd rather
          just pick a time directly, email us at{' '}
          <a href="mailto:hello@universo.app" className="underline text-teal-600">hello@universo.app</a>.
        </p>
      </div>
    );
  }

  const inputCls =
    'w-full rounded-lg px-4 py-2.5 text-navy-900 placeholder:text-navy-900/40 border border-navy-900/15 bg-white focus:outline-none focus:ring-2 focus:ring-teal-500';

  return (
    <form onSubmit={submit} className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-xl relative">
      <Honeypot value={companyWebsite} onChange={(e) => setCompanyWebsite(e.target.value)} />
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
        <select id="pilot-country" value={fields.country} onChange={set('country')} className={inputCls}>
          <option value="">Select…</option>
          {COUNTRIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {fields.country === 'Other' && (
          <input
            aria-label="Country name"
            placeholder="Country name"
            value={otherCountry}
            onChange={(e) => setOtherCountry(e.target.value)}
            className={`${inputCls} mt-2`}
          />
        )}
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
