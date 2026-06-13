module.exports = {
  content: [
    "./index.html",
    "./*.html",
    "./*.js",
    "./**/*.{js,ts,jsx,tsx,html}"
  ],
  theme: {
    extend: {
      colors: {
        paper: '#F2E8D5',
        'paper-hover': '#E8D9BF',
        'paper-dark': '#DDD0B5',
        espresso: '#1A0F05',
        roast: '#2E1C0A',
        mocha: '#5C3D1A',
        tan: '#8B6A45',
        sand: '#9B7A50',
        accent: '#B5410E',
        'accent-dark': '#8B3008',
        gold: '#C8A87A',
        'border-color': '#C8B89A'
      }
    },
  },
  plugins: [],
  safelist: [
    "bg-cyan",
    "bg-orange",
    "bg-green",
    "bg-red",
    "text-cyan",
    "text-orange",
    "text-green",
    "text-red",
    "badge-downloaded",
    "badge-unidentified",
    "badge-not-on-deezer",
    "badge-download-failed"
  ]
};
