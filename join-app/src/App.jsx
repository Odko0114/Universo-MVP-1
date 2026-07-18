import { useEffect } from 'react';
import Hero from './components/Hero.jsx';
import StudentSection from './components/StudentSection.jsx';
import UniversitySection from './components/UniversitySection.jsx';
import HowItWorks from './components/HowItWorks.jsx';
import Footer from './components/Footer.jsx';

export default function App() {
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
      <HowItWorks />
      <Footer />
    </div>
  );
}
