import { style } from "../../../../../../zyzz.config.ts";
import { For, createMemo, createSignal, createEffect } from "solid-js";
import { useBunja } from "bunja/solid";
import { RotateCcw, Trash2 } from "../../../../../../solid/icons.tsx";
import {
  purgeTrashItems,
  restoreTrashItems,
  subscribeTrashItems,
} from "../../../../../../protocol/generated/client.ts";
import {
  type BulkMutationRes,
  type TrashItem,
  type TrashItemsTableEvent,
} from "../../../../../../protocol/generated/rpc.ts";
import { formatDate, formatSize } from "../../../../../../state/explorer.ts";
import { rpcSessionBunja } from "../../../../../../state/rpc-session.ts";
import {
  clampFloatingMenuPosition,
  FloatingMenu,
  FloatingMenuItem,
} from "../../../../../ui/floating-menu.tsx";
import { className } from "../../../../../class-name.ts";
type TrashItemsState =
  | {
      phase: "connecting";
      items: TrashItem[];
      message?: string;
    }
  | {
      phase: "live";
      items: TrashItem[];
      message?: string;
    }
  | {
      phase: "error";
      items: TrashItem[];
      message: string;
    }
  | {
      phase: "closed";
      items: TrashItem[];
      message: string;
    };
interface TrashItemMenuState {
  item: TrashItem;
  x: number;
  y: number;
}

