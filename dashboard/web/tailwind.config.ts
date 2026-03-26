import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          0: '#0a0a0f',
          1: '#111116',
          2: '#1a1a21',
          3: '#232329',
        },
        accent: {
          green: '#4ade80',
          yellow: '#facc15',
          red: '#f87171',
          orange: '#fb923c',
          blue: '#60a5fa',
          purple: '#c084fc',
        },
      },
      animation: {
        'pulse-soft': 'pulse-soft 2s ease-in-out infinite',
      },
      keyframes: {
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
      },
    },
  },
  plugins: [],
} satisfies Config
