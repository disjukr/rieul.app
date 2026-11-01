import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import "@unocss/reset/tailwind.css";
import "../../src/theme.css";
import { Button } from "../../src/view/ui/button.tsx";
import { Badge } from "../../src/view/ui/badge.tsx";
import { style, theme } from "../../src/zyzz.config.ts";

function Fixture() {
  const [changed, setChanged] = createSignal(false);
  return (
    <main style={{ padding: "24px" }}>
      <button onClick={() => setChanged(!changed())}>Change styles</button>
      <Button
        data-testid="button"
        size={changed() ? "sm" : "md"}
        tone={changed() ? "danger" : "neutral"}
        variant={changed() ? "soft" : "solid"}
      >
        Styled button
      </Button>
      <Badge data-testid="badge" tone={changed() ? "success" : "danger"}>
        Styled badge
      </Badge>
      <Button disabled data-testid="disabled">
        Disabled
      </Button>
      <div
        {...styles.bar({ width: changed() ? "120px" : "40px" })}
        data-testid="bar"
      />
      <div data-testid="matrix">
        {(["neutral", "danger"] as const).map((tone) =>
          (["ghost", "outline", "soft", "solid"] as const).map((variant) =>
            (["icon", "md", "sm"] as const).map((size) => (
              <Button
                data-style-case={`${tone}-${variant}-${size}`}
                tone={tone}
                variant={variant}
                size={size}
              >
                Button
              </Button>
            )),
          ),
        )}
        {(["accent", "danger", "neutral", "success", "warning"] as const).map(
          (tone) =>
            (["outline", "soft", "solid"] as const).map((variant) =>
              (["md", "sm"] as const).map((size) => (
                <Badge
                  data-style-case={`${tone}-${variant}-${size}`}
                  tone={tone}
                  variant={variant}
                  size={size}
                >
                  Badge
                </Badge>
              )),
            ),
        )}
      </div>
    </main>
  );
}

namespace styles {
  export const bar = style((values: { width: `${number}px` }) => ({
    width: values.width,
    height: "20px",
    backgroundColor: theme.accent,
  }));
}

render(() => <Fixture />, document.getElementById("root")!);
