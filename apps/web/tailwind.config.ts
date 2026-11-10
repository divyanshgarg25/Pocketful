import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        linen: 'var(--linen)',
        parchment: 'var(--parchment)',
        sand: 'var(--sand)',
        oat: 'var(--oat)',
        taupe: 'var(--taupe)',
        ink: 'var(--ink)',
        burgundy: 'var(--burgundy)',
        claret: 'var(--claret)',
        maroon: 'var(--maroon)',
        blush: 'var(--blush)',
        brass: 'var(--brass)',
        moss: 'var(--moss)',
        ochre: 'var(--ochre)',
        brick: 'var(--brick)',
        // The Soft Monochromatic Route
        'dusty-rose': 'var(--dusty-rose)',
        'blush-pink': 'var(--blush-pink)',
        // The Minimalist Editorial Route
        'crisp-white': 'var(--crisp-white)',
        charcoal: 'var(--charcoal)',
        'charcoal-gray': 'var(--charcoal-gray)'
      },
      fontFamily: {
        display: ['var(--font-display)'],
        ui: ['var(--font-ui)'],
        num: ['var(--font-num)']
      },
      borderRadius: {
        control: 'var(--radius-control)',
        surface: 'var(--radius-surface)'
      },
      boxShadow: {
        lift: 'var(--lift)'
      }
    }
  },
  plugins: []
} satisfies Config;
