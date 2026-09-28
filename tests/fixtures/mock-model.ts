// Deterministic OpenAI-compatible provider for real CLI integration checks.
// No credentials or external model requests are needed.
export function startMockModel() {
  const requests: any[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json() as any
      requests.push(body)
      const messages = body.messages ?? []
      const joined = JSON.stringify(messages)
      let content = "COMPAT_OK"
      let calls: any[] | undefined
      if (joined.includes("You are the memory consolidation module")) {
        content = JSON.stringify({
          new: [{ text: "The user prefers teal terminal themes.", category: "preferences", scope: "global", confidence: 0.95 }],
          update: [], delete: [], conflicts: [], summary: "The user prefers teal terminal themes.",
        })
      } else if (joined.includes("You are a deduplication checker")) {
        content = '{"duplicates":[]}'
      } else {
        const lastUser = messages.findLastIndex((message: any) => message.role === "user")
        const prompt = JSON.stringify(messages[lastUser] ?? "")
        const done = messages.slice(lastUser + 1).some((message: any) => message.role === "tool")
        const name = prompt.includes("WRITE_TEST") ? "memory_write" : prompt.includes("READ_TEST") ? "memory_read" : undefined
        if (!done && name) {
          const args = name === "memory_write"
            ? { fact: "The user drinks coffee in the morning.", category: "preferences", scope: "global" }
            : { query: "coffee morning" }
          // V2 exposes plugin tools through Code Mode by default. Use only the
          // advertised path; V1 exposes the same tools directly.
          const direct = body.tools?.some((tool: any) => tool.function?.name === name)
          if (!direct && !joined.includes(`tools.${name}(`)) throw new Error(`${name} missing from model tool catalog`)
          calls = [{ index: 0, id: `call_${name}`, type: "function", function: {
            name: direct ? name : "execute",
            arguments: JSON.stringify(direct ? args : { code: `return await tools.${name}(${JSON.stringify(args)})` }),
          } }]
        }
      }
      const finish = calls ? "tool_calls" : "stop"
      const base = { id: "compat", created: Math.floor(Date.now() / 1000), model: "test" }
      if (!body.stream) return Response.json({
        ...base, object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: calls ? null : content, ...(calls ? { tool_calls: calls } : {}) }, finish_reason: finish }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      })
      const chunk = (delta: unknown, finish_reason: string | null = null) => ({
        ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }],
      })
      const chunks = [chunk({ role: "assistant" }), chunk(calls ? { tool_calls: calls } : { content }), chunk({}, finish)]
      return new Response(chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  return { server, requests }
}
