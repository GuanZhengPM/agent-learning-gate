import assert from "node:assert/strict";
import test from "node:test";

import { candidateKind, redact } from "../../../scripts/extract-local-feedback.mjs";

test("redact removes common API, cloud, SCM and collaboration tokens", () => {
  const secrets = [
    `sk-${"proj"}-abcdefgh12345678`,
    `sk-${"ant"}-abcdefgh12345678`,
    `AKIA${"IOSFODNN7EXAMPLE"}`,
    `${"eyJhbGciOiJIUzI1NiJ9"}.${"eyJzdWIiOiIxMjM0NTY3ODkwIn0"}.signature123`,
    `xoxb-${"123456789012"}-abcdefghijkl`,
    `ghp_${"abcdefghijklmnopqrstuvwxyz123456"}`,
    `github_${"pat"}_11AAabcdefghijklmnopqrstuvwxyz`,
  ];

  const output = redact(`credentials: ${secrets.join(" ")}`);

  for (const secret of secrets) assert.equal(output.includes(secret), false);
  assert.equal(output.match(/<SECRET>/g)?.length, secrets.length);
});

test("redact removes macOS, Linux root and Windows paths", () => {
  const output = redact(
    "open /Volumes/Work/private.txt and /root/.ssh/id_ed25519 plus C:\\Users\\alice\\secret.txt",
  );

  assert.equal(output, "open <PATH> and <PATH> plus <PATH>");
});

test("redact consumes complete quoted paths containing spaces", () => {
  const output = redact(
    "open \"/Users/alice/Secret Project/client.txt\" and '/Volumes/Client Data/plan.md'",
  );

  assert.equal(output, "open <PATH> and <PATH>");
  assert.equal(output.includes("Secret Project"), false);
  assert.equal(output.includes("Client Data"), false);
});

test("redact consumes unquoted paths containing spaces", () => {
  const output = redact(
    "open /Users/alice/Secret Project/client.txt and /Volumes/Client Data/plan.md",
  );
  assert.equal(output, "open <PATH> and <PATH>");
});

test("redact removes bearer authorization and token assignments", () => {
  const bearer = "opaque-bearer-value-123456";
  const token = "environment-token-value-123456";
  const quotedToken = "token with private spaces";
  const output = redact(
    `Authorization: Bearer ${bearer}\nAPI_TOKEN=${token}\nGITHUB_TOKEN="${quotedToken}"`,
  );

  assert.equal(output.includes(bearer), false);
  assert.equal(output.includes(token), false);
  assert.equal(output.includes(quotedToken), false);
  assert.match(output, /Authorization: Bearer <SECRET>/);
  assert.match(output, /API_TOKEN=<SECRET>/);
  assert.match(output, /GITHUB_TOKEN=<SECRET>/);
});

test("redact removes short and unterminated fenced code blocks", () => {
  assert.equal(redact("before ```js\nlet x = 1;\n``` after"), "before <CODE_BLOCK> after");
  assert.equal(redact("before ```\nsecret\n"), "before <CODE_BLOCK>");
});

test("correction takes precedence over praise in English", () => {
  assert.equal(
    candidateKind("Nice work, but this is wrong. Do not save it globally."),
    "negative_or_correction_candidate",
  );
  assert.equal(
    candidateKind("Great, but please change the output to JSON."),
    "negative_or_correction_candidate",
  );
});

test("correction takes precedence over praise in Chinese", () => {
  assert.equal(
    candidateKind("做得不错，但这里不对，不要记成全局偏好。"),
    "negative_or_correction_candidate",
  );
  assert.equal(
    candidateKind("整体不错，但是这里改成表格。"),
    "negative_or_correction_candidate",
  );
});

test("unmixed praise remains a positive candidate", () => {
  assert.equal(candidateKind("Nice work, exactly."), "positive_candidate");
  assert.equal(candidateKind("做得不错，就是这样。"), "positive_candidate");
  assert.equal(candidateKind("对了，我还有一个问题。"), "feedback_candidate");
});
