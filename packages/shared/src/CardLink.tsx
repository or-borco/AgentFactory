import Link from "next/link";
import type { ReactNode } from "react";
import { Card } from "./Card";

// Link renders an inline <a> by default, which breaks a block-level Card's height inside
// grids (can't stretch to the row) and margin inside lists (no visible gap between items).
// Always route a clickable Card through this so every list/grid in the app behaves the same.
export function CardLink({ href, className = "", children }: { href: string; className?: string; children: ReactNode }) {
  return (
    <Link href={href} className="block h-full">
      <Card className={`h-full transition-colors hover:border-[var(--color-neutral-600)] ${className}`}>{children}</Card>
    </Link>
  );
}
