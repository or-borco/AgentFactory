"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { TeamFormModal } from "@/components/TeamFormModal";
import { Badge, Breadcrumb, Button, Card, CardLink, Textarea, Truncate } from "@agentfactory/shared";
import { useTranslation } from "@/lib/i18n/context";
import { ArrowLeftIcon, ChevronDownIcon, SettingsIcon, UsersIcon } from "@/lib/icons";
import { useMockBackend } from "@/lib/mock/context";
import type { Team } from "@agentfactory/core";

const SHARED_CONTEXT_MAX_BYTES = 64 * 1024;

export default function TeamDetailPage() {
  const { teamId } = useParams<{ teamId: string }>();
  const { getTeam } = useMockBackend();
  const { t } = useTranslation();
  const team = getTeam(Number(teamId));

  if (!team) {
    return <div className="px-10 py-10 text-sm text-slate-500">{t("common.loading")}</div>;
  }

  return <TeamDetailBody key={team.id} team={team} />;
}

function TeamDetailBody({ team }: { team: Team }) {
  const { agentsForTeam, agents, teams, updateTeam, updateTeamSharedContext, assignAgentToTeam } = useMockBackend();
  const { t } = useTranslation();
  const [draft, setDraft] = useState(team.sharedContext);
  const [showEdit, setShowEdit] = useState(false);
  const [assignId, setAssignId] = useState("");
  const [reassignTarget, setReassignTarget] = useState<{ agentId: number; agentName: string; teamName: string } | null>(
    null,
  );

  const assigned = agentsForTeam(team.id);
  const unassigned = agents.filter((a) => a.teamId !== team.id);
  const bytes = new TextEncoder().encode(draft).length;
  const dirty = draft !== team.sharedContext;

  const requestAssign = (agentId: number) => {
    const agent = agents.find((a) => a.id === agentId);
    const currentTeam = agent?.teamId !== undefined ? teams.find((t) => t.id === agent.teamId) : undefined;
    if (agent && currentTeam) {
      setReassignTarget({ agentId, agentName: agent.name, teamName: currentTeam.name });
      return;
    }
    void assignAgentToTeam(agentId, team.id);
    setAssignId("");
  };

  return (
    <div className="pb-16">
      <div className="px-10 pt-8">
        <Breadcrumb href="/teams" label={t("teams.title")} icon={<ArrowLeftIcon className="h-4 w-4" />} />
      </div>

      <div className="flex items-start justify-between px-10 pt-4">
        <div className="flex min-w-0 items-start gap-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white">
            <UsersIcon className="h-6 w-6" />
          </div>
          <div className="min-w-0">
            <Truncate as="h1" text={team.name} className="text-xl font-bold text-slate-900" />
            <p className="mt-0.5 text-sm text-slate-500">{team.description || t("teams.noDescription")}</p>
          </div>
        </div>
        <Button variant="secondary" onClick={() => setShowEdit(true)}>
          <SettingsIcon className="h-4 w-4" />
          {t("common.edit")}
        </Button>
      </div>

      <div className="px-10 pt-8">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900">{t("teams.sharedContext")}</h2>
          <Button
            variant={dirty ? "primary" : "secondary"}
            disabled={!dirty}
            onClick={() => void updateTeamSharedContext(team.id, draft)}
          >
            {t("common.save")}
          </Button>
        </div>
        <p className="mb-3 text-sm text-slate-500">{t("teams.sharedContextDescription")}</p>
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={8}
          placeholder={t("teams.sharedContextPlaceholder")}
        />
        <p className={`mt-1.5 text-right text-xs ${bytes > SHARED_CONTEXT_MAX_BYTES ? "text-red-500" : "text-slate-400"}`}>
          {t("teams.kbOfKb", { used: (bytes / 1024).toFixed(1), max: SHARED_CONTEXT_MAX_BYTES / 1024 })}
        </p>
      </div>

      <div className="px-10 pt-8">
        <h2 className="mb-3 text-base font-semibold text-slate-900">{t("teams.assignedAgents")}</h2>

        {assigned.length === 0 ? (
          <Card className="px-5 py-10 text-center text-sm text-slate-500">{t("teams.noAgentsAssigned")}</Card>
        ) : (
          <div className="space-y-2">
            {assigned.map((agent) => (
              <CardLink key={agent.id} href={`/agents/${agent.id}`} className="flex items-center justify-between px-5 py-4">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="shrink-0 text-lg">{agent.avatarEmoji}</span>
                  <Truncate text={agent.name} className="text-sm font-medium text-slate-900" wrapperClassName="min-w-0 flex-1" />
                </div>
                {agent.mode === "automatic" && <Badge>{t("common.automatic")}</Badge>}
              </CardLink>
            ))}
          </div>
        )}

        {unassigned.length > 0 && (
          <div className="mt-4 flex items-center gap-2">
            <div className="relative">
              <select
                value={assignId}
                onChange={(e) => setAssignId(e.target.value)}
                className="appearance-none rounded-lg border border-slate-200 py-2 pl-3 pr-9 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
              >
                <option value="">{t("teams.assignAgentPlaceholder")}</option>
                {unassigned.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            </div>
            <Button variant="secondary" disabled={!assignId} onClick={() => requestAssign(Number(assignId))}>
              {t("teams.assign")}
            </Button>
          </div>
        )}
      </div>

      {showEdit && (
        <TeamFormModal
          title={t("teamForm.editTitle")}
          submitLabel={t("teamForm.saveSubmit")}
          initial={{ name: team.name, description: team.description ?? "" }}
          onClose={() => setShowEdit(false)}
          onSubmit={async (values) => {
            await updateTeam(team.id, values);
            setShowEdit(false);
          }}
        />
      )}

      {reassignTarget && (
        <ConfirmDialog
          title={t("teams.reassignAgentTitle")}
          message={t("teams.reassignAgentMessage", { agent: reassignTarget.agentName, team: reassignTarget.teamName })}
          confirmLabel={t("teams.reassignAgentConfirm")}
          cancelLabel={t("common.cancel")}
          onCancel={() => setReassignTarget(null)}
          onConfirm={() => {
            void assignAgentToTeam(reassignTarget.agentId, team.id);
            setAssignId("");
            setReassignTarget(null);
          }}
        />
      )}
    </div>
  );
}
