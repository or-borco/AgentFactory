import { describe, expect, it } from "vitest";
import { MAX_MASK_INPUT_CHARS, REDACTED, keepTail, maskSecrets, truncateMiddle } from "../secret-masking";

const GH = `ghp_${"A1b2C3d4E5".repeat(4)}`;

describe("keepTail", () => {
  it("keeps the last max characters", () => {
    expect(keepTail("abcdef", 3)).toBe("def");
    expect(keepTail("abc", 5)).toBe("abc");
  });
});

describe("truncateMiddle", () => {
  it("keeps the first quarter and the last three quarters around a marker", () => {
    const text = `${"h".repeat(1_000)}${"t".repeat(3_000)}`;
    const out = truncateMiddle(text, 2_000);
    expect(out).toBe(`${"h".repeat(500)}\n…[truncated]…\n${"t".repeat(1_500)}`);
  });

  it("returns short text unchanged", () => {
    expect(truncateMiddle("short", 2_000)).toBe("short");
  });
});

describe("maskSecrets: known values", () => {
  const secret = "arata-run-Zx9_Qw8-Er7Ty6Ui5Op4As3Df2Gh1Jk0LzXcVbNm";

  it("masks the literal, URL-encoded and base64 forms", () => {
    const tricky = "p@ss/w0rd+Secret";
    const text = `a ${tricky} b ${encodeURIComponent(tricky)} c ${Buffer.from(tricky).toString("base64").replace(/=+$/, "")}`;
    expect(maskSecrets(text, [tricky])).toBe(`a ${REDACTED} b ${REDACTED} c ${REDACTED}`);
  });

  it("ignores known values shorter than 8 characters", () => {
    expect(maskSecrets("the word short stays", ["short"])).toBe("the word short stays");
  });

  it("masks the run proxy token by value and by pattern", () => {
    expect(maskSecrets(`token ${secret}`, [secret])).toBe(`token ${REDACTED}`);
    expect(maskSecrets(`token ${secret}`, [])).toBe(`token ${REDACTED}`);
  });
});

describe("maskSecrets: patterns", () => {
  it.each([
    ["GitHub classic", `push with ${GH} now`, `push with ${REDACTED} now`],
    ["GitHub fine-grained", `github_pat_${"a".repeat(30)}`, REDACTED],
    ["GitLab", `glpat-${"x".repeat(20)}`, REDACTED],
    ["sk- key", `sk-ant-${"k".repeat(30)}`, REDACTED],
    ["Stripe live", `sk_live_${"4".repeat(24)}`, REDACTED],
    ["AWS", "AKIAABCDEFGHIJKLMNOP", REDACTED],
    ["Slack", "xoxb-1234567890-abcdef", REDACTED],
    ["Google", `AIza${"B".repeat(35)}`, REDACTED],
    ["npm", `npm_${"n".repeat(36)}`, REDACTED],
    ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlLXZhbHVl", REDACTED],
    ["Bearer any case", `authorization: BEARER ${"t".repeat(24)}`, `authorization: BEARER ${REDACTED}`],
    ["Basic auth", "Authorization: Basic dXNlcjpwYXNzd29yZA==", `Authorization: Basic ${REDACTED}`],
    ["x-access-token", "https://x-access-token:abc123def@github.com/o/r", `https://x-access-token:${REDACTED}@github.com/o/r`],
    ["URL credentials", "postgres://admin:hunter22@db:5432/app", `postgres://${REDACTED}@db:5432/app`],
    ["CLI flag", "mysql --password=Sup3rS3cret -u root", `mysql --password=${REDACTED} -u root`],
    ["env assignment", "API_KEY=abcd1234efgh", `API_KEY=${REDACTED}`],
    ["JSON key", `{"client_secret": "abcd1234efgh"}`, `{"client_secret": "${REDACTED}"}`],
    ["MONKEY is masked too (accepted)", "MONKEY=bananas123", `MONKEY=${REDACTED}`],
  ])("%s", (_name, input, expected) => {
    expect(maskSecrets(input, [])).toBe(expected);
  });

  it("masks a complete private key block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----";
    expect(maskSecrets(`before\n${pem}\nafter`, [])).toBe(`before\n${REDACTED}\nafter`);
  });

  it("masks from BEGIN to the end when END is missing", () => {
    expect(maskSecrets("x\n-----BEGIN PRIVATE KEY-----\nMIIE", [])).toBe(`x\n${REDACTED}`);
  });

  it("masks from the start to END when BEGIN is missing", () => {
    expect(maskSecrets("MIIE\nabc\n-----END PRIVATE KEY-----\ntail", [])).toBe(`${REDACTED}\ntail`);
  });
});

describe("maskSecrets: no false positives", () => {
  it.each([
    "Merged 3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39 into main",
    "Session 5d1b2c3a-9e8f-4a7b-8c6d-5e4f3a2b1c0d started",
    "The primary_key: id column is fine",
    "Error: Cannot find module './foo' at https://example.com/docs",
    "npm ERR! code ELIFECYCLE",
  ])("%s", (text) => {
    expect(maskSecrets(text, [])).toBe(text);
  });
});

describe("maskSecrets: bounded work", () => {
  it.each([
    ["a=", "a=".repeat(500_000)],
    ["BEGIN", "-----BEGIN RSA PRIVATE KEY-----".repeat(40_000)],
    ["key", "key".repeat(350_000)],
    ["bearer", "Bearer ".repeat(150_000)],
  ])("finishes a 1 MB %s input quickly and keeps only the tail", (_name, input) => {
    const start = performance.now();
    const out = maskSecrets(input, ["someknownsecret"]);
    expect(performance.now() - start).toBeLessThan(200);
    expect(out.length).toBeLessThanOrEqual(MAX_MASK_INPUT_CHARS);
  });
});
