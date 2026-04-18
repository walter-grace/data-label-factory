"use client";

import { useEffect, useState, useRef } from "react";

/** Raw window scrollY in px. Throttled to rAF. */
export function useScrollY() {
  const [y, setY] = useState(0);
  useEffect(() => {
    let raf = 0;
    const on = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        setY(window.scrollY);
        raf = 0;
      });
    };
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => {
      window.removeEventListener("scroll", on);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  return y;
}

/**
 * Returns 0→1 progress as an element scrolls through the viewport.
 * 0 = top edge just entered the bottom of viewport.
 * 1 = bottom edge just left the top.
 */
export function useElementScrollProgress<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const compute = () => {
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight;
      // Progress linearly: element top from vh → -rect.height
      const total = vh + rect.height;
      const elapsed = vh - rect.top;
      const p = Math.max(0, Math.min(1, elapsed / total));
      setProgress(p);
    };
    const on = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        compute();
        raf = 0;
      });
    };
    compute();
    window.addEventListener("scroll", on, { passive: true });
    window.addEventListener("resize", on);
    return () => {
      window.removeEventListener("scroll", on);
      window.removeEventListener("resize", on);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  return { ref, progress };
}
