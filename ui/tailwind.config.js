module.exports = {
  content: [
    "./index.html",
    "./*.html",
    "./*.js",
    "./**/*.{js,ts,jsx,tsx,html}"
  ],
  theme: {
    extend: {},
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
