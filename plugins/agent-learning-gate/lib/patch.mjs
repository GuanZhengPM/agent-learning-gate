import fs from "node:fs";

function cleanPath(value) {
  const path = String(value || "").trim();
  if (!path || path.includes("\0")) throw new Error("Patch target path is missing or invalid.");
  return path;
}

export function parseCodexPatch(command) {
  const source = String(command || "").replace(/\r\n/g, "\n");
  const lines = source.split("\n");
  const begin = lines.indexOf("*** Begin Patch");
  const end = lines.lastIndexOf("*** End Patch");
  if (begin < 0 || end <= begin) throw new Error("Codex patch must contain Begin/End markers.");
  if (lines.slice(0, begin).some((line) => line.trim())) {
    throw new Error("Codex patch contains data before Begin Patch.");
  }
  if (lines.slice(end + 1).some((line) => line.trim())) {
    throw new Error("Codex patch contains data after End Patch.");
  }

  const markerIndexes = [];
  for (let index = begin + 1; index < end; index += 1) {
    if (/^\*\*\* (?:Add|Update|Delete) File: /.test(lines[index])) markerIndexes.push(index);
    if (/^\*\*\* Move to: /.test(lines[index])) {
      throw new Error("Codex durable-learning patches cannot move files.");
    }
  }
  if (markerIndexes.length !== 1) {
    throw new Error("Codex durable-learning patches must touch exactly one file.");
  }

  const markerIndex = markerIndexes[0];
  const marker = lines[markerIndex];
  const match = marker.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
  if (!match) throw new Error("Unsupported Codex patch marker.");
  const action = match[1].toLowerCase();
  const filePath = cleanPath(match[2]);
  if (action === "delete") {
    throw new Error("Codex durable-learning patches cannot delete files.");
  }

  const body = lines.slice(markerIndex + 1, end);
  if (action === "add") {
    if (body.some((line) => !line.startsWith("+"))) {
      throw new Error("Add File patches must contain only added lines.");
    }
    const addedLines = body.map((line) => line.slice(1));
    return {
      action,
      file_path: filePath,
      added_lines: addedLines,
      added_content: addedLines.join("\n"),
      context_lines: [],
    };
  }

  let hunkCount = 0;
  let sawAddition = false;
  let sawEndOfFile = false;
  const addedLines = [];
  const contextLines = [];
  for (const line of body) {
    if (line.startsWith("@@")) {
      hunkCount += 1;
      if (hunkCount > 1) throw new Error("Append patches may contain only one hunk.");
      continue;
    }
    if (line === "*** End of File") {
      sawEndOfFile = true;
      continue;
    }
    if (line.startsWith("-")) {
      throw new Error("Codex v0 supports add or append patches, not replacement/removal.");
    }
    if (line.startsWith("+")) {
      sawAddition = true;
      addedLines.push(line.slice(1));
      continue;
    }
    if (sawAddition && line.trim()) {
      throw new Error("Append patch context cannot follow added content.");
    }
    if (!sawAddition) {
      if (line && !line.startsWith(" ")) {
        throw new Error("Append patch context lines must use the apply_patch space prefix.");
      }
      contextLines.push(line.startsWith(" ") ? line.slice(1) : line);
    }
  }
  while (contextLines.length && contextLines[0] === "") contextLines.shift();
  while (contextLines.length && contextLines.at(-1) === "") contextLines.pop();
  if (!sawAddition || addedLines.length === 0) throw new Error("Append patch adds no content.");
  if (contextLines.length === 0) {
    throw new Error("Append patch must anchor to the current end of file.");
  }
  if (!sawEndOfFile) {
    throw new Error("Append patch must include the explicit End of File sentinel.");
  }
  return {
    action,
    file_path: filePath,
    added_lines: addedLines,
    added_content: addedLines.join("\n"),
    context_lines: contextLines,
  };
}

export function materializeCodexPatch(parsed, targetPath) {
  const exists = fs.existsSync(targetPath);
  if (parsed.action === "add") {
    if (exists) throw new Error("Add File patch target already exists.");
    const postimage = parsed.added_content
      ? `${parsed.added_content}${parsed.added_content.endsWith("\n") ? "" : "\n"}`
      : "";
    return { current: "", delta: parsed.added_content, postimage };
  }
  if (!exists) throw new Error("Append patch target does not exist.");
  const current = fs.readFileSync(targetPath, "utf8");
  const anchor = parsed.context_lines.join("\n").trimEnd();
  if (!current.trimEnd().endsWith(anchor)) {
    throw new Error("Append patch context is not anchored at the current end of file.");
  }
  const separator = current && !current.endsWith("\n") ? "\n" : "";
  const addition = parsed.added_content
    ? `${parsed.added_content}${parsed.added_content.endsWith("\n") ? "" : "\n"}`
    : "";
  return {
    current,
    delta: parsed.added_content,
    postimage: `${current}${separator}${addition}`,
  };
}
