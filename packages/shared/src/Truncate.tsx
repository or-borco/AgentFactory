"use client";

import { useEffect, useRef, useState } from "react";
import { TooltipBubble } from "./TooltipBubble";

// Single-line text that clips with an ellipsis when it doesn't fit, showing a fast custom
// tooltip with the full value — but only when it's actually cut off. Whether text is
// truncated depends on its rendered width, which isn't knowable until the DOM exists, so this
// measures scrollWidth vs clientWidth after mount rather than guessing from character count.
export function Truncate({
  text,
  as = "span",
  className = "",
  wrapperClassName = "",
}: {
  text: string;
  as?: "span" | "h1" | "h3";
  className?: string;
  wrapperClassName?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (el) setIsTruncated(el.scrollWidth > el.clientWidth);
  }, [text]);

  const Wrapper = as;
  return (
    <Wrapper className={`group/tooltip relative ${wrapperClassName}`}>
      <span ref={ref} className={`block truncate ${className}`}>
        {text}
      </span>
      {isTruncated && <TooltipBubble label={text} />}
    </Wrapper>
  );
}
