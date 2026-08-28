import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { materializeCodexPatch, parseCodexPatch } from "../lib/patch.mjs";

test("parses one-file Codex Add File patches", () => {
  const parsed = parseCodexPatch(
    "*** Begin Patch\n*** Add File: AGENTS.md\n+Use uv.\n+Do not expose secrets.\n*** End Patch",
  );
  assert.equal(parsed.action, "add");
  assert.equal(parsed.file_path, "AGENTS.md");
  assert.equal(parsed.added_content, "Use uv.\nDo not expose secrets.");
});

test("materializes an end-anchored append patch", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-learning-gate-patch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "AGENTS.md");
  fs.writeFileSync(target, "Existing rule.\n");
  const parsed = parseCodexPatch(
    "*** Begin Patch\n*** Update File: AGENTS.md\n@@\n Existing rule.\n+Use uv.\n*** End of File\n*** End Patch",
  );
  const materialized = materializeCodexPatch(parsed, target);
  assert.equal(materialized.delta, "Use uv.");
  assert.equal(materialized.postimage, "Existing rule.\nUse uv.\n");
});

test("rejects Codex delete, replacement, move, and multi-file patches", () => {
  for (const source of [
    "*** Begin Patch\n*** Delete File: AGENTS.md\n*** End Patch",
    "*** Begin Patch\n*** Update File: AGENTS.md\n@@\n-old\n+new\n*** End Patch",
    "*** Begin Patch\n*** Update File: AGENTS.md\n*** Move to: OTHER.md\n@@\n old\n+new\n*** End Patch",
    "*** Begin Patch\n*** Add File: AGENTS.md\n+x\n*** Add File: CLAUDE.md\n+y\n*** End Patch",
  ]) {
    assert.throws(() => parseCodexPatch(source));
  }
});

test("rejects append patches without an explicit EOF anchor", () => {
  assert.throws(
    () =>
      parseCodexPatch(
        "*** Begin Patch\n*** Update File: AGENTS.md\n@@\n repeat\n+ADD\n*** End Patch",
      ),
    /space prefix|End of File/,
  );
});
