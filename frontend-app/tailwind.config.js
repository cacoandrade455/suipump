/** @type {import('tailwindcss').Config} */
// Terminal redesign (2a): brand tokens from SuiPump_Redesign.dc.html.
// Palette (design brand screen): pump #84CC16 / glow #A3E635 / void #050505 /
// dump #F87171 / creator #F59E0B / info #60A5FA. Lime is earned: progress,
// wins, CTAs. Everything else stays quiet.
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        sp: {
          pump:    '#84cc16', // primary lime
          glow:    '#a3e635', // bright lime (embers, pulses)
          leaf:    '#d9f99d', // aurora top stop
          moss:    '#4d7c0f', // aurora bottom stop
          void:    '#050505', // page background
          panel:   '#070707', // card background
          ink:     '#0b0b0b', // modal background
          dump:    '#f87171', // sells, losses, danger
          creator: '#f59e0b', // creator/amber surfaces
          info:    '#60a5fa', // informational blue
          grad:    '#34d399', // graduated green
          agent:   '#a78bfa', // agent/violet surfaces
        },
      },
      fontFamily: {
        mono: ["'JetBrains Mono'", 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        card:  '18px', // standard card
        shell: '22px', // page shell / large panels
        tile:  '13px', // small tiles / chips
      },
      keyframes: {
        'sp-blink': {
          '0%, 49%':  { opacity: '1' },
          '50%, 100%': { opacity: '0' },
        },
        'sp-pulse': {
          '0%, 100%': { transform: 'scale(1)',   opacity: '1' },
          '50%':      { transform: 'scale(1.35)', opacity: '.55' },
        },
      },
      animation: {
        'sp-blink': 'sp-blink 1.1s steps(1) infinite',
        'sp-pulse': 'sp-pulse 1.5s ease-in-out infinite',
      },
      boxShadow: {
        'sp-shell': '0 40px 100px rgba(0,0,0,.6)',
        'sp-cta':   '0 8px 30px rgba(132,204,22,.35)',
      },
    },
  },
  plugins: [],
};
