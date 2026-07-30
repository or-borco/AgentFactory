import { PageHeader } from "@agentfactory/shared";

export default function ActivityPage() {
  return (
    <div className="px-10 pt-10">
      <PageHeader title="Activity" subtitle="Coming in Step 4" />
      <p style={{ color: "var(--color-neutral-500)", fontSize: 14 }}>
        Activity dashboard will be built here.
      </p>
    </div>
  );
}
