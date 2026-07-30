import { PageHeader } from "@agentfactory/shared";

export default function SettingsPage() {
  return (
    <div className="px-10 pt-10">
      <PageHeader title="Settings" subtitle="Coming in Step 6" />
      <p style={{ color: "var(--color-neutral-500)", fontSize: 14 }}>
        Integrations and Billing will be built here.
      </p>
    </div>
  );
}
