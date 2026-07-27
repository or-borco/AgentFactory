"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { TeamFormModal } from "@/components/TeamFormModal";
import { Button, Card, EmptyState, PageHeader } from "@/components/ui";
import { PlusIcon, UsersIcon } from "@/lib/icons";
import { useMockBackend } from "@/lib/mock/context";

export default function TeamsPage() {
  const { teams, agentsForTeam, createTeam } = useMockBackend();
  const [showNew, setShowNew] = useState(false);
  const router = useRouter();

  const newTeamButton = (
    <Button onClick={() => setShowNew(true)}>
      <PlusIcon className="h-4 w-4" />
      New team
    </Button>
  );

  return (
    <div className="pb-16">
      <PageHeader title="Teams" subtitle="Share context, skills, and instructions across a team's agents" action={newTeamButton} />

      {teams.length === 0 ? (
        <div className="px-10">
          <EmptyState
            icon={<UsersIcon className="h-6 w-6" />}
            title="No teams yet"
            subtitle="Create a team to share context across its agents."
            action={
              <Button onClick={() => setShowNew(true)}>
                <PlusIcon className="h-4 w-4" />
                New team
              </Button>
            }
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 px-10 pt-8 sm:grid-cols-2 lg:grid-cols-3">
          {teams.map((team) => (
            <Link key={team.id} href={`/teams/${team.id}`}>
              <Card className="p-5 transition-shadow hover:shadow-md">
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white">
                  <UsersIcon className="h-5 w-5" />
                </div>
                <h3 className="font-semibold text-slate-900">{team.name}</h3>
                <p className="mt-1 text-sm text-slate-500">{team.description || "No description"}</p>
                <p className="mt-3 text-xs text-slate-400">
                  {agentsForTeam(team.id).length} agent{agentsForTeam(team.id).length === 1 ? "" : "s"} assigned
                </p>
              </Card>
            </Link>
          ))}
        </div>
      )}

      {showNew && (
        <TeamFormModal
          title="New team"
          submitLabel="Create team"
          onClose={() => setShowNew(false)}
          onSubmit={({ name, description }) => {
            const team = createTeam(name, description);
            setShowNew(false);
            router.push(`/teams/${team.id}`);
          }}
        />
      )}
    </div>
  );
}
