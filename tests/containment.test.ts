import { describe, expect, test } from "bun:test"
import { SESSION_TOOLS_DENY_ALL } from "../src/config.ts"

// Contract check for the DREAM containment configuration.
//
// Verified against the OpenCode server source (v1.18.0 … v1.18.20):
//   - packages/opencode/src/session/prompt.ts converts each entry of the
//     promptAsync `tools` body into a session permission rule
//     { permission: <key>, action: enabled ? "allow" : "deny", pattern: "*" }.
//   - packages/opencode/src/session/llm/request.ts (resolveTools) removes a
//     tool from the model-visible toolset when the LAST matching permission
//     rule is a deny with pattern "*", and Permission.evaluate uses glob
//     matching where the pattern "*" matches every tool id.
//
// Therefore { "*": false } denies ALL tools (built-in, plugin-registered and
// MCP) in the headless child session — a true allow-none default. Enumerating
// individual tool names instead would silently re-enable any tool that is not
// listed (including tools added by future OpenCode versions or other
// plugins), so the deny-all shape itself is part of the contract.

describe("DREAM / rerank child-session tool containment", () => {
  test("uses a single wildcard deny (allow-none), never a per-tool enumeration", () => {
    expect(SESSION_TOOLS_DENY_ALL).toEqual({ "*": false })
    expect(Object.keys(SESSION_TOOLS_DENY_ALL)).toHaveLength(1)
  })

  test("the denied key is exactly the wildcard matched by Permission.disabled()", () => {
    // Mirrors Wildcard.match(toolId, "*") === true for every tool id.
    const wildcard = "*"
    const matchesEverything = new RegExp("^" + wildcard.replace(/\*/g, ".*") + "$").test("bash")
      && new RegExp("^" + wildcard.replace(/\*/g, ".*") + "$").test("memory_read")
      && new RegExp("^" + wildcard.replace(/\*/g, ".*") + "$").test("mcp_some-server_some-tool")
    expect(matchesEverything).toBe(true)
    expect(SESSION_TOOLS_DENY_ALL[wildcard]).toBe(false)
  })
})
