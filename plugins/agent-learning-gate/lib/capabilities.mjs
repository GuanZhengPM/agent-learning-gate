export const HOST_CAPABILITIES = Object.freeze({
  "claude-code": {
    host: "claude-code",
    enforcement: "native-write-prompt",
    pre_write_block: true,
    native_write_ask: true,
    caller_prompt_approval: false,
    supported_operations: ["check", "review", "verify", "stage:Write", "stage:Edit"],
    limitations: ["shell-and-external-process-writes-not-intercepted", "headless-ask-not-interactive"],
  },
  codex: {
    host: "codex",
    enforcement: "deny-only-proposal-gate",
    pre_write_block: true,
    native_write_ask: false,
    caller_prompt_approval: false,
    supported_operations: ["check", "review", "verify"],
    limitations: ["no-trusted-approval-channel", "plugin-hooks-require-trust"],
  },
  cursor: {
    host: "cursor",
    enforcement: "deny-only-proposal-gate",
    pre_write_block: true,
    native_write_ask: false,
    caller_prompt_approval: false,
    supported_operations: ["check", "review", "verify"],
    limitations: ["no-trusted-approval-channel", "tab-has-no-pre-edit-hook", "native-memories-not-covered", "user-plugins-not-in-cloud"],
  },
  pi: {
    host: "pi",
    enforcement: "native-extension-prompt",
    pre_write_block: true,
    native_write_ask: true,
    caller_prompt_approval: false,
    supported_operations: ["check", "review", "verify", "stage:write", "stage:single-edit"],
    limitations: ["print-and-json-modes-deny", "later-extensions-share-process-trust"],
  },
  generic: {
    host: "generic",
    enforcement: "advisory-cli",
    pre_write_block: false,
    native_write_ask: false,
    caller_prompt_approval: false,
    supported_operations: ["check", "review", "verify", "benchmark"],
    limitations: ["no-host-hook"],
  },
});

export function hostCapability(host) {
  return HOST_CAPABILITIES[host] || null;
}