const trashContextMenuWidth = 176;
export function TrashContent() {
  const rpcSession = useBunja(rpcSessionBunja);
  const [state, setState] = createSignal<TrashItemsState>({
    phase: "connecting",
    items: [],
    message: "Opening trash",
  });
  const [selectedItemId, setSelectedItemId] = createSignal<string>();
  const [itemMenu, setItemMenu] = createSignal<TrashItemMenuState>();
  createEffect(
    () => ({ rpcSession: rpcSession() }),
    ({ rpcSession: currentRpcSession }) => {
      let cancelled = false;
      let iterator: AsyncGenerator<TrashItemsTableEvent> | undefined;
      setState({ phase: "connecting", items: [], message: "Opening trash" });
      void (async () => {
        try {
          const transport = await currentRpcSession.webTransport();
          if (cancelled) return;
          iterator = subscribeTrashItems(transport);
          for await (const event of iterator) {
            if (cancelled) break;
            setState((current) => applyTrashItemsEvent(current.items, event));
          }
        } catch (err) {
          if (!cancelled) {
            setState((current) => ({
              phase: "error",
              items: current.items,
              message: err instanceof Error ? err.message : String(err),
            }));
          }
        }
      })();
      return () => {
        cancelled = true;
        void iterator?.return(undefined);
      };
    },
  );
  createEffect(
    () => ({ itemMenu: itemMenu() }),
    ({ itemMenu: currentItemMenu }) => {
      if (!currentItemMenu) return;
      function closeMenu() {
        setItemMenu(undefined);
      }
      function closeMenuOnEscape(event: KeyboardEvent) {
        if (event.key === "Escape") closeMenu();
      }
      globalThis.addEventListener("mousedown", closeMenu);
      globalThis.addEventListener("keydown", closeMenuOnEscape);
      return () => {
        globalThis.removeEventListener("mousedown", closeMenu);
        globalThis.removeEventListener("keydown", closeMenuOnEscape);
      };
    },
  );
  function openItemMenu(item: TrashItem, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (item.readOnly) return;
    setSelectedItemId(item.id);
    setItemMenu({
      item,
      ...trashItemMenuPosition(event.clientX, event.clientY),
    });
  }
  async function restoreItem(item: TrashItem) {
    setItemMenu(undefined);
    await mutateTrashItem(item.id, restoreTrashItems, "Restore failed");
  }
  async function purgeItem(item: TrashItem) {
    setItemMenu(undefined);
    await mutateTrashItem(item.id, purgeTrashItems, "Permanent delete failed");
  }
  async function mutateTrashItem(
    itemId: string,
    mutate: (
      transport: WebTransport,
      request: {
        itemIds: string[];
      },
    ) => Promise<BulkMutationRes>,
    fallbackMessage: string,
  ) {
    const currentRpcSession = rpcSession();
    try {
      const transport = await currentRpcSession.webTransport();
      const result = await mutate(transport, { itemIds: [itemId] });
      const failure = result.results.find((item) => item.type === "failed");
      if (failure?.type === "failed") {
        setState((current) => ({
          phase: "error",
          items: current.items,
          message:
            failure.error.message || failure.error.type || fallbackMessage,
        }));
      }
    } catch (err) {
      setState((current) => ({
        phase: "error",
        items: current.items,
        message: err instanceof Error ? err.message : String(err),
      }));
    }
  }
  const sortedItems = createMemo(() => sortTrashItems(state().items));
  return (
    <section {...styles.trashContent()}>
      <div {...styles.trashTable()} role="grid" aria-label="Trash">
        <div {...styles.trashHead()}>Name</div>
        <div {...styles.trashHead()}>Original parent</div>
        <div {...styles.trashHead()}>Size</div>
        <div {...styles.trashHead()}>Deleted</div>
        {state().phase === "connecting" ? (
          <div {...styles.trashStatus()}>Opening trash</div>
        ) : state().phase === "error" ? (
          <div {...styles.trashError()}>{state().message}</div>
        ) : sortedItems().length === 0 ? (
          <div {...styles.trashStatus()}>Trash is empty</div>
        ) : (
          <For each={sortedItems()}>
            {(item) => (
              <div
                class={className(
                  styles.trashRow().class,
                  selectedItemId() === item.id && "selected",
                )}
                role="row"
                tabindex={0}
                onClick={() => setSelectedItemId(item.id)}
                onContextMenu={(event) => openItemMenu(item, event)}
              >
                <span {...styles.trashCell()}>{item.name}</span>
                <span
                  class={`${styles.trashCell().class} ${styles.metadata().class} `}
                >
                  {item.originalParent || "Unavailable"}
                </span>
                <span
                  class={`${styles.trashCell().class} ${styles.metadata().class} `}
                >
                  {formatTrashItemSize(item)}
                </span>
                <span
                  class={`${styles.trashCell().class} ${styles.metadata().class} `}
                >
                  {formatDate(item.deletedAtMs)}
                </span>
              </div>
            )}
          </For>
        )}
      </div>
      <footer {...styles.trashFooter()}>
        <span>
          {sortedItems().length} items
          {sortedItems().some((item) => item.readOnly)
            ? " · Read only; restore is unavailable"
            : ""}
        </span>
      </footer>

      {itemMenu() ? (
        <FloatingMenu
          className={styles.floatingMenu().class}
          position={{ left: itemMenu()!.x, top: itemMenu()!.y }}
        >
          <FloatingMenuItem onClick={() => restoreItem(itemMenu()!.item)}>
            <RotateCcw size={15} />
            Restore
          </FloatingMenuItem>
          <FloatingMenuItem
            tone="danger"
            onClick={() => purgeItem(itemMenu()!.item)}
          >
            <Trash2 size={15} />
            Delete permanently
          </FloatingMenuItem>
        </FloatingMenu>
      ) : null}
    </section>
  );
}
function applyTrashItemsEvent(
  current: TrashItem[],
  event: TrashItemsTableEvent,
): TrashItemsState {
  if (event.type === "snapshot") {
    return { phase: "live", items: event.rows, message: "Trash live" };
  }
  if (event.type === "patch") {
    const removes = new Set(event.removes);
    const upserts = new Map(event.upserts.map((item) => [item.id, item]));
    return {
      phase: "live",
      items: [
        ...current.filter(
          (item) => !removes.has(item.id) && !upserts.has(item.id),
        ),
        ...event.upserts,
      ],
      message: "Trash updated",
    };
  }
  return {
    phase: "closed",
    items: current,
    message: `Trash closed: ${event.reason.type}`,
  };
}
function sortTrashItems(items: TrashItem[]): TrashItem[] {
  return [...items].sort(
    (left, right) =>
      (right.deletedAtMs ?? 0) - (left.deletedAtMs ?? 0) ||
      left.name.localeCompare(right.name, undefined, {
        numeric: true,
        sensitivity: "base",
      }),
  );
}
function formatTrashItemSize(item: TrashItem): string {
  if (!item.size) return "";
  if (item.size.type === "bytes") return formatSize(item.size.value);
  return `${item.size.value} entries`;
}
function trashItemMenuPosition(
  x: number,
  y: number,
): {
  x: number;
  y: number;
} {
  const position = clampFloatingMenuPosition(x, y, {
    itemCount: 2,
    width: trashContextMenuWidth,
  });
  return { x: position.left, y: position.top };
}

