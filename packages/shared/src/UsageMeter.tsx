interface UsageMeterProps {
  usedBytes: number;
  maxBytes: number;
  label?: string;
}

export function UsageMeter({ usedBytes, maxBytes, label }: UsageMeterProps) {
  const pct = Math.min(100, (usedBytes / maxBytes) * 100);
  const usedKb = (usedBytes / 1024).toFixed(1);
  const maxKb = Math.round(maxBytes / 1024);
  const isWarn = pct > 80;

  return (
    <div className="space-y-1.5">
      {label && (
        <div className="flex justify-between text-xs text-[var(--color-neutral-500)]">
          <span>{label}</span>
          <span style={{ color: isWarn ? "var(--color-warning, #f59e0b)" : undefined }}>
            {usedKb} KB / {maxKb} KB
          </span>
        </div>
      )}
      <div className="h-1.5 w-full rounded-full bg-[var(--color-bg-elevated)]">
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: `${pct}%`,
            backgroundColor: isWarn ? "var(--color-warning, #f59e0b)" : "var(--color-accent)",
          }}
        />
      </div>
    </div>
  );
}
