const { hairlineWidth } = require('nativewind/theme');

const colors = require('./src/theme/colors.json');
const { radius } = require('./src/theme/radius.json');

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors,
      borderRadius: Object.fromEntries(
        Object.entries(radius).map(([key, value]) => [key, `${value}px`])
      ),
      borderWidth: {
        hairline: hairlineWidth(),
      },
    },
  },
  future: {
    hoverOnlyWhenSupported: true,
  },
  plugins: [],
};
