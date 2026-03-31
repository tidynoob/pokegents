import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Fire Red party screen palette
        surface: {
          0: '#2a6858',   // dark teal background
          1: '#3a8070',   // medium teal (cards/panels)
          2: '#4a9888',   // lighter teal (hover)
          3: '#5aac98',   // lightest teal
        },
        accent: {
          green: '#58d898',   // HP bar green
          yellow: '#f8d830',  // HP bar yellow
          red: '#f85858',     // HP bar red / critical
          orange: '#e87848',  // selected/active card orange
          blue: '#68a8d8',    // info blue
          purple: '#9878c8',  // cancel button purple
        },
        gba: {
          card: '#4890c8',         // blue card row
          'card-light': '#58a0d8', // lighter blue card
          'card-dark': '#3878a8',  // darker blue card border
          selected: '#e87848',     // orange selected card
          'selected-light': '#f89868', // lighter orange
          'selected-dark': '#c86038',  // darker orange border
          dialog: '#f8f8f0',       // white dialog box
          'dialog-border': '#484848',  // dark dialog border
          teal: '#3a7a6a',         // background teal
          'teal-dark': '#2a5848',  // darker teal
          'teal-light': '#4a9a88', // lighter teal stripe
          hp: '#58d898',           // HP bar green
          'hp-yellow': '#f8d830',
          'hp-red': '#f85858',
          text: '#f8f8f0',         // white text
          'text-shadow': '#383838', // text shadow color
        },
      },
      fontFamily: {
        'pixel': ['"Press Start 2P"', 'monospace'],
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
