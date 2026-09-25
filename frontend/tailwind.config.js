/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        paystack: {
          blue: '#0ba4db',
          cyan: '#00c3f7',
          green: '#00c389',
          dark: '#081325',
        },
      },
    },
  },
  plugins: [],
};
