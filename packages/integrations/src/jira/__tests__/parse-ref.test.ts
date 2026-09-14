import { describe, expect, it } from "vitest";
import { parseJiraIssueReference } from "../parse-ref";

const SITE = "https://acme.atlassian.net";

describe("parseJiraIssueReference", () => {
  it("extracts a bare key", () => {
    expect(parseJiraIssueReference("PROJ-123", SITE)).toBe("PROJ-123");
  });

  it("extracts a key embedded in a sentence", () => {
    expect(parseJiraIssueReference("Please look at PROJ-123 when you get a chance", SITE)).toBe(
      "PROJ-123",
    );
  });

  it("extracts a key from a browse URL", () => {
    expect(parseJiraIssueReference("https://acme.atlassian.net/browse/PROJ-123", SITE)).toBe(
      "PROJ-123",
    );
  });

  it("extracts a key from a browse URL with a query string", () => {
    expect(
      parseJiraIssueReference("https://acme.atlassian.net/browse/PROJ-123?commentId=456", SITE),
    ).toBe("PROJ-123");
  });

  it("extracts a key from a browse URL with a trailing slash", () => {
    expect(parseJiraIssueReference("https://acme.atlassian.net/browse/PROJ-123/", SITE)).toBe(
      "PROJ-123",
    );
  });

  it("rejects a browse URL for a different site rather than matching it anyway", () => {
    // Org A's connection is scoped to acme.atlassian.net -- a link into a different site's Jira
    // must never resolve, or org A could read org B's Jira by pasting one of its issue links.
    expect(
      parseJiraIssueReference("https://other.atlassian.net/browse/PROJ-123", SITE),
    ).toBeUndefined();
  });

  it("does not fall back to a bare-key match for a different-site URL", () => {
    // Same concern as above, made explicit: the key text "PROJ-123" is present in the string,
    // but it must not be picked up by a bare-key scan once the URL branch has already rejected it.
    expect(
      parseJiraIssueReference(
        "Check https://other.atlassian.net/browse/PROJ-123 for details",
        SITE,
      ),
    ).toBeUndefined();
  });

  it("matches lowercase input case-insensitively and normalizes the key", () => {
    expect(parseJiraIssueReference("proj-123", SITE)).toBe("PROJ-123");
  });

  it("matches a lowercase browse URL", () => {
    expect(parseJiraIssueReference("https://acme.atlassian.net/browse/proj-123", SITE)).toBe(
      "PROJ-123",
    );
  });

  it("returns undefined when there is no reference at all", () => {
    expect(parseJiraIssueReference("just a regular task description, nothing linked", SITE)).toBeUndefined();
  });

  it("does not treat UTF-8 as an issue key", () => {
    expect(parseJiraIssueReference("Please fix the UTF-8 encoding bug", SITE)).toBeUndefined();
  });

  it("does not treat COVID-19 as an issue key", () => {
    expect(parseJiraIssueReference("Track the COVID-19 dashboard metrics", SITE)).toBeUndefined();
  });

  it("skips a false-positive prefix and still finds a real key in the same text", () => {
    expect(
      parseJiraIssueReference("See PROJ-123 for our COVID-19 response tracker", SITE),
    ).toBe("PROJ-123");
  });
});
