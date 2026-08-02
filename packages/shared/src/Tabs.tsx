interface TabItem {
  key: string;
  label: string;
}

interface TabsProps {
  tabs: TabItem[];
  active: string;
  onChange: (key: string) => void;
  className?: string;
}

export function Tabs({ tabs, active, onChange, className = "" }: TabsProps) {
  return (
    <div className={`flex gap-1 border-b border-[var(--color-divider)] ${className}`}>
      {tabs.map((tab) => {
        const isActive = tab.key === active;
        return (
          <button
            key={tab.key}
            onClick={() => onChange(tab.key)}
            className={[
              "px-4 py-2.5 text-sm font-medium transition-colors cursor-pointer -mb-px border-b-2",
              isActive
                ? "border-[var(--color-accent)] text-[var(--color-accent-300)]"
                : "border-transparent text-[var(--color-neutral-500)] hover:text-[var(--color-neutral-300)]",
            ].join(" ")}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
