export default function Footer() {
  return (
    <footer className="bg-white border-t border-navy-900/10">
      <div className="max-w-5xl mx-auto px-6 py-10 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-navy-900/60">
        <p>© 2026 Universo. Built by Odko and Mir.</p>
        <div className="flex items-center gap-5">
          {/* TODO: point at a real inbox/socials before this page goes live */}
          <a href="mailto:hello@universo.app" className="hover:text-navy-900">hello@universo.app</a>
          <a href="/" className="hover:text-navy-900">Universo app</a>
        </div>
      </div>
    </footer>
  );
}
