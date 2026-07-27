"use client";

import { Badge, Button, Card, PageHeader } from "@/components/ui";
import { PlusIcon, SparklesIcon } from "@/lib/icons";
import { useMockBackend } from "@/lib/mock/context";

export default function SkillsPage() {
  const { skills, notify } = useMockBackend();

  return (
    <div className="pb-16">
      <PageHeader
        title="Skills"
        subtitle="Reusable capabilities agents can load into a run"
        action={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => notify("Import from git — coming soon")}>
              Import from git
            </Button>
            <Button onClick={() => notify("Skill authoring — coming soon")}>
              <PlusIcon className="h-4 w-4" />
              New skill
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 px-10 pt-8 sm:grid-cols-2 lg:grid-cols-3">
        {skills.map((skill) => (
          <Card key={skill.id} className="p-5">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 text-white">
                <SparklesIcon className="h-5 w-5" />
              </div>
              <Badge tone={skill.source === "git" ? "success" : "neutral"}>
                {skill.source === "git" ? "Git" : "Authored"}
              </Badge>
            </div>
            <h3 className="font-semibold text-slate-900">{skill.name}</h3>
            <p className="mt-1 text-sm text-slate-500">{skill.description}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}
