import { defineConfig, presetUno } from "unocss";

const preflightStyles = String.raw`
:root,
[data-theme="light"] {
  --rieul-color-white: #ffffff;
  --rieul-color-gray-25: #fbfcfe;
  --rieul-color-gray-50: #f7f8fb;
  --rieul-color-gray-75: #f6f8fb;
  --rieul-color-gray-100: #f4f5f7;
  --rieul-color-gray-125: #f4f6fa;
  --rieul-color-gray-150: #eef1f5;
  --rieul-color-gray-175: #edf0f5;
  --rieul-color-gray-180: #eef2f7;
  --rieul-color-gray-200: #e4e8ef;
  --rieul-color-gray-300: #d8dde7;
  --rieul-color-gray-350: #cfd7e5;
  --rieul-color-gray-375: #cfd6e3;
  --rieul-color-gray-400: #c9d0dc;
  --rieul-color-gray-425: #c7ceda;
  --rieul-color-gray-450: #b7c3d7;
  --rieul-color-gray-500: #98a2b3;
  --rieul-color-gray-600: #667085;
  --rieul-color-gray-700: #475467;
  --rieul-color-gray-750: #344054;
  --rieul-color-gray-800: #303642;
  --rieul-color-gray-900: #20242d;
  --rieul-color-gray-950: #101828;
  --rieul-color-blue-50: #f7faff;
  --rieul-color-blue-60: #f7f9fc;
  --rieul-color-blue-75: #f2f6ff;
  --rieul-color-blue-90: #eef3fb;
  --rieul-color-blue-100: #eef4ff;
  --rieul-color-blue-125: #eaf3ff;
  --rieul-color-blue-150: #e8eef7;
  --rieul-color-blue-175: #e7f0ff;
  --rieul-color-blue-500: #4f8cff;
  --rieul-color-blue-600: #2f6edc;
  --rieul-color-blue-650: #2f6fd6;
  --rieul-color-blue-700: #7c96c4;
  --rieul-color-blue-750: #7f9abf;
  --rieul-color-blue-200: #9fb7ff;
  --rieul-color-red-50: #fff4f2;
  --rieul-color-red-75: #fff2f0;
  --rieul-color-red-100: #fff1f3;
  --rieul-color-red-200: #f6c2bd;
  --rieul-color-red-500: #f04438;
  --rieul-color-red-600: #d92d20;
  --rieul-color-red-700: #b42318;
  --rieul-color-red-800: #912018;
  --rieul-color-green-50: #ecfdf3;
  --rieul-color-green-100: #dff6e7;
  --rieul-color-green-600: #16a34a;
  --rieul-color-green-700: #027a48;
  --rieul-color-yellow-50: #fff8df;
  --rieul-color-yellow-300: #e4c778;
  --rieul-color-yellow-700: #8a6116;
  --rieul-color-orange-600: #d68a00;
  --rieul-color-shell-900: #242832;
  --rieul-color-shell-800: #343946;
  --rieul-color-shell-300: #cbd3df;
  --rieul-color-shell-success: #38b86f;

  --rieul-bg-canvas: var(--rieul-color-gray-100);
  --rieul-bg-primary: var(--rieul-color-white);
  --rieul-bg-secondary: var(--rieul-color-gray-50);
  --rieul-bg-muted: var(--rieul-color-gray-150);
  --rieul-bg-subtle: var(--rieul-color-gray-25);
  --rieul-bg-header: var(--rieul-color-gray-75);
  --rieul-bg-hover: var(--rieul-color-blue-90);
  --rieul-bg-active: var(--rieul-color-blue-100);
  --rieul-bg-hover-weak: var(--rieul-color-blue-50);
  --rieul-bg-menu-hover: var(--rieul-color-blue-75);
  --rieul-bg-row-hover: var(--rieul-color-blue-60);
  --rieul-bg-selected: var(--rieul-color-blue-125);
  --rieul-bg-selected-soft: var(--rieul-color-blue-100);
  --rieul-bg-selected-hover: var(--rieul-color-blue-175);
  --rieul-bg-code: var(--rieul-color-gray-180);
  --rieul-bg-inverse: var(--rieul-color-gray-950);
  --rieul-bg-control-disabled: var(--rieul-color-gray-125);
  --rieul-text-primary: var(--rieul-color-gray-900);
  --rieul-text-secondary: var(--rieul-color-gray-700);
  --rieul-text-tertiary: var(--rieul-color-gray-600);
  --rieul-text-strong: var(--rieul-color-gray-800);
  --rieul-text-control: var(--rieul-color-gray-750);
  --rieul-text-disabled: var(--rieul-color-gray-500);
  --rieul-text-inverse: var(--rieul-color-gray-50);
  --rieul-canvas-background: var(--rieul-bg-canvas);
  --rieul-canvas-grain: none;
  --rieul-bg-overlay: var(--rieul-overlay-backdrop);
  --rieul-border-light: var(--rieul-color-gray-300);
  --rieul-border-medium: var(--rieul-color-gray-400);
  --rieul-border-subtle: var(--rieul-color-gray-150);
  --rieul-border-extra-light: var(--rieul-color-gray-175);
  --rieul-border-muted: var(--rieul-color-gray-200);
  --rieul-border-control: var(--rieul-color-gray-425);
  --rieul-border-control-hover: var(--rieul-color-gray-450);
  --rieul-border-control-muted: var(--rieul-color-gray-375);
  --rieul-border-control-soft: var(--rieul-color-gray-350);
  --rieul-border-action-hover: var(--rieul-color-blue-700);
  --rieul-border-focus-strong: var(--rieul-color-blue-650);
  --rieul-border-warning: var(--rieul-color-yellow-300);
  --rieul-accent: var(--rieul-color-blue-500);
  --rieul-accent-rgb: 79 140 255;
  --rieul-accent-soft: rgb(var(--rieul-accent-rgb) / 14%);
  --rieul-accent-overlay: rgb(var(--rieul-accent-rgb) / 16%);
  --rieul-accent-soft-strong: var(--rieul-color-blue-150);
  --rieul-accent-shadow: var(--rieul-color-blue-750);
  --rieul-accent-shimmer: var(--rieul-color-blue-200);
  --rieul-link: var(--rieul-color-blue-600);
  --rieul-focus: var(--rieul-accent);
  --rieul-danger: var(--rieul-color-red-700);
  --rieul-danger-hover: var(--rieul-color-red-800);
  --rieul-danger-soft: var(--rieul-color-red-50);
  --rieul-danger-soft-hover: var(--rieul-color-red-75);
  --rieul-danger-soft-muted: var(--rieul-color-red-100);
  --rieul-danger-border: var(--rieul-color-red-200);
  --rieul-danger-border-hover: var(--rieul-color-red-500);
  --rieul-success: var(--rieul-color-green-700);
  --rieul-success-icon: var(--rieul-color-green-600);
  --rieul-success-soft: var(--rieul-color-green-100);
  --rieul-success-soft-muted: var(--rieul-color-green-50);
  --rieul-warning: var(--rieul-color-yellow-700);
  --rieul-warning-icon: var(--rieul-color-orange-600);
  --rieul-warning-soft: var(--rieul-color-yellow-50);
  --rieul-error-icon: var(--rieul-color-red-600);
  --rieul-shell-bg: var(--rieul-color-shell-900);
  --rieul-shell-item-bg: var(--rieul-color-shell-800);
  --rieul-shell-text: var(--rieul-color-gray-300);
  --rieul-shell-text-muted: var(--rieul-color-shell-300);
  --rieul-shell-success: var(--rieul-color-shell-success);
  --rieul-chrome: var(--rieul-color-gray-950);
  --rieul-chrome-muted: var(--rieul-color-gray-900);
  --rieul-chrome-hover: rgb(255 255 255 / 11.5%);
  --rieul-chrome-active: rgb(255 255 255 / 16%);
  --rieul-chrome-text: rgb(255 255 255 / 88%);
  --rieul-chrome-text-muted: rgb(255 255 255 / 58%);
  --rieul-tooltip-bg: var(--rieul-color-gray-950);
  --rieul-overlay-backdrop: rgb(var(--rieul-shadow-rgb) / 42%);
  --rieul-material-chrome-bg: rgb(246 246 247 / 56%);
  --rieul-material-floating-bg: rgb(255 255 255 / 72%);
  --rieul-material-window-bg: rgb(248 248 249 / 50%);
  --rieul-pane-bg: rgb(253 253 253 / 94%);
  --rieul-pane-head-bg: rgb(241 241 242 / 74%);
  --rieul-pane-border: rgb(var(--rieul-shadow-rgb) / 8.5%);
  --rieul-table-bg: rgb(253 253 253 / 96.5%);
  --rieul-table-head-bg: rgb(246 246 247 / 92%);
  --rieul-shadow-rgb: 32 36 45;
  --rieul-shadow-strong-rgb: 16 24 40;
  --rieul-radius-xs: 4px;
  --rieul-radius-sm: 4px;
  --rieul-radius-md: 6px;
  --rieul-radius-lg: 8px;
  --rieul-radius-xl: 12px;
  --rieul-radius-2xl: 16px;
  --rieul-shadow-sm: 0 1px 2px rgb(var(--rieul-shadow-rgb) / 6%),
    0 1px 1px rgb(var(--rieul-shadow-rgb) / 3%);
  --rieul-shadow-md: 0 7px 18px rgb(var(--rieul-shadow-rgb) / 7.5%),
    0 1px 3px rgb(var(--rieul-shadow-rgb) / 4.5%);
  --rieul-shadow-lg: 0 24px 58px rgb(var(--rieul-shadow-rgb) / 18%),
    0 5px 16px rgb(var(--rieul-shadow-rgb) / 8%);
  --rieul-shadow-pane: 0 0 0 0.5px rgb(var(--rieul-shadow-rgb) / 10%),
    0 2px 5px rgb(var(--rieul-shadow-rgb) / 7%),
    0 18px 42px rgb(var(--rieul-shadow-rgb) / 11%);
  --rieul-shadow-window: 0 34px 90px rgb(19 27 42 / 21%),
    0 10px 30px rgb(19 27 42 / 12%),
    inset 0 1px 0 rgb(255 255 255 / 76%);
  --rieul-shadow-menu: 0 18px 48px rgb(var(--rieul-shadow-rgb) / 24%);
  --rieul-shadow-dialog: 0 24px 72px rgb(var(--rieul-shadow-rgb) / 28%);
  --rieul-shadow-tooltip: 0 12px 32px rgb(var(--rieul-shadow-strong-rgb) / 24%);
  --rieul-shadow-media: 0 2px 14px rgb(var(--rieul-shadow-rgb) / 18%);
  --rieul-shadow-floating-control: 0 8px 24px
    rgb(var(--rieul-shadow-strong-rgb) / 12%);
  --rieul-font-native: Inter, ui-sans-serif, system-ui, -apple-system,
    BlinkMacSystemFont, "Segoe UI", sans-serif;
}

*,
::before,
::after {
  box-sizing: border-box;
  border-color: var(--rieul-border-light);
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
  background: var(--rieul-bg-canvas);
  color: var(--rieul-text-primary);
  font-family: var(--rieul-font-native);
}

.machine-title-button.checking .machine-title-text {
  background: linear-gradient(
    100deg,
    var(--rieul-text-primary) 0%,
    var(--rieul-text-primary) 42%,
    var(--rieul-accent-shimmer) 50%,
    var(--rieul-text-primary) 58%,
    var(--rieul-text-primary) 100%
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
      "rieul-active": "var(--rieul-bg-active)",
      "rieul-accent": "var(--rieul-accent)",
      "rieul-accent-hover": "var(--rieul-accent-hover)",
      "rieul-accent-muted": "var(--rieul-accent-overlay)",
      "rieul-accent-soft": "var(--rieul-accent-soft)",
      "rieul-border": "var(--rieul-border-light)",
      "rieul-border-medium": "var(--rieul-border-medium)",
      "rieul-border-strong": "var(--rieul-border-control)",
      "rieul-border-subtle": "var(--rieul-border-subtle)",
      "rieul-canvas": "var(--rieul-bg-canvas)",
      "rieul-chrome": "var(--rieul-chrome)",
      "rieul-chrome-active": "var(--rieul-chrome-active)",
      "rieul-chrome-hover": "var(--rieul-chrome-hover)",
      "rieul-chrome-muted": "var(--rieul-chrome-muted)",
      "rieul-chrome-subtle": "var(--rieul-chrome-text-muted)",
      "rieul-chrome-text": "var(--rieul-chrome-text)",
      "rieul-danger": "var(--rieul-danger)",
      "rieul-danger-soft": "var(--rieul-danger-soft)",
      "rieul-focus": "var(--rieul-focus)",
      "rieul-hover": "var(--rieul-bg-hover)",
      "rieul-inverse": "var(--rieul-text-inverse)",
      "rieul-muted": "var(--rieul-text-disabled)",
      "rieul-overlay": "var(--rieul-bg-overlay)",
      "rieul-success": "var(--rieul-success)",
      "rieul-success-soft": "var(--rieul-success-soft)",
      "rieul-surface": "var(--rieul-bg-primary)",
      "rieul-surface-2": "var(--rieul-bg-secondary)",
      "rieul-surface-3": "var(--rieul-bg-muted)",
      "rieul-text": "var(--rieul-text-primary)",
      "rieul-text-2": "var(--rieul-text-secondary)",
      "rieul-text-3": "var(--rieul-text-tertiary)",
      "rieul-warning": "var(--rieul-warning)",
      "rieul-warning-soft": "var(--rieul-warning-soft)",
      rieul: {
        accent: "var(--rieul-accent)",
        "accent-overlay": "var(--rieul-accent-overlay)",
        "accent-shadow": "var(--rieul-accent-shadow)",
        "accent-shimmer": "var(--rieul-accent-shimmer)",
        "accent-soft": "var(--rieul-accent-soft)",
        "accent-soft-strong": "var(--rieul-accent-soft-strong)",
        canvas: "var(--rieul-bg-canvas)",
        code: "var(--rieul-bg-code)",
        control: "var(--rieul-text-control)",
        "control-disabled": "var(--rieul-bg-control-disabled)",
        danger: "var(--rieul-danger)",
        "danger-border": "var(--rieul-danger-border)",
        "danger-border-hover": "var(--rieul-danger-border-hover)",
        "danger-hover": "var(--rieul-danger-hover)",
        "danger-soft": "var(--rieul-danger-soft)",
        "danger-soft-hover": "var(--rieul-danger-soft-hover)",
        "danger-soft-muted": "var(--rieul-danger-soft-muted)",
        disabled: "var(--rieul-text-disabled)",
        focus: "var(--rieul-focus)",
        "focus-strong": "var(--rieul-border-focus-strong)",
        header: "var(--rieul-bg-header)",
        hover: "var(--rieul-bg-hover)",
        "hover-action-border": "var(--rieul-border-action-hover)",
        "hover-weak": "var(--rieul-bg-hover-weak)",
        inverse: "var(--rieul-text-inverse)",
        "inverse-bg": "var(--rieul-bg-inverse)",
        link: "var(--rieul-link)",
        "menu-hover": "var(--rieul-bg-menu-hover)",
        muted: "var(--rieul-bg-muted)",
        primary: "var(--rieul-bg-primary)",
        "row-hover": "var(--rieul-bg-row-hover)",
        secondary: "var(--rieul-bg-secondary)",
        selected: "var(--rieul-bg-selected)",
        "selected-hover": "var(--rieul-bg-selected-hover)",
        "selected-soft": "var(--rieul-bg-selected-soft)",
        shell: "var(--rieul-shell-bg)",
        "shell-item": "var(--rieul-shell-item-bg)",
        "shell-success": "var(--rieul-shell-success)",
        "shell-text": "var(--rieul-shell-text)",
        "shell-text-muted": "var(--rieul-shell-text-muted)",
        strong: "var(--rieul-text-strong)",
        subtle: "var(--rieul-bg-subtle)",
        success: "var(--rieul-success)",
        "success-icon": "var(--rieul-success-icon)",
        "success-soft": "var(--rieul-success-soft)",
        "success-soft-muted": "var(--rieul-success-soft-muted)",
        tertiary: "var(--rieul-text-tertiary)",
        "text-primary": "var(--rieul-text-primary)",
        "text-secondary": "var(--rieul-text-secondary)",
        "text-tertiary": "var(--rieul-text-tertiary)",
        tooltip: "var(--rieul-tooltip-bg)",
        warning: "var(--rieul-warning)",
        "warning-border": "var(--rieul-border-warning)",
        "warning-icon": "var(--rieul-warning-icon)",
        "warning-soft": "var(--rieul-warning-soft)",
      },
    },
    borderRadius: {
      "rieul-xs": "var(--rieul-radius-xs)",
      "rieul-sm": "var(--rieul-radius-sm)",
      "rieul-md": "var(--rieul-radius-md)",
      "rieul-lg": "var(--rieul-radius-lg)",
      "rieul-xl": "var(--rieul-radius-xl)",
      "rieul-2xl": "var(--rieul-radius-2xl)",
    },
    boxShadow: {
      "rieul-dialog": "var(--rieul-shadow-dialog)",
      "rieul-lg": "var(--rieul-shadow-lg)",
      "rieul-menu": "var(--rieul-shadow-menu)",
      "rieul-md": "var(--rieul-shadow-md)",
      "rieul-pane": "var(--rieul-shadow-pane)",
      "rieul-sm": "var(--rieul-shadow-sm)",
    },
    fontFamily: {
      rieul: "var(--rieul-font-native)",
    },
  },
  shortcuts: {
    "rieul-icon-button":
      "inline-flex appearance-none items-center justify-center cursor-pointer border-0 rounded-rieul-md bg-transparent p-0 leading-none font-rieul text-rieul-text-3 hover:bg-rieul-hover hover:text-rieul-text-2 active:bg-rieul-active rieul-transition",
    "rieul-material-chrome":
      "border-white/22 bg-[var(--rieul-material-chrome-bg)] backdrop-blur-xl shadow-[inset_0_1px_0_rgb(255_255_255_/_66%),inset_0_-1px_0_rgb(18_25_38_/_4%)]",
    "rieul-material-dock-control":
      "border border-white/34 bg-white/24 text-rieul-text-2 backdrop-blur-xl hover:border-white/56 hover:bg-white/44 hover:text-rieul-text",
    "rieul-material-floating":
      "border border-white/42 bg-[var(--rieul-material-floating-bg)] backdrop-blur-2xl shadow-[0_24px_70px_rgb(18_25_38_/_22%),0_4px_16px_rgb(18_25_38_/_10%),inset_0_1px_0_rgb(255_255_255_/_82%)]",
    "rieul-material-window":
      "border border-white/46 bg-[var(--rieul-material-window-bg)] backdrop-blur-2xl shadow-[var(--rieul-shadow-window)]",
    "rieul-surface-card":
      "border border-rieul-border bg-rieul-surface rounded-rieul-xl shadow-rieul-md",
    "rieul-transition":
      "[transition:background_var(--rieul-duration-fast,100ms)_var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),color_var(--rieul-duration-fast,100ms)_var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),border-color_var(--rieul-duration-fast,100ms)_var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),box-shadow_var(--rieul-duration-fast,100ms)_var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1))]",
  },
  preflights: [
    {
      getCSS: () => preflightStyles,
    },
  ],
});
