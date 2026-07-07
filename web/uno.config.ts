import { defineConfig, presetUno } from "unocss";

const preflightStyles = String.raw`
:root,
[data-theme="light"] {
  --wgo-color-white: #ffffff;
  --wgo-color-gray-25: #fbfcfe;
  --wgo-color-gray-50: #f7f8fb;
  --wgo-color-gray-75: #f6f8fb;
  --wgo-color-gray-100: #f4f5f7;
  --wgo-color-gray-125: #f4f6fa;
  --wgo-color-gray-150: #eef1f5;
  --wgo-color-gray-175: #edf0f5;
  --wgo-color-gray-180: #eef2f7;
  --wgo-color-gray-200: #e4e8ef;
  --wgo-color-gray-300: #d8dde7;
  --wgo-color-gray-350: #cfd7e5;
  --wgo-color-gray-375: #cfd6e3;
  --wgo-color-gray-400: #c9d0dc;
  --wgo-color-gray-425: #c7ceda;
  --wgo-color-gray-450: #b7c3d7;
  --wgo-color-gray-500: #98a2b3;
  --wgo-color-gray-600: #667085;
  --wgo-color-gray-700: #475467;
  --wgo-color-gray-750: #344054;
  --wgo-color-gray-800: #303642;
  --wgo-color-gray-900: #20242d;
  --wgo-color-gray-950: #101828;
  --wgo-color-blue-50: #f7faff;
  --wgo-color-blue-60: #f7f9fc;
  --wgo-color-blue-75: #f2f6ff;
  --wgo-color-blue-90: #eef3fb;
  --wgo-color-blue-100: #eef4ff;
  --wgo-color-blue-125: #eaf3ff;
  --wgo-color-blue-150: #e8eef7;
  --wgo-color-blue-175: #e7f0ff;
  --wgo-color-blue-500: #4f8cff;
  --wgo-color-blue-600: #2f6edc;
  --wgo-color-blue-650: #2f6fd6;
  --wgo-color-blue-700: #7c96c4;
  --wgo-color-blue-750: #7f9abf;
  --wgo-color-blue-200: #9fb7ff;
  --wgo-color-red-50: #fff4f2;
  --wgo-color-red-75: #fff2f0;
  --wgo-color-red-100: #fff1f3;
  --wgo-color-red-200: #f6c2bd;
  --wgo-color-red-500: #f04438;
  --wgo-color-red-600: #d92d20;
  --wgo-color-red-700: #b42318;
  --wgo-color-red-800: #912018;
  --wgo-color-green-50: #ecfdf3;
  --wgo-color-green-100: #dff6e7;
  --wgo-color-green-600: #16a34a;
  --wgo-color-green-700: #027a48;
  --wgo-color-yellow-50: #fff8df;
  --wgo-color-yellow-300: #e4c778;
  --wgo-color-yellow-700: #8a6116;
  --wgo-color-orange-600: #d68a00;
  --wgo-color-shell-900: #242832;
  --wgo-color-shell-800: #343946;
  --wgo-color-shell-300: #cbd3df;
  --wgo-color-shell-success: #38b86f;

  --wgo-bg-canvas: var(--wgo-color-gray-100);
  --wgo-bg-primary: var(--wgo-color-white);
  --wgo-bg-secondary: var(--wgo-color-gray-50);
  --wgo-bg-muted: var(--wgo-color-gray-150);
  --wgo-bg-subtle: var(--wgo-color-gray-25);
  --wgo-bg-header: var(--wgo-color-gray-75);
  --wgo-bg-hover: var(--wgo-color-blue-90);
  --wgo-bg-hover-weak: var(--wgo-color-blue-50);
  --wgo-bg-menu-hover: var(--wgo-color-blue-75);
  --wgo-bg-row-hover: var(--wgo-color-blue-60);
  --wgo-bg-selected: var(--wgo-color-blue-125);
  --wgo-bg-selected-soft: var(--wgo-color-blue-100);
  --wgo-bg-selected-hover: var(--wgo-color-blue-175);
  --wgo-bg-code: var(--wgo-color-gray-180);
  --wgo-bg-inverse: var(--wgo-color-gray-950);
  --wgo-bg-control-disabled: var(--wgo-color-gray-125);
  --wgo-text-primary: var(--wgo-color-gray-900);
  --wgo-text-secondary: var(--wgo-color-gray-700);
  --wgo-text-tertiary: var(--wgo-color-gray-600);
  --wgo-text-strong: var(--wgo-color-gray-800);
  --wgo-text-control: var(--wgo-color-gray-750);
  --wgo-text-disabled: var(--wgo-color-gray-500);
  --wgo-text-inverse: var(--wgo-color-gray-50);
  --wgo-border-light: var(--wgo-color-gray-300);
  --wgo-border-medium: var(--wgo-color-gray-400);
  --wgo-border-subtle: var(--wgo-color-gray-150);
  --wgo-border-extra-light: var(--wgo-color-gray-175);
  --wgo-border-muted: var(--wgo-color-gray-200);
  --wgo-border-control: var(--wgo-color-gray-425);
  --wgo-border-control-hover: var(--wgo-color-gray-450);
  --wgo-border-control-muted: var(--wgo-color-gray-375);
  --wgo-border-control-soft: var(--wgo-color-gray-350);
  --wgo-border-action-hover: var(--wgo-color-blue-700);
  --wgo-border-focus-strong: var(--wgo-color-blue-650);
  --wgo-border-warning: var(--wgo-color-yellow-300);
  --wgo-accent: var(--wgo-color-blue-500);
  --wgo-accent-rgb: 79 140 255;
  --wgo-accent-soft: rgb(var(--wgo-accent-rgb) / 14%);
  --wgo-accent-overlay: rgb(var(--wgo-accent-rgb) / 16%);
  --wgo-accent-soft-strong: var(--wgo-color-blue-150);
  --wgo-accent-shadow: var(--wgo-color-blue-750);
  --wgo-accent-shimmer: var(--wgo-color-blue-200);
  --wgo-link: var(--wgo-color-blue-600);
  --wgo-focus: var(--wgo-accent);
  --wgo-danger: var(--wgo-color-red-700);
  --wgo-danger-hover: var(--wgo-color-red-800);
  --wgo-danger-soft: var(--wgo-color-red-50);
  --wgo-danger-soft-hover: var(--wgo-color-red-75);
  --wgo-danger-soft-muted: var(--wgo-color-red-100);
  --wgo-danger-border: var(--wgo-color-red-200);
  --wgo-danger-border-hover: var(--wgo-color-red-500);
  --wgo-success: var(--wgo-color-green-700);
  --wgo-success-icon: var(--wgo-color-green-600);
  --wgo-success-soft: var(--wgo-color-green-100);
  --wgo-success-soft-muted: var(--wgo-color-green-50);
  --wgo-warning: var(--wgo-color-yellow-700);
  --wgo-warning-icon: var(--wgo-color-orange-600);
  --wgo-warning-soft: var(--wgo-color-yellow-50);
  --wgo-error-icon: var(--wgo-color-red-600);
  --wgo-shell-bg: var(--wgo-color-shell-900);
  --wgo-shell-item-bg: var(--wgo-color-shell-800);
  --wgo-shell-text: var(--wgo-color-gray-300);
  --wgo-shell-text-muted: var(--wgo-color-shell-300);
  --wgo-shell-success: var(--wgo-color-shell-success);
  --wgo-tooltip-bg: var(--wgo-color-gray-950);
  --wgo-overlay-backdrop: rgb(var(--wgo-shadow-rgb) / 42%);
  --wgo-shadow-rgb: 32 36 45;
  --wgo-shadow-strong-rgb: 16 24 40;
  --wgo-radius-sm: 4px;
  --wgo-radius-md: 6px;
  --wgo-radius-lg: 8px;
  --wgo-shadow-menu: 0 18px 48px rgb(var(--wgo-shadow-rgb) / 24%);
  --wgo-shadow-dialog: 0 24px 72px rgb(var(--wgo-shadow-rgb) / 28%);
  --wgo-shadow-tooltip: 0 12px 32px rgb(var(--wgo-shadow-strong-rgb) / 24%);
  --wgo-shadow-media: 0 2px 14px rgb(var(--wgo-shadow-rgb) / 18%);
  --wgo-shadow-floating-control: 0 8px 24px
    rgb(var(--wgo-shadow-strong-rgb) / 12%);
  --wgo-font-native: Inter, ui-sans-serif, system-ui, -apple-system,
    BlinkMacSystemFont, "Segoe UI", sans-serif;
}

*,
::before,
::after {
  box-sizing: border-box;
  border-color: var(--wgo-border-light);
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
  background: var(--wgo-bg-canvas);
  color: var(--wgo-text-primary);
  font-family: var(--wgo-font-native);
}

.machine-title-button.checking .machine-title-text {
  background: linear-gradient(
    100deg,
    var(--wgo-text-primary) 0%,
    var(--wgo-text-primary) 42%,
    var(--wgo-accent-shimmer) 50%,
    var(--wgo-text-primary) 58%,
    var(--wgo-text-primary) 100%
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
  theme: {
    colors: {
      wgo: {
        accent: "var(--wgo-accent)",
        "accent-overlay": "var(--wgo-accent-overlay)",
        "accent-shadow": "var(--wgo-accent-shadow)",
        "accent-shimmer": "var(--wgo-accent-shimmer)",
        "accent-soft": "var(--wgo-accent-soft)",
        "accent-soft-strong": "var(--wgo-accent-soft-strong)",
        canvas: "var(--wgo-bg-canvas)",
        code: "var(--wgo-bg-code)",
        control: "var(--wgo-text-control)",
        "control-disabled": "var(--wgo-bg-control-disabled)",
        danger: "var(--wgo-danger)",
        "danger-border": "var(--wgo-danger-border)",
        "danger-border-hover": "var(--wgo-danger-border-hover)",
        "danger-hover": "var(--wgo-danger-hover)",
        "danger-soft": "var(--wgo-danger-soft)",
        "danger-soft-hover": "var(--wgo-danger-soft-hover)",
        "danger-soft-muted": "var(--wgo-danger-soft-muted)",
        disabled: "var(--wgo-text-disabled)",
        focus: "var(--wgo-focus)",
        "focus-strong": "var(--wgo-border-focus-strong)",
        header: "var(--wgo-bg-header)",
        hover: "var(--wgo-bg-hover)",
        "hover-action-border": "var(--wgo-border-action-hover)",
        "hover-weak": "var(--wgo-bg-hover-weak)",
        inverse: "var(--wgo-text-inverse)",
        "inverse-bg": "var(--wgo-bg-inverse)",
        link: "var(--wgo-link)",
        "menu-hover": "var(--wgo-bg-menu-hover)",
        muted: "var(--wgo-bg-muted)",
        primary: "var(--wgo-bg-primary)",
        "row-hover": "var(--wgo-bg-row-hover)",
        secondary: "var(--wgo-bg-secondary)",
        selected: "var(--wgo-bg-selected)",
        "selected-hover": "var(--wgo-bg-selected-hover)",
        "selected-soft": "var(--wgo-bg-selected-soft)",
        shell: "var(--wgo-shell-bg)",
        "shell-item": "var(--wgo-shell-item-bg)",
        "shell-success": "var(--wgo-shell-success)",
        "shell-text": "var(--wgo-shell-text)",
        "shell-text-muted": "var(--wgo-shell-text-muted)",
        strong: "var(--wgo-text-strong)",
        subtle: "var(--wgo-bg-subtle)",
        success: "var(--wgo-success)",
        "success-icon": "var(--wgo-success-icon)",
        "success-soft": "var(--wgo-success-soft)",
        "success-soft-muted": "var(--wgo-success-soft-muted)",
        tertiary: "var(--wgo-text-tertiary)",
        "text-primary": "var(--wgo-text-primary)",
        "text-secondary": "var(--wgo-text-secondary)",
        "text-tertiary": "var(--wgo-text-tertiary)",
        tooltip: "var(--wgo-tooltip-bg)",
        warning: "var(--wgo-warning)",
        "warning-border": "var(--wgo-border-warning)",
        "warning-icon": "var(--wgo-warning-icon)",
        "warning-soft": "var(--wgo-warning-soft)",
      },
    },
    borderRadius: {
      "wgo-sm": "var(--wgo-radius-sm)",
      "wgo-md": "var(--wgo-radius-md)",
      "wgo-lg": "var(--wgo-radius-lg)",
    },
    boxShadow: {
      "wgo-dialog": "var(--wgo-shadow-dialog)",
      "wgo-menu": "var(--wgo-shadow-menu)",
    },
    fontFamily: {
      wgo: "var(--wgo-font-native)",
    },
  },
  preflights: [
    {
      getCSS: () => preflightStyles,
    },
  ],
});
