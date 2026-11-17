/** Tailwind build sẵn (thay cho cdn.tailwindcss.com). Màu theme DaisyUI qua biến CSS để tự đổi sáng/tối. */
const dc = (v) => `oklch(var(--${v}) / <alpha-value>)`;
module.exports = {
  content: ['./views/**/*.hbs', './src/**/*.ts'],
  corePlugins: { preflight: true },
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui'] },
      colors: {
        primary: { DEFAULT: dc('p'), content: dc('pc') },
        secondary: { DEFAULT: dc('s'), content: dc('sc') },
        accent: { DEFAULT: dc('a'), content: dc('ac') },
        neutral: { DEFAULT: dc('n'), content: dc('nc') },
        'base-100': dc('b1'),
        'base-200': dc('b2'),
        'base-300': dc('b3'),
        'base-content': dc('bc'),
        info: { DEFAULT: dc('in'), content: dc('inc') },
        success: { DEFAULT: dc('su'), content: dc('suc') },
        warning: { DEFAULT: dc('wa'), content: dc('wac') },
        error: { DEFAULT: dc('er'), content: dc('erc') },
      },
    },
  },
};
