// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const prettierRecommended = require('eslint-plugin-prettier/recommended');

const TOKENS_MESSAGE =
  'Use design tokens (src/theme: colors.json, Tailwind classes), not raw colours.';
const HEX = '#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})';
// Colour props (style keys, JSX props such as lucide `color` or SVG `fill`) must not take CSS colour names.
const COLOR_PROP = '/^(color|fill|stroke)$|Color$/';
const NAMED = '/^(?!transparent$|currentColor$|inherit$|none$)[A-Za-z]+$/';
// Tailwind's default palette (bg-white, text-red-500, ...): our palette lives in colors.json.
const PALETTE =
  '(^|[\\s:!])(bg|text|border(-[trblxyse])?|ring|ring-offset|outline|fill|stroke|from|via|to|decoration|divide|placeholder|shadow|caret|accent)-(white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(-\\d{2,3})?(?![\\w-])';

module.exports = defineConfig([
  expoConfig,
  prettierRecommended,
  {
    ignores: ['dist/*', 'android/*', 'ios/*', '.expo/*', 'coverage/*', 'src/api/schema.d.ts'],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: `Literal[value=/^${HEX}$/]`, message: TOKENS_MESSAGE },
        { selector: `Literal[value=/\\[${HEX}\\]/]`, message: TOKENS_MESSAGE },
        { selector: `TemplateElement[value.raw=/${HEX}\\b/]`, message: TOKENS_MESSAGE },
        { selector: 'Literal[value=/^(rgba?|hsla?)\\(/]', message: TOKENS_MESSAGE },
        {
          selector: `Property[key.name=${COLOR_PROP}] > Literal[value=${NAMED}]`,
          message: TOKENS_MESSAGE,
        },
        {
          selector: `JSXAttribute[name.name=${COLOR_PROP}] > Literal[value=${NAMED}]`,
          message: TOKENS_MESSAGE,
        },
        {
          selector: `JSXAttribute[name.name=${COLOR_PROP}] > JSXExpressionContainer > Literal[value=${NAMED}]`,
          message: TOKENS_MESSAGE,
        },
        { selector: `Literal[value=/${PALETTE}/]`, message: TOKENS_MESSAGE },
        { selector: `TemplateElement[value.raw=/${PALETTE}/]`, message: TOKENS_MESSAGE },
      ],
    },
  },
]);
