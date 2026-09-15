"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button, Breadcrumb, GroupedSelect, PageHeader, TextInput, Textarea, TooltipBubble } from "@agentfactory/shared";
import { apiFetch } from "@/lib/api-client";
import { useMockBackend } from "@/lib/mock/context";
import { useTranslation } from "@/lib/i18n/context";
import { DEFAULT_MODEL_ID, MODEL_CATALOG, type TaskExternalRef } from "@agentfactory/core";
import type { ExternalAttachment, ExternalIssue } from "@agentfactory/integrations";
import { useRepoMapWaitGate } from "@/lib/use-repo-map-wait-gate";
import { RepoMapWaitBanner } from "@/components/RepoMapWaitBanner";
import type { RepoOption } from "@agentfactory/scm";

interface StagedFile {
  id: number;
  file: File;
}

// Mirrors ContextDocumentsPanel.tsx's own copy of these — see that file's comments for the
// reasoning. A task doesn't exist yet at this point in the flow (see handleSubmit), so there is
// no route to enforce these against client-side; this only corrects an unreliable browser mime
// before the real upload, after the task is created.
const ALLOWED_MIMES = ["text/markdown", "text/plain"];

function extensionMime(filename: string): "text/markdown" | "text/plain" | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".txt")) return "text/plain";
  return null;
}

