"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TeamFormModal } from "@/components/TeamFormModal";
import { Button, CardLink, EmptyState, PageHeader, Truncate } from "@agentfactory/shared";
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
      <PlusIcon size={15} />
      {t("teams.newTeam")}
    </Button>
  );

  return (
    <div className="pb-16">
      <PageHeader title={t("teams.title")} subtitle={t("teams.subtitle")} action={newTeamButton} />

      {teams.length === 0 ? (
        <div className="px-10">
          <EmptyState
            icon={<UsersIcon size={24} />}
            title={t("teams.noTeamsYet")}
            subtitle={t("teams.noTeamsSubtitle")}
            action={
              <Button onClick={() => setShowNew(true)}>
                <PlusIcon size={15} />
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
                <div
                  className="mb-4 flex items-center justify-center bg-[var(--color-accent-800)] border border-[var(--color-accent-600)] text-[var(--color-accent)]"
                  style={{ width: 40, height: 40, borderRadius: "var(--radius-md)" }}
                >
                  <UsersIcon size={18} />
                </div>
                <Truncate as="h3" text={team.name} className="font-semibold text-[var(--color-text)]" />
                <p className="mt-1 text-sm text-[var(--color-neutral-500)]">{team.description || t("teams.noDescription")}</p>
                <p className="mt-3 text-xs text-[var(--color-neutral-600)]">
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
          onSubmit={async ({ name, description }) => {
            const team = await createTeam(name, description);
            setShowNew(false);
            router.push(`/teams/${team.id}`);
          }}
        />
      )}
    </div>
  );
}
