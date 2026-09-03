// Deliberately a leaf module with no imports. Both task-documents.ts (which writes the files)
// and scm-provider.ts (which teaches git to ignore them) need these two strings, and they have
// to agree — but scm-provider must not pull the storage and db packages that task-documents
// depends on into its own import graph, or every test that mocks @agentfactory/db would have to
// know about task documents to keep working.

// Where a task's attached documents land inside the checkout, relative to /workspace. A
// dot-directory alongside the repo's own files, so the agent finds it where it already looks.
export const TASK_DOCUMENT_DIR = ".agentfactory/context";

// What cloneIntoSandbox appends to .git/info/exclude. Anchored with a leading slash so it only
// ever matches the directory at the checkout root, never a same-named directory nested inside
// the repository being worked on.
export const TASK_DOCUMENT_EXCLUDE_PATTERN = "/.agentfactory/";