export default function NewTaskPage() {
  const router = useRouter();
  const { agents, connections, createTask, notify } = useMockBackend();
  const { t } = useTranslation();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [criteriaRaw, setCriteriaRaw] = useState("");
  const [issueRef, setIssueRef] = useState("");
  const [fetchingIssue, setFetchingIssue] = useState(false);
  const [issueFetchError, setIssueFetchError] = useState<string | null>(null);
  const [issueAttachments, setIssueAttachments] = useState<ExternalAttachment[]>([]);
  const [externalRef, setExternalRef] = useState<TaskExternalRef | undefined>(undefined);
  const [assigneeAgentId, setAssigneeAgentId] = useState<number | undefined>(undefined);
  const [modelId, setModelId] = useState(DEFAULT_MODEL_ID);
  const [modelTouched, setModelTouched] = useState(false);
  const [area, setArea] = useState("");
  const [codebaseOverride, setCodebaseOverride] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [repos, setRepos] = useState<RepoOption[]>([]);
  const [reposLoading, setReposLoading] = useState(true);
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);
  const nextStagedIdRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    apiFetch<RepoOption[]>("/api/connections/repos")
      .then((result) => {
        if (!cancelled) setRepos(result);
      })
      .finally(() => {
        if (!cancelled) setReposLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedAgent = agents.find((a) => a.id === assigneeAgentId);

  // The From-issue field is provider-neutral (Design decision 14 in the Jira integration spec):
  // it enables and labels itself from whichever `kind: "tasks"` connection the org has, never a
  // hardcoded "Jira" string. No extra fetch — `connections` is already in useMockBackend()'s state.
  const tasksConnection = connections.find((c) => c.kind === "tasks");

  async function handleFetchIssue() {
    if (!tasksConnection || !issueRef.trim() || fetchingIssue) return;
    setFetchingIssue(true);
    setIssueFetchError(null);
    try {
      const issue = await apiFetch<ExternalIssue>(
        `/api/connections/tasks/issue?ref=${encodeURIComponent(issueRef.trim())}`,
      );
      // Prefill only — every field below stays editable afterward, and acceptance criteria are
      // deliberately left untouched (not auto-extracted from the issue description).
      setTitle(issue.title);
      setDescription(issue.description);
      setIssueAttachments(issue.attachments);
      setExternalRef({
        provider: tasksConnection.provider,
        key: issue.key,
        url: issue.url,
        lastKnownUpdated: issue.updated,
      });
    } catch (err) {
      setIssueFetchError(err instanceof Error ? err.message : t("taskCreate.linkedIssue.fetchFailed"));
    } finally {
      setFetchingIssue(false);
    }
  }

  // Pre-select the assignee's default codebase once the connected-repo list is known, but only
  // if the assigner hasn't already picked a repo themselves. If the agent's default isn't among
  // the connected repos, fall back to no selection rather than showing an unusable value.
  const defaultCodebase = selectedAgent?.defaultCodebase;
  const preselectedCodebase =
    defaultCodebase && repos.some((repo) => repo.fullName === defaultCodebase) ? defaultCodebase : "";
  const codebase = codebaseOverride ?? preselectedCodebase;

  function handleAssigneeChange(nextId: number | undefined) {
    setAssigneeAgentId(nextId);
    const nextAgent = agents.find((a) => a.id === nextId);
    if (!modelTouched && nextAgent) setModelId(nextAgent.model.id);
  }

  function handleModelChange(nextModelId: string) {
    setModelId(nextModelId);
    setModelTouched(selectedAgent ? nextModelId !== selectedAgent.model.id : true);
  }

  function handleCodebaseChange(nextCodebase: string) {
    setCodebaseOverride(nextCodebase);
  }

  // Files are staged client-side only — there is no taskId to upload against until the task
  // itself is created (see handleSubmit). No validation happens here; the real upload after
  // creation hits the same route the team panel does, and any rejection (size, type, duplicate)
  // is reported the same way any other failed staged upload is.
  function handleFilesSelected(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const staged = Array.from(fileList).map((file) => ({ id: nextStagedIdRef.current++, file }));
    setStagedFiles((prev) => [...prev, ...staged]);
  }

  function removeStagedFile(id: number) {
    setStagedFiles((prev) => prev.filter((staged) => staged.id !== id));
  }

  async function doSubmit() {
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      const acceptanceCriteria = criteriaRaw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((text) => ({ text, done: false }));

      // Only send an explicit model when it overrides the assignee's default (or there's no
      // assignee to default to) — otherwise leave it unset so the task keeps following the
      // agent's configured model even if that changes later.
      const model =
        selectedAgent && !modelTouched ? undefined : { family: "anthropic" as const, id: modelId, maxTokens: 8192 };

      const task = await createTask({
        title: title.trim(),
        description: description.trim(),
        acceptanceCriteria,
        assigneeAgentId,
        area: area.trim() || undefined,
        codebase: codebase.trim() || undefined,
        model,
        externalRef,
        attachments: externalRef ? issueAttachments : undefined,
      });

      // Staged files are POSTed one at a time only now that a real taskId exists. A failed
      // upload must never block navigation — the task itself already exists — so failures are
      // just collected and surfaced as a toast that survives the navigation below (the toast
      // lives in MockBackendProvider, above this page in the (app) layout).
      const failedNames: string[] = [];
      for (const staged of stagedFiles) {
        let mime = staged.file.type;
        if (!ALLOWED_MIMES.includes(mime)) {
          const fallback = extensionMime(staged.file.name);
          if (fallback) mime = fallback;
        }
        const uploadFile =
          mime === staged.file.type ? staged.file : new File([staged.file], staged.file.name, { type: mime });
        const body = new FormData();
        body.append("file", uploadFile);
        body.append("title", staged.file.name);
        try {
          await apiFetch(`/api/tasks/${task.id}/context-items`, { method: "POST", body });
        } catch {
          failedNames.push(staged.file.name);
        }
      }
      if (failedNames.length > 0) {
        notify("toast.taskContextUploadFailed", { names: failedNames.join(", ") });
      }

      router.push(`/tasks/${task.id}`);
    } finally {
      setSubmitting(false);
    }
  }

  // Declared after doSubmit so the callback below doesn't reference it before its declaration
  // (which this project's react-hooks/immutability lint rule rejects).
  const gate = useRepoMapWaitGate(codebase, () => void doSubmit());
  const gateBlocking = gate.state === "checking" || gate.state === "prompt" || gate.state === "waiting";

  // The repo-map check runs on the submit *attempt*, after this form's own validation — the gate
  // then calls doSubmit() via onProceed, either immediately or once the user has made their
  // wait/start-now choice. doSubmit is never called directly from here.
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    if (gateBlocking) return;
    gate.requestSubmit();
  }

  return (
    <div style={{ padding: "40px 40px 0", maxWidth: 680 }}>
      <Breadcrumb label={t("tasks.title")} href="/tasks" />

      <div style={{ marginTop: 20 }}>
        <PageHeader title={t("tasks.create.title")} subtitle={t("tasks.create.subtitle")} />
      </div>

      <form onSubmit={handleSubmit} style={{ marginTop: 28, display: "flex", flexDirection: "column", gap: 20 }}>
        {/* From issue — provider-neutral: disabled with a tooltip until the org has a
            tasks-kind connection, then labeled and enabled for whichever provider that is. */}
        <Field
          label={
            tasksConnection
              ? t("taskCreate.linkedIssue.fromIssueLabel", {
                  provider: t(`connections.provider.${tasksConnection.provider}`),
                })
              : t("taskCreate.linkedIssue.fromIssueLabelDisabled")
          }
        >
          <div className="group/tooltip relative" style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1 }}>
              <TextInput
                placeholder={t("taskCreate.linkedIssue.refPlaceholder")}
                value={issueRef}
                onChange={(e) => setIssueRef(e.target.value)}
                disabled={!tasksConnection || fetchingIssue}
              />
            </div>
            <Button
              type="button"
              variant="secondary"
              disabled={!tasksConnection || fetchingIssue || !issueRef.trim()}
              onClick={handleFetchIssue}
            >
              {fetchingIssue ? t("taskCreate.linkedIssue.fetching") : t("taskCreate.linkedIssue.fetch")}
            </Button>
            {!tasksConnection && <TooltipBubble label={t("taskCreate.linkedIssue.disabledTooltip")} />}
          </div>
          {issueFetchError && (
            <p style={{ marginTop: 4, fontSize: 12, color: "#e8a44a" }}>{issueFetchError}</p>
          )}
          {issueAttachments.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <p style={{ fontSize: 12, fontWeight: 600, color: "var(--color-neutral-500)" }}>
                {t("taskCreate.linkedIssue.attachmentsLabel")}
              </p>
              <ul style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 4, listStyle: "none", padding: 0 }}>
                {issueAttachments.map((attachment, i) => (
                  <li
                    key={i}
                    style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12, color: "var(--color-neutral-400)" }}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {attachment.filename}
                    </span>
                    <span style={{ flexShrink: 0, color: "var(--color-neutral-500)" }}>
                      {t("teamsV2.documentsSize", { size: (attachment.sizeBytes / 1024).toFixed(1) })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Field>

        {/* Title */}
        <Field label={t("tasks.create.titleLabel")}>
          <TextInput
            placeholder={t("tasks.create.titlePlaceholder")}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
        </Field>

        {/* Description */}
        <Field label={t("tasks.create.descriptionLabel")}>
          <Textarea
            placeholder={t("tasks.create.descriptionPlaceholder")}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
          />
        </Field>

        {/* Acceptance criteria */}
        <Field label={t("tasks.create.criteriaLabel")}>
          <Textarea
            placeholder={t("tasks.create.criteriaPlaceholder")}
            value={criteriaRaw}
            onChange={(e) => setCriteriaRaw(e.target.value)}
            rows={4}
          />
          <p style={{ marginTop: 4, fontSize: 12, color: "var(--color-neutral-500)" }}>
            {t("tasks.create.criteriaHint")}
          </p>
        </Field>

        {/* Assignee */}
        <Field label={t("tasks.create.assigneeLabel")}>
          <select
            value={assigneeAgentId ?? ""}
            onChange={(e) => handleAssigneeChange(e.target.value ? Number(e.target.value) : undefined)}
            style={selectStyle(assigneeAgentId !== undefined)}
          >
            <option value="">{t("tasks.create.assigneePlaceholder")}</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </Field>

        {/* Model */}
        <Field label={t("tasks.create.modelLabel")}>
          <select value={modelId} onChange={(e) => handleModelChange(e.target.value)} style={selectStyle(true)}>
            {MODEL_CATALOG.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
          <p style={{ marginTop: 4, fontSize: 12, color: "var(--color-neutral-500)" }}>
            {!selectedAgent
              ? t("tasks.create.modelHelperNoAgent")
              : modelTouched
                ? t("tasks.create.modelHelperOverride", { agent: selectedAgent.name })
                : t("tasks.create.modelHelperDefault", { agent: selectedAgent.name })}
          </p>
        </Field>

        {/* Area + codebase — side by side */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <Field label={t("tasks.create.areaLabel")}>
            <TextInput
              placeholder={t("tasks.create.areaPlaceholder")}
              value={area}
              onChange={(e) => setArea(e.target.value)}
            />
          </Field>
          <Field label={t("tasks.create.codebaseLabel")}>
            <GroupedSelect
              value={codebase}
              onChange={handleCodebaseChange}
              style={selectStyle(!!codebase)}
              placeholder={reposLoading ? t("tasks.create.codebaseLoading") : t("tasks.create.codebasePlaceholder")}
              options={repos.map((repo) => ({
                key: repo.id,
                value: repo.fullName,
                label: repo.fullName,
                group: repo.provider,
              }))}
              groupLabel={(provider) => t(`connections.provider.${provider}`)}
            />
            {!reposLoading && repos.length === 0 && (
              <p style={{ marginTop: 4, fontSize: 12, color: "var(--color-neutral-500)" }}>
                {t("tasks.create.codebaseEmpty")}{" "}
                <Link href="/connections" style={{ color: "var(--color-accent-2)" }}>
                  {t("tasks.create.codebaseEmptyLink")}
                </Link>
              </p>
            )}
          </Field>
        </div>

        <RepoMapWaitBanner gate={gate} />

        {/* Context documents — staged locally; uploaded to the task once it's created below. */}
        <Field label={t("tasks.create.contextLabel")}>
          <label
            style={{
              position: "relative",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              border: "1.5px dashed var(--color-neutral-700)",
              borderRadius: "var(--radius-md)",
              padding: "20px 20px",
              textAlign: "center",
              color: "var(--color-neutral-500)",
              fontSize: 13,
            }}
          >
            {t("tasks.create.contextDropHint")}
            <input
              type="file"
              multiple
              accept=".md,.markdown,.txt,text/markdown,text/plain"
              aria-label={t("tasks.create.contextUpload")}
              style={{
                position: "absolute",
                width: 1,
                height: 1,
                padding: 0,
                margin: -1,
                overflow: "hidden",
                clip: "rect(0,0,0,0)",
                whiteSpace: "nowrap",
                border: 0,
              }}
              onChange={(e) => {
                handleFilesSelected(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          <p style={{ marginTop: 4, fontSize: 12, color: "var(--color-neutral-500)" }}>
            {t("tasks.create.contextHelp")}
          </p>
          {stagedFiles.length > 0 && (
            <ul style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6, listStyle: "none", padding: 0 }}>
              {stagedFiles.map((staged) => (
                <li
                  key={staged.id}
                  style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--color-neutral-300)" }}
                >
                  <span
                    style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {staged.file.name}
                  </span>
                  <span style={{ flexShrink: 0, fontSize: 12, color: "var(--color-neutral-500)" }}>
                    {(staged.file.size / 1024).toFixed(1)} KB
                  </span>
                  <button
                    type="button"
                    onClick={() => removeStagedFile(staged.id)}
                    style={{
                      flexShrink: 0,
                      background: "none",
                      border: "none",
                      color: "var(--color-neutral-500)",
                      cursor: "pointer",
                      fontSize: 12,
                    }}
                  >
                    {t("tasks.create.contextRemoveFile")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Field>

        {/* Actions */}
        <div style={{ display: "flex", gap: 10, paddingBottom: 40 }}>
          <Button variant="primary" type="submit" disabled={!title.trim() || submitting || gateBlocking}>
            {submitting ? "Creating…" : t("tasks.create.submit")}
          </Button>
          <Link href="/tasks">
            <Button variant="secondary" type="button">{t("tasks.create.cancel")}</Button>
          </Link>
        </div>
      </form>
    </div>
  );
}

function selectStyle(hasValue: boolean): React.CSSProperties {
  return {
    width: "100%",
    padding: "8px 10px",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--color-neutral-700)",
    background: "var(--color-surface)",
    color: hasValue ? "var(--color-text)" : "var(--color-neutral-500)",
    fontSize: 13,
  };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: "var(--color-neutral-300)", letterSpacing: "0.01em" }}>
        {label}
      </label>
      {children}
    </div>
  );
}
