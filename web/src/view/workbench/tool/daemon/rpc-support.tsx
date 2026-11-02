import { createMemo } from "solid-js";
import { style, theme } from "../../../../zyzz.config.ts";
import { summarizeRpcSupport } from "../../../../protocol/rpc-support.ts";

export function RpcSupportSection(props: {
  supportedProcIds?: readonly number[];
}) {
  const support = createMemo(() => summarizeRpcSupport(props.supportedProcIds));
  return (
    <section {...styles.section()} aria-label="RPC support">
      <h2 {...styles.heading()}>RPC support</h2>
      <p {...styles.description()}>
        Supported RPCs out of those known to this client. This is protocol
        support, not feature quality or completeness.
      </p>
      {!support().known ? (
        <p role="status">RPC support information is not available yet.</p>
      ) : null}
      <div {...styles.grid()}>
        {support().categories.map((category) => (
          <article
            {...styles.card()}
            aria-label={`${category.label} RPC support`}
          >
            <h3 {...styles.category()}>{category.label}</h3>
            <div {...styles.overview()}>
              <div {...styles.donut()} aria-hidden="true">
                <svg viewBox="0 0 100 100" {...styles.svg()}>
                  <circle
                    cx="50"
                    cy="50"
                    r="40"
                    fill="none"
                    stroke={theme.borderLight}
                    stroke-width="9"
                  />
                  {category.percent !== undefined ? (
                    <circle
                      cx="50"
                      cy="50"
                      r="40"
                      fill="none"
                      stroke={theme.accent}
                      stroke-width="9"
                      pathLength="100"
                      stroke-dasharray={`${(category.supported! / category.total) * 100} 100`}
                      transform="rotate(-90 50 50)"
                    />
                  ) : null}
                </svg>
                <span {...styles.percent()}>
                  {category.percent === undefined
                    ? "—"
                    : `${category.percent}%`}
                </span>
              </div>
              <div {...styles.counts()}>
                <strong>
                  {category.percent === undefined
                    ? "Unknown"
                    : `${category.percent}% supported`}
                </strong>
                <span>
                  {category.supported === undefined
                    ? `${category.total} known RPCs`
                    : `${category.supported} of ${category.total} RPCs`}
                </span>
                {category.unsupported !== undefined ? (
                  <span>{category.unsupported} not supported</span>
                ) : null}
              </div>
            </div>
            <details {...styles.details()}>
              <summary {...styles.summary()}>
                View {category.label} RPCs
              </summary>
              <ul {...styles.list()}>
                {category.entries.map((entry) => (
                  <li {...styles.row()}>
                    <span {...styles.proc()}>
                      <code>{entry.name}</code>
                      <span {...styles.id()}>RPC {entry.id}</span>
                    </span>
                    <span {...styles.state()}>
                      {entry.supported === undefined
                        ? "Unknown"
                        : entry.supported
                          ? "Supported"
                          : "Not supported"}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          </article>
        ))}
      </div>
      {support().unknownIds.length > 0 ? (
        <details {...styles.unknown()}>
          <summary {...styles.summary()}>
            Other advertised RPCs ({support().unknownIds.length})
          </summary>
          <p {...styles.description()}>
            These IDs are not in this client's current schema and are excluded
            from the percentages.
          </p>
          <ul {...styles.list()}>
            {support().unknownIds.map((id) => (
              <li {...styles.row()}>
                <span>RPC {id}</span>
                <span>Supported · unknown to this client</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
namespace styles {
  export const section = style({
    marginTop: "24px",
    minWidth: "0",
    color: theme.textPrimary,
  });
  export const heading = style({
    fontSize: "16px",
    fontWeight: 800,
    marginBottom: "8px",
  });
  export const description = style({
    color: theme.textSecondary,
    fontSize: "13px",
    lineHeight: 1.5,
    marginBottom: "16px",
  });
  export const grid = style({
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))",
    gap: "12px",
    alignItems: "start",
  });
  export const card = style({
    minWidth: "0",
    border: `1px solid ${theme.borderLight}`,
    borderRadius: "12px",
    backgroundColor: theme.bgPrimary,
    overflow: "hidden",
  });
  export const category = style({
    padding: "16px 16px 0",
    fontSize: "15px",
    fontWeight: 750,
  });
  export const overview = style({
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "12px 16px 16px",
  });
  export const donut = style({
    position: "relative",
    width: "88px",
    height: "88px",
    flexShrink: 0,
  });
  export const svg = style({ width: "100%", height: "100%", display: "block" });
  export const percent = style({
    position: "absolute",
    inset: "0",
    display: "grid",
    placeItems: "center",
    fontSize: "18px",
    fontWeight: 800,
    fontVariantNumeric: "tabular-nums",
  });
  export const counts = style({
    display: "grid",
    gap: "4px",
    fontSize: "13px",
    color: theme.textSecondary,
    selectors: { "& strong": { color: theme.textPrimary, fontSize: "14px" } },
  });
  export const details = style({ borderTop: `1px solid ${theme.borderLight}` });
  export const summary = style({
    cursor: "pointer",
    padding: "12px 16px",
    fontSize: "13px",
    fontWeight: 650,
    overflowWrap: "anywhere",
    selectors: {
      "&:hover": { backgroundColor: theme.bgHover },
      "&:focus-visible": {
        outline: `2px solid ${theme.focus}`,
        outlineOffset: "-3px",
      },
    },
  });
  export const list = style({ listStyle: "none", margin: "0", padding: "0" });
  export const row = style({
    display: "flex",
    alignItems: "start",
    justifyContent: "space-between",
    gap: "12px",
    padding: "10px 16px",
    borderTop: `1px solid ${theme.borderLight}`,
    fontSize: "12px",
    overflowWrap: "anywhere",
    minWidth: "0",
  });
  export const proc = style({ display: "grid", gap: "4px", minWidth: "0" });
  export const id = style({ color: theme.textSecondary, fontSize: "11px" });
  export const state = style({ flexShrink: 0, fontWeight: 650 });
  export const unknown = style({
    marginTop: "16px",
    border: `1px solid ${theme.borderLight}`,
    borderRadius: "8px",
    selectors: { "& p": { padding: "0 16px" } },
  });
}
