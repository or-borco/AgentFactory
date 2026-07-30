import { PageHeader } from "@agentfactory/shared";

export default function TasksPage() {
  return (
    <div className="px-10 pt-10">
      <PageHeader title="Tasks" subtitle="Coming in Step 1" />
      <p style={{ color: "var(--color-neutral-500)", fontSize: 14 }}>
        Task list will be built here.
      </p>
    </div>
  );
}
