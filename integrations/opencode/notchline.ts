import type { Plugin } from "@opencode-ai/plugin"

// Notchline: shows OpenCode sessions in the GNOME notch. Installed by
// `notchline install-hooks opencode`, which fills in the binary path below.
//
// Events go to `notchline hook opencode` in the same shape as Claude Code's hooks,
// so the daemon treats both agents alike. Everything is fire-and-forget except
// permission requests, which wait for an answer from the notch.
const NOTCHLINE = "__NOTCHLINE__"

// OpenCode tool and permission names are lowercase; the daemon uses Claude Code's names
const TOOL_NAMES: Record<string, string> = { bash: "Bash", todowrite: "TodoWrite", webfetch: "WebFetch" }
const toolName = (name: string) =>
  TOOL_NAMES[name.toLowerCase()] ?? name.charAt(0).toUpperCase() + name.slice(1)

export const NotchlinePlugin: Plugin = async ({ $, directory }) => {
  // Sessions currently busy, to send one "prompt" per turn
  const busy = new Set<string>()

  const run = async (event: Record<string, unknown>) => {
    const json = JSON.stringify({ cwd: directory, ...event })
    try {
      const result = await $`${NOTCHLINE} hook opencode < ${new Response(json)}`.quiet().nothrow()
      return String(result.stdout).trim()
    } catch {
      return ""
    }
  }

  // Keep events in order: each one waits for the previous to reach the daemon
  let queue: Promise<unknown> = Promise.resolve()
  const send = (event: Record<string, unknown>) => {
    const next = queue.then(() => run(event))
    queue = next.catch(() => "")
    return next
  }

  return {
    event: async ({ event }) => {
      switch (event.type) {
        case "session.status": {
          const { sessionID, status } = event.properties
          if (status.type === "busy" && !busy.has(sessionID)) {
            busy.add(sessionID)
            void send({ hook_event_name: "UserPromptSubmit", session_id: sessionID })
          }
          break
        }
        case "session.idle":
          busy.delete(event.properties.sessionID)
          void send({ hook_event_name: "Stop", session_id: event.properties.sessionID })
          break
        case "session.error":
          if (event.properties.sessionID) {
            busy.delete(event.properties.sessionID)
            void send({
              hook_event_name: "Stop",
              session_id: event.properties.sessionID,
              last_assistant_message: "Berhenti karena error",
            })
          }
          break
        case "session.deleted":
          void send({ hook_event_name: "SessionEnd", session_id: event.properties.info.id })
          break
        case "todo.updated":
          void send({
            hook_event_name: "PreToolUse",
            session_id: event.properties.sessionID,
            tool_name: "TodoWrite",
            tool_input: { todos: event.properties.todos },
          })
          break
      }
    },

    "tool.execute.before": async (input, output) => {
      void send({
        hook_event_name: "PreToolUse",
        session_id: input.sessionID,
        tool_name: toolName(input.tool),
        tool_input: output.args ?? {},
      })
    },

    // Wait for the notch; without an answer OpenCode asks in the terminal as usual
    "permission.ask": async (permission, output) => {
      const command =
        typeof permission.metadata?.command === "string"
          ? permission.metadata.command
          : Array.isArray(permission.pattern)
            ? permission.pattern.join(" ")
            : permission.pattern
      // After the events before it, but without holding up the ones after it
      await queue
      const reply = await run({
        hook_event_name: "PermissionRequest",
        session_id: permission.sessionID,
        tool_name: toolName(permission.type),
        tool_input: { command, description: permission.title },
      })
      try {
        const behavior = JSON.parse(reply)?.hookSpecificOutput?.decision?.behavior
        if (behavior === "allow" || behavior === "deny") output.status = behavior
      } catch {
        // No decision: leave it to the terminal
      }
    },
  }
}
