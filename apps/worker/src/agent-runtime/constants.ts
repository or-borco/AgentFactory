// Must match RESULT_MARKER in apps/worker/sandbox-image/run-turn-claude.ts (and any future
// adapter's own turn-runner script — the marker protocol is shared across runtimes).
export const RESULT_MARKER = "__RESULT__";
export const EVENT_MARKER = "__EVENT__";
export const ERROR_MARKER = "__ERROR__";
