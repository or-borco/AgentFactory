export const REDACTED = "[redacted]";
export const MAX_MASK_INPUT_CHARS = 20_000;
const MIN_KNOWN_SECRET_CHARS = 8;
const TRUNCATION_MARKER = "\n…[truncated]…\n";

export function keepTail(text: string, max: number): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max / 4);
  return `${text.slice(0, head)}${TRUNCATION_MARKER}${text.slice(text.length - (max - head))}`;
}

const PEM_BLOCK = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,20000}?-----END [A-Z ]{0,40}PRIVATE KEY-----/g;
const PEM_UNTERMINATED = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]*$/;
const PEM_HEADLESS = /^[\s\S]*?-----END [A-Z ]{0,40}PRIVATE KEY-----/;

const TOKEN_PATTERNS: RegExp[] = [
  /\barata-run-[A-Za-z0-9_-]{20,200}/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,255}/g,
  /\bsk-[A-Za-z0-9_-]{20,255}/g,
  /\b[sr]k_live_[A-Za-z0-9]{10,255}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,255}/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\beyJ[A-Za-z0-9_-]{5,2048}\.[A-Za-z0-9_-]{5,2048}\.[A-Za-z0-9_-]{5,2048}/g,
];

const PREFIXED_PATTERNS: Array<[RegExp, string]> = [
  [/\b(bearer\s{1,4})[A-Za-z0-9._~+/=-]{20,2048}/gi, `$1${REDACTED}`],
  [/\b(authorization:\s{0,4}basic\s{1,4})[A-Za-z0-9+/=]{8,2048}/gi, `$1${REDACTED}`],
  [/(x-access-token:)[^@\s]{1,512}@/gi, `$1${REDACTED}@`],
  [/\b([a-z][a-z0-9+.-]{1,20}:\/\/)(?!x-access-token:)[^\s:@/]{1,256}:[^\s@/]{1,512}@/gi, `$1${REDACTED}@`],
  [/(--(?:password|passwd|token|secret|api-key)(?:=|\s{1,4}))[^\s"']{1,512}/gi, `$1${REDACTED}`],
];

const ASSIGNMENT = /(["']?)([A-Za-z0-9_.-]{1,64})\1(\s{0,4}[:=]\s{0,4})(["']?)([^\s"',;]{8,512})\4/g;
const SECRET_NAME = /key|token|secret|passw(?:or)?d/i;

function knownValueForms(secret: string): string[] {
  const forms = new Set([secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64").replace(/=+$/, "")]);
  return [...forms];
}

function maskKnownValues(text: string, knownSecrets: readonly string[]): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret.length < MIN_KNOWN_SECRET_CHARS) continue;
    for (const form of knownValueForms(secret)) out = out.split(form).join(REDACTED);
  }
  return out;
}

function maskPrivateKeys(text: string): string {
  return text.replace(PEM_BLOCK, REDACTED).replace(PEM_UNTERMINATED, REDACTED).replace(PEM_HEADLESS, REDACTED);
}

function maskAssignments(text: string): string {
  return text.replace(ASSIGNMENT, (match, q1: string, name: string, sep: string, q2: string) =>
    SECRET_NAME.test(name) ? `${q1}${name}${q1}${sep}${q2}${REDACTED}${q2}` : match,
  );
}

export function maskSecrets(text: string, knownSecrets: readonly string[]): string {
  let out = maskKnownValues(keepTail(text, MAX_MASK_INPUT_CHARS), knownSecrets);
  out = maskPrivateKeys(out);
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
  for (const [pattern, replacement] of PREFIXED_PATTERNS) out = out.replace(pattern, replacement);
  return maskAssignments(out);
}
