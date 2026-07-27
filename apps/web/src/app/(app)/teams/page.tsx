"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TeamFormModal } from "@/components/TeamFormModal";
import { Button, CardLink, EmptyState, PageHeader } from "@/components/ui";
import { useTranslation } from "@/lib/i18n/context";
import { PlusIcon, UsersIcon } from "@/lib/icons";
import { useMockBackend } from "@/lib/mock/context";

export default function TeamsPage() {
  const { teams, agentsForTeam, createTeam } = useMockBackend();
  const { t } = useTranslation();
  const [showNew, setShowNew] = useState(false);
  const router = useRouter();

  const newTeamButton = (
    <Button onClick={() => setShowNew(true)}>
      <PlusIcon className="h-4 w-4" />
      {t("teams.newTeam")}
    </Button>
  );

  return (
    <div className="pb-16">
      <PageHeader title={t("teams.title")} subtitle={t("teams.subtitle")} action={newTeamButton} />

      {teams.length === 0 ? (
        <div className="px-10">
          <EmptyState
            icon={<UsersIcon className="h-6 w-6" />}
            title={t("teams.noTeamsYet")}
            subtitle={t("teams.noTeamsSubtitle")}
            action={
              <Button onClick={() => setShowNew(true)}>
                <PlusIcon className="h-4 w-4" />
                {t("teams.newTeam")}
              </Button>
            }
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 px-10 pt-8 sm:grid-cols-2 lg:grid-cols-3">
          {teams.map((team) => {
            const count = agentsForTeam(team.id).length;
            return (
              <CardLink key={team.id} href={`/teams/${team.id}`} className="p-5">
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white">
                  <UsersIcon className="h-5 w-5" />
                </div>
                <h3 className="font-semibold text-slate-900">{team.name}</h3>
                <p className="mt-1 text-sm text-slate-500">{team.description || t("teams.noDescription")}</p>
                <p className="mt-3 text-xs text-slate-400">
                  {count === 1 ? t("teams.agentAssignedOne") : t("teams.agentAssignedOther", { count })}
                </p>
              </CardLink>
            );
          })}
        </div>
      )}

      {showNew && (
        <TeamFormModal
          title={t("teamForm.newTitle")}
          submitLabel={t("teamForm.createSubmit")}
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