namespace styles {
  export const metadata = style({
    color: "rgb(102 112 133 / 1)",
  });

  export const trashContent = style({
    gridTemplateRows: "minmax(0,1fr) auto",
    display: "grid",
    height: "100%",
    minHeight: "0",
    minWidth: "0",
    width: "100%",
    overflow: "hidden",
    backgroundColor: "rgb(255 255 255 / 1)",
  });
  export const trashTable = style({
    gridTemplateColumns:
      "minmax(180px,1.2fr) minmax(180px,1.4fr) minmax(100px,140px) minmax(140px,190px)",
    display: "grid",
    gridAutoRows: "2em",
    minHeight: "0",
    minWidth: "0",
    overflow: "auto",
    backgroundColor: "rgb(255 255 255 / 1)",
    lineHeight: 1.6,
  });
  export const trashHead = style({
    position: "sticky",
    top: "0",
    zIndex: 1,
    boxSizing: "border-box",
    height: "2rem",
    display: "flex",
    alignItems: "center",
    borderBottomWidth: "1px",
    borderBottomColor: "rgb(216 221 231 / 1)",
    backgroundColor: "rgb(246 248 251 / 1)",
    paddingLeft: "8px",
    paddingRight: "8px",
    color: "rgb(102 112 133 / 1)",
    fontWeight: 700,
  });
  export const trashRow = style({
    gridColumn: "1/-1",
    gridTemplateColumns: "subgrid",
    display: "grid",
    boxSizing: "border-box",
    height: "2em",
    minHeight: "2em",
    cursor: "default",
    borderWidth: "0px",
    borderBottomWidth: "1px",
    borderBottomColor: "rgb(238 241 245 / 1)",
    selectors: {
      "&.selected": {
        backgroundColor: "rgb(234 243 255 / 1)",
      },
      "&:hover": {
        backgroundColor: "rgb(247 250 255 / 1)",
      },
    },
    backgroundColor: "rgb(255 255 255 / 1)",
    textAlign: "left",
    lineHeight: 1.6,
  });
  export const trashCell = style({
    minWidth: "0",
    display: "flex",
    alignItems: "center",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    paddingLeft: "8px",
    paddingRight: "8px",
    color: "rgb(48 54 66 / 1)",
  });
  export const trashFooter = style({
    boxSizing: "border-box",
    height: "2rem",
    minHeight: "2rem",
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    borderTopWidth: "1px",
    borderTopColor: "rgb(216 221 231 / 1)",
    backgroundColor: "rgb(251 252 254 / 1)",
    paddingLeft: "8px",
    paddingRight: "8px",
    color: "rgb(102 112 133 / 1)",
    lineHeight: 1.6,
  });
  export const trashStatus = style({
    gridColumn: "1/-1",
    display: "flex",
    alignItems: "center",
    paddingLeft: "12px",
    paddingRight: "12px",
    color: "rgb(102 112 133 / 1)",
  });
  export const trashError = style({
    gridColumn: "1/-1",
    display: "flex",
    alignItems: "center",
    paddingLeft: "12px",
    paddingRight: "12px",
    color: "rgb(180 35 24 / 1)",
  });
  export const floatingMenu = style({
    zIndex: 30,
    width: "176px",
  });
}
