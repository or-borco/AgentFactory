// Renders the floating label only — the caller's element is the trigger, and must itself
// carry `group/tooltip relative` for this to position and reveal correctly (it's appended as
// an absolutely-positioned child, so it never affects the trigger's own layout/truncation).
// Deliberately not a native `title` attribute: browsers hard-code that delay to ~1s with no
// way to shorten it, whereas this fades in after 150ms via a plain CSS transition-delay.
export function TooltipBubble({ label }: { label: string }) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none absolute left-0 top-full z-50 mt-1 max-w-xs whitespace-normal rounded-md bg-slate-900 px-2 py-1 text-xs text-white opacity-0 shadow-lg transition-opacity delay-150 duration-100 group-hover/tooltip:opacity-100"
    >
      {label}
    </span>
  );
}
