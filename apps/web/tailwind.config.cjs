/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{vue,js,ts,jsx,tsx}"],
  theme: {
    extend: {}
  },
  corePlugins: {
    // 与 ant-design-vue 一起使用时，建议关闭 preflight，避免全局样式覆盖组件库
    preflight: false
  },
  plugins: []
};

