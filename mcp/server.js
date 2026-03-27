import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";

// Support both new (POKEGENTS_*) and legacy (CCD_*) env vars during migration
const POKEGENTS_DATA = process.env.POKEGENTS_DATA || process.env.CCD_DATA || join(process.env.HOME, ".pokegents");

// Read port from config file, fall back to env var, then default
function getPort() {
  try {
    const cfg = JSON.parse(readFileSync(join(POKEGENTS_DATA, "config.json"), "utf8"));
    return cfg.port || 7834;
  } catch { return 7834; }
}
const DASHBOARD_URL = process.env.POKEGENTS_DASHBOARD_URL || process.env.CCD_DASHBOARD_URL || `http://localhost:${getPort()}`;
const MESSAGE_BUDGET = parseInt(process.env.POKEGENTS_MESSAGE_BUDGET || process.env.CCD_MESSAGE_BUDGET || "5");

function getBudgetFile(sessionId) {
  return join(POKEGENTS_DATA, "messages", sessionId, "_msg_budget");
}

function getMessageCount(sessionId) {
  try {
    return parseInt(readFileSync(getBudgetFile(sessionId), "utf8").trim()) || 0;
  } catch {
    return 0;
  }
}

function incrementMessageCount(sessionId) {
  const count = getMessageCount(sessionId) + 1;
  const dir = join(POKEGENTS_DATA, "messages", sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(getBudgetFile(sessionId), String(count));
  return count;
}

// Resolve an ID prefix against session_id, ccd_session_id, and fuzzy
// matching via running files (handles forked sessions with stale env vars).
function resolveAgent(agents, idPrefix) {
  // Direct match on session_id or ccd_session_id
  const direct = agents.find(
    (a) =>
      a.session_id === idPrefix ||
      a.session_id.startsWith(idPrefix) ||
      (a.ccd_session_id && a.ccd_session_id === idPrefix) ||
      (a.ccd_session_id && a.ccd_session_id.startsWith(idPrefix))
  );
  if (direct) return direct;

  // Fallback: match by claude_pid — the MCP server's parent is the
  // Claude process, which is stored as claude_pid in running files.
  try {
    const ppid = process.ppid;
    const runningDir = join(POKEGENTS_DATA, "running");
    for (const file of readdirSync(runningDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const rf = JSON.parse(readFileSync(join(runningDir, file), "utf8"));
        if (rf.claude_pid === ppid) {
          return agents.find((a) => a.session_id === rf.session_id) || null;
        }
      } catch {}
    }
  } catch {}

  return null;
}

async function apiCall(path, options = {}) {
  const res = await fetch(`${DASHBOARD_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) throw new Error(`API error: ${res.status} ${await res.text()}`);
  return res.json();
}

const server = new McpServer({
  name: "pokegents-messaging",
  version: "0.2.0",
});

// List active agents
server.tool(
  "list_agents",
  "List all active Claude Code agents and their status. Use this to find agent session IDs before sending messages.",
  {},
  async () => {
    const agents = await apiCall("/api/sessions");
    const lines = agents.map(
      (a) =>
        `${a.display_name || a.profile_name} [${(a.ccd_session_id || a.session_id).slice(0, 8)}] — ${a.state}${a.user_prompt ? `\n  Last task: ${a.user_prompt.slice(0, 100)}` : ""}`
    );
    return {
      content: [
        {
          type: "text",
          text: lines.length
            ? `Active agents:\n\n${lines.join("\n\n")}`
            : "No agents currently active.",
        },
      ],
    };
  }
);

// Send a message to another agent
server.tool(
  "send_message",
  `Send a message to another agent. Messages are delivered automatically. You have a budget of ${MESSAGE_BUDGET} messages per user turn — the budget resets each time the user sends a new prompt. After reaching the budget, stop and wait for user input. Use list_agents first to find the recipient's session ID prefix.`,
  {
    from: z
      .string()
      .optional()
      .describe(
        "Optional: your session ID (auto-detected from environment if omitted)."
      ),
    to: z
      .string()
      .describe(
        "Recipient agent session ID (8-char prefix). Use list_agents to find IDs."
      ),
    content: z
      .string()
      .describe(
        "Message content. Be specific: include file paths, line numbers, and actionable feedback."
      ),
  },
  async ({ from, to, content }) => {
    // Auto-detect sender from environment (support both new and legacy env vars)
    const sessionIdEnv = process.env.POKEGENTS_SESSION_ID || process.env.CCD_SESSION_ID || "";
    const fromHint = from || sessionIdEnv.slice(0, 8);

    const agents = await apiCall("/api/sessions");
    const fromAgent = resolveAgent(agents, fromHint);
    const fromId = fromAgent ? (fromAgent.ccd_session_id || fromAgent.session_id) : (from || sessionIdEnv);

    const sent = getMessageCount(fromId);
    if (sent >= MESSAGE_BUDGET) {
      return {
        content: [
          {
            type: "text",
            text: `Message budget reached (${MESSAGE_BUDGET}/${MESSAGE_BUDGET}). Stop sending messages and summarize your findings to the user. Wait for further instructions.`,
          },
        ],
      };
    }

    const toAgent = resolveAgent(agents, to);
    if (!toAgent) {
      return {
        content: [
          {
            type: "text",
            text: `No agent found matching "${to}". Use list_agents to see available agents.`,
          },
        ],
      };
    }

    const msg = await apiCall("/api/messages", {
      method: "POST",
      body: JSON.stringify({
        from: fromId,
        to: toAgent.ccd_session_id || toAgent.session_id,
        content,
      }),
    });

    const newCount = incrementMessageCount(fromId);
    const remaining = MESSAGE_BUDGET - newCount;

    return {
      content: [
        {
          type: "text",
          text: `Message sent to ${toAgent.display_name || toAgent.profile_name} (${(toAgent.ccd_session_id || toAgent.session_id).slice(0, 8)}).${remaining > 0 ? ` ${remaining} messages remaining in budget.` : " Budget reached — wait for user input before sending more."}\n\nReminder: YOUR session ID is "${from}" — use this when calling check_messages.`,
        },
      ],
    };
  }
);

// Check for incoming messages
server.tool(
  "check_messages",
  "Check YOUR OWN inbox for messages from other agents. Your session ID is auto-detected — just call this tool without arguments, or pass your session ID if auto-detection fails.",
  {
    my_session_id: z
      .string()
      .optional()
      .describe(
        "Optional: your session ID. Usually auto-detected from environment."
      ),
  },
  async ({ my_session_id }) => {
    // Auto-detect session ID from environment (support both new and legacy env vars)
    const sessionIdEnv = process.env.POKEGENTS_SESSION_ID || process.env.CCD_SESSION_ID || "";
    const idHint = my_session_id || sessionIdEnv.slice(0, 8);

    const agents = await apiCall("/api/sessions");
    const me = resolveAgent(agents, idHint);
    const sessionId = me ? (me.ccd_session_id || me.session_id) : (my_session_id || sessionIdEnv);

    const messages = await apiCall(`/api/messages/consume/${sessionId}`, { method: "POST" });

    if (!messages || messages.length === 0) {
      return {
        content: [
          { type: "text", text: "No new messages in your inbox." },
        ],
      };
    }

    const formatted = messages
      .map(
        (m) =>
          `[From ${m.from_name} (${m.from.slice(0, 8)})]\n${m.content}`
      )
      .join("\n\n---\n\n");

    return {
      content: [
        {
          type: "text",
          text: `${messages.length} new message(s):\n\n${formatted}`,
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
