import { bunja } from "bunja";
import { atom } from "jotai/vanilla";
import { JotaiStoreScope } from "./jotai-store.ts";

// The application only consumes second precision. Keep the clock owned by its
// Bunja lifetime; consumers share one animation-frame subscription per store.
export const nowBunja = bunja(() => {
  const store = bunja.use(JotaiStoreScope);
  const nowAtom = atom(Date.now());
  const nowEverySecondAtom = atom(
    (get) => Math.floor(get(nowAtom) / 1000) * 1000,
  );
  bunja.effect(() => {
    let active = true;
    let frame: number;
    function tick() {
      if (!active) return;
      store.set(nowAtom, Date.now());
      if (active) frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    return () => {
      active = false;
      cancelAnimationFrame(frame);
    };
  });
  return { nowAtom, nowEverySecondAtom };
});
