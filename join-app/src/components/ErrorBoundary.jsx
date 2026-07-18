import { Component } from 'react';

// A marketing page whose only job is capturing leads should never go fully
// blank on a render error — that silently costs every visitor after the
// crash, with no signal to anyone that it happened. Falls back to a plain,
// dependency-free static message with a direct way to reach us.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('Universo /join crashed:', error, info);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="min-h-screen bg-navy-900 text-white flex items-center justify-center px-6 text-center">
        <div>
          <p className="font-bold text-xl">Something went wrong loading this page.</p>
          <p className="text-white/70 mt-2">
            Sorry about that — try reloading, or reach us directly at{' '}
            <a href="mailto:hello@universo.app" className="underline">hello@universo.app</a>.
          </p>
        </div>
      </div>
    );
  }
}
