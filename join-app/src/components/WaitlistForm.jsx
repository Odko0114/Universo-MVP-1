import { useState } from 'react';
import Honeypot from './Honeypot.jsx';

export default function WaitlistForm() {
  const [email, setEmail] = useState('');
  const [companyWebsite, setCompanyWebsite] = useState(''); // honeypot — must stay empty
  const [status, setStatus] = useState('idle'); // idle | loading | done | error
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setStatus('loading');
    setError('');
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, company_website: companyWebsite }),
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
      <div className="rounded-2xl bg-teal-50 border border-teal-500/30 px-6 py-5 text-navy-900">
        <p className="font-semibold">You're on the list.</p>
        <p className="text-sm text-navy-800/80 mt-1">We'll email you when your invite is ready — no spam, unsubscribe any time.</p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-md">
      <form onSubmit={submit} className="flex flex-col sm:flex-row gap-3 relative">
        <Honeypot value={companyWebsite} onChange={(e) => setCompanyWebsite(e.target.value)} />
        <label htmlFor="waitlist-email" className="sr-only">Email address</label>
        <input
          id="waitlist-email"
          type="email"
          required
          placeholder="you@school.edu"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="flex-1 rounded-full px-5 py-3 text-navy-900 placeholder:text-navy-900/40 border border-white/20 bg-white focus:outline-none focus:ring-2 focus:ring-gold-500"
        />
        <button
          type="submit"
          disabled={status === 'loading'}
          className="rounded-full bg-gold-500 hover:bg-gold-600 disabled:opacity-60 text-navy-900 font-semibold px-6 py-3 transition-colors whitespace-nowrap"
        >
          {status === 'loading' ? 'Joining…' : 'Join the waitlist'}
        </button>
      </form>
      {status === 'error' && <p className="text-sm text-red-300 mt-2">{error}</p>}
    </div>
  );
}
