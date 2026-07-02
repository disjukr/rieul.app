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

.machine-title-button.checking .machine-title-text {
  background: linear-gradient(
    100deg,
    #20242d 0%,
    #20242d 42%,
    #9fb7ff 50%,
    #20242d 58%,
    #20242d 100%
  );
  background-clip: text;
  background-size: 320% 100%;
  color: transparent;
  -webkit-background-clip: text;
  animation: machine-title-shimmer 1.8s linear infinite;
}

@keyframes machine-title-shimmer {
  from {
    background-position: 160% 0;
  }

  to {
    background-position: -160% 0;
  }
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
