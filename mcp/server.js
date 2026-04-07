import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from "fs";
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
const MESSAGE_BUDGET = parseInt(process.env.POKEGENTS_MESSAGE_BUDGET || process.env.CCD_MESSAGE_BUDGET || "15");
const API_TIMEOUT = 2000; // 2s timeout before falling back to files

// ── Dashboard API with timeout ──────────────────────────────────────────

let lastApiSuccess = 0;
const API_RETRY_INTERVAL = 30000; // 30s before retrying API after failure

async function apiCall(path, options = {}) {
  // If API failed recently, skip and go straight to fallback
  if (lastApiSuccess < 0 && Date.now() + lastApiSuccess < API_RETRY_INTERVAL) {
    throw new Error("API offline (backoff)");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT);
  try {
    const res = await fetch(`${DASHBOARD_URL}${path}`, {
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      ...options,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    lastApiSuccess = Date.now();
    return res.json();
  } catch (err) {
    clearTimeout(timer);
    lastApiSuccess = -Date.now(); // negative = last failure time
    throw err;
  }
}

// ── Caching ────────────────────────────────────────────────────────────

let agentCache = null;
let agentCacheTime = 0;
const AGENT_CACHE_TTL = 3000; // 3s TTL

async function getCachedAgents() {
  if (agentCache && Date.now() - agentCacheTime < AGENT_CACHE_TTL) {
    return agentCache;
  }
  let agents;
  try {
    agents = await apiCall("/api/sessions");
  } catch {
    agents = fileListAgents();
  }
  agentCache = agents;
  agentCacheTime = Date.now();
  return agents;
}

// Invalidate cache after sends (new agent state possible)
function invalidateAgentCache() {
  agentCache = null;
  agentCacheTime = 0;
}

// Cache own CCD session ID (stable for lifetime of MCP process).
// We only cache the ID, not the full agent object, since display_name can change.
let selfCCDSessionId = null;

function getSelfId() {
  if (selfCCDSessionId) return selfCCDSessionId;
  const sessionIdEnv = getMySessionId();
  return sessionIdEnv || null;
}

function resolveSelf(agents) {
  const hint = getSelfId();
  if (!hint) return null;
  const me = resolveAgent(agents, hint.slice(0, 8));
  if (me) {
    selfCCDSessionId = me.ccd_session_id || me.session_id;
  }
  return me;
}

// ── File-based fallback operations ──────────────────────────────────────

function fileListAgents() {
  const agents = [];
  const runningDir = join(POKEGENTS_DATA, "running");
  const statusDir = join(POKEGENTS_DATA, "status");
  try {
    for (const file of readdirSync(runningDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const rf = JSON.parse(readFileSync(join(runningDir, file), "utf8"));
        // Read status file for state
        let state = "unknown";
        let detail = "";
        let userPrompt = "";
        const sid = rf.session_id || "";
        try {
          const sf = JSON.parse(readFileSync(join(statusDir, `${sid}.json`), "utf8"));
          state = sf.state || "unknown";
          detail = sf.detail || "";
          userPrompt = sf.user_prompt || "";
        } catch {}
        agents.push({
          profile_name: rf.profile || "",
          session_id: sid,
          ccd_session_id: rf.ccd_session_id || sid,
          display_name: rf.display_name || rf.profile || "",
          state,
          detail,
          user_prompt: userPrompt,
          tty: rf.tty || "",
        });
      } catch {}
    }
  } catch {}
  return agents;
}

function fileReadMessages(sessionId) {
  const mailbox = join(POKEGENTS_DATA, "messages", sessionId);
  const messages = [];
  try {
    for (const file of readdirSync(mailbox)) {
      if (!file.endsWith(".json") || file.startsWith("_")) continue;
      try {
        const msg = JSON.parse(readFileSync(join(mailbox, file), "utf8"));
        msg._file = file;
        messages.push(msg);
      } catch {}
    }
  } catch {}
  messages.sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
  return messages;
}

function fileConsumeMessages(sessionId) {
  const mailbox = join(POKEGENTS_DATA, "messages", sessionId);
  const messages = fileReadMessages(sessionId);
  for (const msg of messages) {
    try { unlinkSync(join(mailbox, msg._file)); } catch {}
    delete msg._file;
  }
  return messages;
}

function fileSendMessage(fromId, fromName, toId, toName, content) {
  const mailbox = join(POKEGENTS_DATA, "messages", toId);
  mkdirSync(mailbox, { recursive: true });
  const id = String(Date.now() * 1000000 + Math.floor(Math.random() * 1000000));
  const msg = {
    id,
    from: fromId,
    from_name: fromName,
    to: toId,
    to_name: toName,
    content,
    timestamp: new Date().toISOString(),
    delivered: false,
  };
  writeFileSync(join(mailbox, `${id}.json`), JSON.stringify(msg));
  return msg;
}

function fileResolveAgent(agents, idPrefix) {
  if (!idPrefix) return null;
  return agents.find(
    (a) =>
      a.session_id === idPrefix ||
      a.session_id.startsWith(idPrefix) ||
      (a.ccd_session_id && a.ccd_session_id === idPrefix) ||
      (a.ccd_session_id && a.ccd_session_id.startsWith(idPrefix))
  ) || null;
}

// ── Budget tracking ─────────────────────────────────────────────────────

function getBudgetFile(sessionId) {
  return join(POKEGENTS_DATA, "messages", sessionId, "_msg_budget");
}

function getMessageCount(sessionId) {
  try {
    return parseInt(readFileSync(getBudgetFile(sessionId), "utf8").trim()) || 0;
  } catch { return 0; }
}

function incrementMessageCount(sessionId) {
  const count = getMessageCount(sessionId) + 1;
  const dir = join(POKEGENTS_DATA, "messages", sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(getBudgetFile(sessionId), String(count));
  return count;
}

// ── Agent resolution (shared by API and file paths) ─────────────────────

function resolveAgent(agents, idPrefix) {
  const match = fileResolveAgent(agents, idPrefix);
  if (match) return match;

  // Fallback: match by claude_pid from running files
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

// ── Helper: get my session ID ───────────────────────────────────────────

function getMySessionId() {
  return process.env.POKEGENTS_SESSION_ID || process.env.CCD_SESSION_ID || "";
}

// ── MCP Server ──────────────────────────────────────────────────────────

const server = new McpServer({
  name: "pokegents-messaging",
  version: "0.3.0",
});

// List active agents
server.tool(
  "list_agents",
  "List all active Claude Code agents and their status. Use this to find agent session IDs before sending messages.",
  {},
  async () => {
    const agents = await getCachedAgents();
    const lines = agents.map(
      (a) =>
        `${a.display_name || a.profile_name} [${(a.ccd_session_id || a.session_id).slice(0, 8)}] — ${a.state}${a.task_group ? ` (group: ${a.task_group})` : ""}${a.user_prompt ? `\n  Last task: ${a.user_prompt.slice(0, 100)}` : ""}`
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
      .describe("Optional: your session ID (auto-detected from environment if omitted)."),
    to: z
      .string()
      .describe("Recipient agent session ID (8-char prefix). Use list_agents to find IDs."),
    content: z
      .string()
      .describe("Message content. Be specific: include file paths, line numbers, and actionable feedback."),
  },
  async ({ from, to, content }) => {
    const sessionIdEnv = getMySessionId();
    const fromHint = from || sessionIdEnv.slice(0, 8);

    // Budget check (local, no network)
    const agents = await getCachedAgents();
    const fromAgent = resolveSelf(agents) || resolveAgent(agents, fromHint);
    const fromId = fromAgent ? (fromAgent.ccd_session_id || fromAgent.session_id) : (from || sessionIdEnv);

    const sent = getMessageCount(fromId);
    if (sent >= MESSAGE_BUDGET) {
      return {
        content: [{
          type: "text",
          text: `Message budget reached (${MESSAGE_BUDGET}/${MESSAGE_BUDGET}). Stop sending messages and summarize your findings to the user. Wait for further instructions.`,
        }],
      };
    }

    // Fast path: combined resolve+send in one API call
    let toName, toId;
    let apiSent = false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), API_TIMEOUT);
      const res = await fetch(`${DASHBOARD_URL}/api/messages/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ from_hint: fromHint, to_hint: to, content }),
      });
      clearTimeout(timer);

      if (res.status === 404) {
        // Server resolved the ID but no agent matched — real "not found", don't fallback
        return {
          content: [{
            type: "text",
            text: `No agent found matching "${to}". Use list_agents to see available agents.`,
          }],
        };
      }
      if (!res.ok) throw new Error(`API error: ${res.status}`);

      const result = await res.json();
      toName = result.to_name;
      toId = result.to_id;
      lastApiSuccess = Date.now();
      invalidateAgentCache();
      apiSent = true;
    } catch (apiErr) {
      // Connection/timeout error — fallback to local resolve + file send
      if (!apiSent) {
        lastApiSuccess = -Date.now();
        const toAgent = resolveAgent(agents, to);
        if (!toAgent) {
          return {
            content: [{
              type: "text",
              text: `No agent found matching "${to}". Use list_agents to see available agents.`,
            }],
          };
        }
        toId = toAgent.ccd_session_id || toAgent.session_id;
        toName = toAgent.display_name || toAgent.profile_name;
        const fromName = fromAgent ? (fromAgent.display_name || fromAgent.profile_name) : fromId;
        fileSendMessage(fromId, fromName, toId, toName, content);
      }
    }

    const newCount = incrementMessageCount(fromId);
    const remaining = MESSAGE_BUDGET - newCount;

    return {
      content: [{
        type: "text",
        text: `Message sent to ${toName} (${toId.slice(0, 8)}).${remaining > 0 ? ` ${remaining} messages remaining in budget.` : " Budget reached — wait for user input before sending more."}`,
      }],
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
      .describe("Optional: your session ID. Usually auto-detected from environment."),
  },
  async ({ my_session_id }) => {
    const sessionIdEnv = getMySessionId();

    // Resolve own ID (cached after first call)
    const agents = await getCachedAgents();
    const me = resolveSelf(agents) || resolveAgent(agents, my_session_id || sessionIdEnv.slice(0, 8));
    const sessionId = me ? (me.ccd_session_id || me.session_id) : (my_session_id || sessionIdEnv);

    // Consume messages (API or file fallback) — single round-trip
    let messages;
    try {
      messages = await apiCall(`/api/messages/consume/${sessionId}`, { method: "POST" });
    } catch {
      messages = fileConsumeMessages(sessionId);
    }

    if (!messages || messages.length === 0) {
      return {
        content: [{ type: "text", text: "No new messages in your inbox." }],
      };
    }

    const formatted = messages
      .map((m) => `[From ${m.from_name} (${m.from.slice(0, 8)})]\n${m.content}`)
      .join("\n\n---\n\n");

    return {
      content: [{
        type: "text",
        text: `${messages.length} new message(s):\n\n${formatted}`,
      }],
    };
  }
);

// Spawn a new agent
server.tool(
  "spawn_agent",
  "Spawn a new agent in a new iTerm2 tab. Use role@project syntax (e.g. 'implementer@platform') or just a profile name. The dashboard must be running. Use this when you need another agent to help with a task. Optionally name it for easier messaging.",
  {
    profile: z
      .string()
      .describe("Profile to launch. Use role@project syntax (e.g. 'implementer@platform', 'debugger@pipeline') or a legacy profile name."),
    name: z
      .string()
      .optional()
      .describe("Display name for the new agent (e.g. 'QA Pipeline Impl'). Makes it easier to find in list_agents. If omitted, uses the default profile name."),
    message: z
      .string()
      .optional()
      .describe("Optional initial message to send to the new agent once it's active. Include context about what you need it to do."),
    task_group: z
      .string()
      .optional()
      .describe("Optional task group to assign (e.g. 'proxy', 'auth-migration'). Groups agents by workstream in the dashboard."),
  },
  async ({ profile, name, message, task_group }) => {
    // Snapshot agents before launch so we can detect the new one
    let agentsBefore;
    try {
      agentsBefore = await apiCall("/api/sessions");
    } catch {
      agentsBefore = fileListAgents();
    }
    const beforeIds = new Set(agentsBefore.map(a => a.session_id));

    try {
      const res = await fetch(`${DASHBOARD_URL}/api/launch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile }),
      });
      if (!res.ok) {
        const err = await res.text();
        return {
          content: [{
            type: "text",
            text: `Failed to spawn ${profile}: ${err}. Make sure the dashboard is running (pokegent dashboard start).`,
          }],
        };
      }

      // If name or message requested, wait for the new agent to appear
      let newAgent = null;
      if (name || message) {
        for (let attempt = 0; attempt < 10; attempt++) {
          await new Promise(r => setTimeout(r, 2000));
          let agentsNow;
          try {
            agentsNow = await apiCall("/api/sessions");
          } catch {
            agentsNow = fileListAgents();
          }
          newAgent = agentsNow.find(a => !beforeIds.has(a.session_id));
          if (newAgent) break;
        }
      }

      let result = `Spawned ${profile} in a new iTerm2 tab.`;

      if (newAgent && name) {
        const sid = newAgent.ccd_session_id || newAgent.session_id;
        try {
          await fetch(`${DASHBOARD_URL}/api/sessions/${sid}/rename`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
          });
          result = `Spawned ${profile} as "${name}" [${sid.slice(0, 8)}].`;
        } catch {
          result = `Spawned ${profile} [${sid.slice(0, 8)}] (rename to "${name}" failed).`;
        }
      } else if (newAgent) {
        const sid = newAgent.ccd_session_id || newAgent.session_id;
        result = `Spawned ${profile} [${sid.slice(0, 8)}].`;
      }

      if (newAgent && task_group) {
        const sid = newAgent.ccd_session_id || newAgent.session_id;
        try {
          await fetch(`${DASHBOARD_URL}/api/sessions/${sid}/task-group`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ task_group }),
          });
          result += ` Group: ${task_group}.`;
        } catch {
          result += ` (task group assignment failed)`;
        }
      }

      if (newAgent && message) {
        const toId = newAgent.ccd_session_id || newAgent.session_id;
        const toName = name || newAgent.display_name || newAgent.profile_name;
        const sessionIdEnv = getMySessionId();
        const agents = await getCachedAgents();
        const me = resolveSelf(agents);
        const fromId = me ? (me.ccd_session_id || me.session_id) : sessionIdEnv;
        const fromName = me ? (me.display_name || me.profile_name) : fromId;
        try {
          await apiCall("/api/messages", {
            method: "POST",
            body: JSON.stringify({ from: fromId, to: toId, content: message }),
          });
          result += ` Message sent.`;
        } catch {
          fileSendMessage(fromId, fromName, toId, toName, message);
          result += ` Message queued.`;
        }
      } else if (message && !newAgent) {
        result += ` Could not detect new agent to send message — use list_agents and send_message manually.`;
      }

      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `Failed to spawn ${profile}: ${err.message}. Is the dashboard running? Start it with: pokegent dashboard start`,
        }],
      };
    }
  }
);

