/** @type {import('tailwindcss').Config} */
// Same navy/teal/gold palette as public/css/styles.css (the live app) — kept
// as literal values here rather than shared since this is an isolated build.
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        navy: { 900: '#0B1F3A', 800: '#12294d', 700: '#1b3a66' },
        teal: { 50: '#e6f7f4', 500: '#14b8a6', 600: '#0d9488' },
        gold: { 500: '#E9B949', 600: '#d4a017' },
      },
    },
  },
  plugins: [],
};
