import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/** Outside the chat scroller: transforms, image clipping and backdrop cannot cover actions. */
export function MessageActions({ anchor, alignEnd, onClose, children }: {
  anchor: RefObject<HTMLDivElement | null>;
  alignEnd: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [position, setPosition] = useState({ left: 12, top: 12, ready: false });

  useLayoutEffect(() => {
    const origin = anchor.current;
    const element = menu.current;
    if (!origin || !element) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const place = () => {
      const box = origin.getBoundingClientRect();
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      const left = Math.max(12, Math.min(alignEnd ? box.right - width : box.left, window.innerWidth - width - 12));
      const preferredTop = box.top >= height + 20 ? box.top - height - 8 : box.bottom + 8;
      const top = Math.max(12, Math.min(preferredTop, window.innerHeight - height - 12));
      setPosition({ left, top, ready: true });
    };
    place();
    element.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    window.addEventListener("resize", place);
    // The chat is an overflow scroller, so capture ancestor scroll events too.
    window.addEventListener("scroll", place, true);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      // Do not steal focus from a reply/edit composer that has just been opened.
      const current = document.activeElement;
      if (current === document.body || (current && element.contains(current))) {
        if (previousFocus?.isConnected && previousFocus !== document.body) previousFocus.focus({ preventScroll: true });
        else if (origin.isConnected) origin.focus({ preventScroll: true });
      }
    };
  }, [anchor, alignEnd]);

  return createPortal(
    <div className="fixed inset-0 z-40" data-message-actions-layer="true">
      <div className="absolute inset-0" aria-hidden="true" onClick={event => { event.stopPropagation(); close.current(); }} />
      <div
        ref={menu}
        role="toolbar"
        aria-label="گزینه‌های پیام"
        className="fixed flex max-w-[calc(100vw-24px)] flex-wrap items-center gap-1 rounded-2xl border border-ember-300/25 bg-dusk-100 p-1.5 shadow-xl shadow-black/60"
        style={{ left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}
        onClick={event => event.stopPropagation()}
        onKeyDown={event => {
          if (event.key === "Escape") {
            event.preventDefault(); event.stopPropagation(); close.current(); return;
          }
          if (!["ArrowLeft", "ArrowRight", "Home", "End", "Tab"].includes(event.key)) return;
          const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
          if (!items.length) return;
          const current = items.indexOf(document.activeElement as HTMLButtonElement);
          const previous = event.key === "ArrowLeft" || (event.key === "Tab" && event.shiftKey);
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (previous ? -1 : 1) + items.length) % items.length;
          event.preventDefault(); items[next]?.focus();
        }}
      >{children}</div>
    </div>, document.body,
  );
}
