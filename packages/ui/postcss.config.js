// Tailwind v4 ships its own PostCSS plugin and does the vendor prefixing
// itself, so autoprefixer is gone (FF-1650).
module.exports = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
