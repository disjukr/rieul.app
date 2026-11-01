import { createSignal, createMemo } from "solid-js";
import { bunja } from "bunja";
// The application only consumes second precision. Keep the clock owned by its
// Bunja lifetime; consumers share one animation-frame subscription per store.
export const nowBunja = bunja(() => {
  const [now, setNow] = createSignal(Date.now());
  const nowEverySecond = createMemo(() => Math.floor(now() / 1000) * 1000);
  bunja.effect(() => {
    let active = true;
    let frame: number;
    function tick() {
      if (!active) return;
      setNow(Date.now());
      if (active) frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    return () => {
      active = false;
      cancelAnimationFrame(frame);
    };
  });
  return { now, nowEverySecond };
});
