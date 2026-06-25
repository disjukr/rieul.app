import { defineConfig, presetUno } from "unocss";

const preflightStyles = String.raw`
*,
::before,
::after {
  box-sizing: border-box;
  border-color: #d8dde7;
  border-style: solid;
  border-width: 0;
}

html,
body,
#root {
  height: 100%;
  margin: 0;
  overflow: hidden;
}

html {
  font-size: 12px;
}

body {
  background: #f3f5f8;
  color: #20242d;
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
    "Segoe UI", sans-serif;
}

`;

export default defineConfig({
  presets: [presetUno()],
  preflights: [
    {
      getCSS: () => preflightStyles,
    },
  ],
});
