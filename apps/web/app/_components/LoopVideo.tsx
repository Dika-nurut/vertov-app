'use client';

import { useEffect, useRef, useState } from 'react';

/** A silent product loop that costs nothing until it is needed: `preload="none"`
 *  until it scrolls near the viewport, plays only while visible and `active`, and
 *  never plays under prefers-reduced-motion (the poster frame stays). `loop`
 *  repeats in place; without it the parent hears `onEnded` and decides what's
 *  next. `onProgress` reports 0..1 every animation frame while playing. */
export function LoopVideo({
  src,
  webm,
  poster,
  active = true,
  loop = true,
  onEnded,
  onProgress,
  className,
}: {
  src: string;
  webm?: string;
  poster: string;
  active?: boolean;
  loop?: boolean;
  onEnded?: () => void;
  onProgress?: (p: number) => void;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [near, setNear] = useState(false);
  const [visible, setVisible] = useState(false);
  const [still, setStill] = useState(true);

  useEffect(() => {
    setStill(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const el = ref.current;
    if (!el || !('IntersectionObserver' in window)) {
      setNear(true);
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) setNear(true);
        setVisible(Boolean(e?.isIntersecting));
      },
      { rootMargin: '200px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // <source> children only take effect on load(): run it once they are rendered.
  useEffect(() => {
    if (near) ref.current?.load();
  }, [near]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (active && visible && near && !still) {
      el.play().catch(() => {});
    } else {
      el.pause();
    }
  }, [active, visible, near, still]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !onProgress || !active) return;
    let raf = 0;
    const tick = () => {
      if (el.duration > 0) onProgress(el.currentTime / el.duration);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, onProgress]);

  return (
    <video
      ref={ref}
      poster={poster}
      muted
      playsInline
      loop={loop}
      preload="none"
      onEnded={onEnded}
      aria-hidden
      className={className}
    >
      {near && webm && <source src={webm} type="video/webm" />}
      {near && <source src={src} type="video/mp4" />}
    </video>
  );
}