// Set task group on an agent
server.tool(
  "set_task_group",
  "Assign an agent (yourself or another) to a task group. Groups are organizational labels that cluster agents by workstream in the dashboard (e.g. 'proxy', 'auth-migration'). Pass an empty string to remove from a group.",
  {
    session_id: z
      .string()
      .describe("Target agent session ID (8-char prefix). Use list_agents to find IDs, or 'self' for yourself."),
    task_group: z
      .string()
      .describe("Task group name (e.g. 'proxy', 'auth-migration'). Empty string to ungroup."),
  },
  async ({ session_id, task_group }) => {
    // Resolve "self"
    let targetId = session_id;
    if (targetId === "self") {
      const agents = await getCachedAgents();
      const me = resolveSelf(agents);
      if (me) {
        targetId = me.ccd_session_id || me.session_id;
      } else {
        targetId = getMySessionId();
      }
    } else {
      // Resolve prefix
      const agents = await getCachedAgents();
      const match = resolveAgent(agents, targetId);
      if (match) {
        targetId = match.ccd_session_id || match.session_id;
      }
    }

    try {
      const res = await fetch(`${DASHBOARD_URL}/api/sessions/${targetId}/task-group`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_group }),
      });
      if (!res.ok) {
        const err = await res.text();
        return { content: [{ type: "text", text: `Failed to set task group: ${err}` }] };
      }
      invalidateAgentCache();
      const label = task_group || "(none)";
      return { content: [{ type: "text", text: `Task group set to ${label} for ${targetId.slice(0, 8)}.` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to set task group: ${err.message}` }] };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
