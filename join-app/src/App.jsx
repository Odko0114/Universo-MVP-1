import { useEffect } from 'react';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import Hero from './components/Hero.jsx';
import StudentSection from './components/StudentSection.jsx';
import UniversitySection from './components/UniversitySection.jsx';
import FounderNote from './components/FounderNote.jsx';
import HowItWorks from './components/HowItWorks.jsx';
import Footer from './components/Footer.jsx';

function Page() {
  useEffect(() => {
    fetch('/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'pageview', path: '/join', device: window.innerWidth < 640 ? 'mobile' : 'desktop' }),
    }).catch(() => {});
  }, []);

  return (
    <div>
      <Hero />
      <StudentSection />
      <UniversitySection />
      <FounderNote />
      <HowItWorks />
      <Footer />
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <Page />
    </ErrorBoundary>
  );
}
