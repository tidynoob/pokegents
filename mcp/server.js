import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from "fs";
import { join } from "path";

const POKEGENTS_DATA = process.env.POKEGENTS_DATA || join(process.env.HOME, ".pokegents");

// Read port from config file, fall back to env var, then default
function getPort() {
  try {
    const cfg = JSON.parse(readFileSync(join(POKEGENTS_DATA, "config.json"), "utf8"));
    return cfg.port || 7834;
  } catch { return 7834; }
}
const DASHBOARD_URL = process.env.POKEGENTS_DASHBOARD_URL || `http://localhost:${getPort()}`;
const MESSAGE_BUDGET = parseInt(process.env.POKEGENTS_MESSAGE_BUDGET || "15");
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

// Cache own pokegent ID (stable for lifetime of MCP process).
// We only cache the ID, not the full agent object, since display_name can change.
let selfPokegentId = null;

function getSelfId() {
  if (selfPokegentId) return selfPokegentId;
  const sessionIdEnv = getMySessionId();
  if (sessionIdEnv) return sessionIdEnv;
  return inferSelfIdFromProcessTree();
}

function resolveSelf(agents) {
  const hint = getSelfId();
  if (!hint) return null;
  const me = resolveAgent(agents, hint.slice(0, 8));
  if (me) {
    selfPokegentId = me.pokegent_id || me.session_id;
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
          display_name: rf.display_name || rf.profile || "",
          state,
          detail,
          user_prompt: userPrompt,
          tty: rf.tty || "",
        });
      } catch {}
    }
  } catch {}

  // Also include ephemeral agents from ~/.pokegents/ephemeral/
  const ephemeralDir = join(POKEGENTS_DATA, "ephemeral");
  try {
    for (const file of readdirSync(ephemeralDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const ef = JSON.parse(readFileSync(join(ephemeralDir, file), "utf8"));
        agents.push({
          profile_name: ef.agent_type || "subagent",
          session_id: ef.agent_id || file.replace(".json", ""),
          display_name: ef.description || ef.agent_type || "subagent",
          state: ef.state === "running" ? "busy" : ef.state === "completed" ? "done" : (ef.state || "busy"),
          detail: ef.agent_type ? `${ef.agent_type} subagent` : "",
          user_prompt: "",
          tty: "",
          ephemeral: true,
          parent_session_id: ef.parent_session_id || "",
          subagent_type: ef.agent_type || "",
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
      (a.pokegent_id && a.pokegent_id === idPrefix) ||
      (a.pokegent_id && a.pokegent_id.startsWith(idPrefix))
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
  return process.env.POKEGENT_ID || process.env.POKEGENTS_SESSION_ID || "";
}

function inferSelfIdFromProcessTree() {
  try {
    const ps = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
      timeout: 1000,
    });
    const parents = new Map();
    for (const line of ps.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+/);
      if (match) parents.set(match[1], match[2]);
    }

    const ancestors = new Set();
    let pid = String(process.pid);
    for (let i = 0; pid && pid !== "0" && i < 32; i++) {
      ancestors.add(pid);
      pid = parents.get(pid);
    }

    const runningDir = join(POKEGENTS_DATA, "running");
    for (const file of readdirSync(runningDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const rf = JSON.parse(readFileSync(join(runningDir, file), "utf8"));
        const sessionPid = rf.pid ? String(rf.pid) : "";
        const claudePid = rf.claude_pid ? String(rf.claude_pid) : "";
        if ((sessionPid && ancestors.has(sessionPid)) || (claudePid && ancestors.has(claudePid))) {
          return rf.pokegent_id || rf.session_id || "";
        }
      } catch {}
    }
  } catch {}
  return "";
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
    const lines = agents.map((a) => {
      const id = (a.pokegent_id || a.session_id).slice(0, 8);
      const group = a.task_group ? ` (group: ${a.task_group})` : "";
      const task = a.user_prompt ? `\n  Last task: ${a.user_prompt.slice(0, 100)}` : "";

      if (a.ephemeral) {
        const parentId = a.parent_session_id ? a.parent_session_id.slice(0, 8) : "?";
        return `  ↳ ${a.display_name || a.subagent_type || "subagent"} [${id}] — ${a.state} (${a.subagent_type || "agent"}, parent: ${parentId})`;
      }

      return `${a.display_name || a.profile_name} [${id}] — ${a.state}${group}${task}`;
    });
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
    const selfId = getSelfId() || "";
    const fromHint = from || selfId.slice(0, 8);

    // Budget check (local, no network)
    const agents = await getCachedAgents();
    const fromAgent = resolveSelf(agents) || resolveAgent(agents, fromHint);
    const fromId = fromAgent ? (fromAgent.pokegent_id || fromAgent.session_id) : (from || selfId);

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
        toId = toAgent.pokegent_id || toAgent.session_id;
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
    const selfId = getSelfId() || "";

    // Resolve own ID (cached after first call)
    const agents = await getCachedAgents();
    const me = resolveSelf(agents) || resolveAgent(agents, my_session_id || selfId.slice(0, 8));
    const sessionId = me ? (me.pokegent_id || me.session_id) : (my_session_id || selfId);

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
  "Spawn a new dashboard agent card. By default it launches through the same chat backend/model as the caller (for example a Codex-backed caller spawns a Codex-backed card) instead of opening a new iTerm2 tab. Use role@project syntax (e.g. 'implementer@platform') or just a profile name. The dashboard must be running. Optionally name it, assign a task group, and send an initial message.",
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
    agent_backend: z
      .string()
      .optional()
      .describe("Optional backend override. Defaults to the caller's agent_backend, e.g. codex/claude."),
    model: z
      .string()
      .optional()
      .describe("Optional model override. Defaults to the caller's model when available."),
    effort: z
      .string()
      .optional()
      .describe("Optional reasoning effort override. Defaults to the caller's effort when available."),
  },
  async ({ profile, name, message, task_group, agent_backend, model, effort }) => {
    const agentsBefore = await getCachedAgents().catch(() => fileListAgents());
    const beforeIds = new Set(agentsBefore.map(a => a.pokegent_id || a.session_id).filter(Boolean));
    const selfId = getSelfId() || "";
    const caller = resolveSelf(agentsBefore);

    // MCP-spawned agents should appear as dashboard cards, not terminal tabs.
    // If the caller is ACP/chat-backed, inherit its configured backend so a
    // Codex-backed caller spawns Codex-backed workers. If the caller is legacy
    // iTerm2, leave backend empty so the dashboard default chat backend applies.
    const inheritedBackend = agent_backend || caller?.agent_backend || undefined;
    const inheritedModel = model || caller?.model || undefined;
    const inheritedEffort = effort || caller?.effort || undefined;
    const body = {
      profile,
      name: name || undefined,
      task_group: task_group || undefined,
      interface: "chat",
      agent_backend: inheritedBackend,
      model: inheritedModel,
      effort: inheritedEffort,
    };

    try {
      const launch = await apiCall("/api/pokegents/launch", {
        method: "POST",
        body: JSON.stringify(body),
      });
      invalidateAgentCache();

      const launchedId = launch?.pokegent_id || "";
      let newAgent = launchedId ? { pokegent_id: launchedId, profile_name: profile, display_name: name || profile } : null;

      // Confirm the card exists so list_agents/message names line up with the dashboard state.
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise(r => setTimeout(r, 500));
        let agentsNow;
        try {
          agentsNow = await apiCall("/api/sessions");
        } catch {
          agentsNow = fileListAgents();
        }
        const byLaunchId = launchedId ? agentsNow.find(a => (a.pokegent_id || a.session_id) === launchedId) : null;
        const byNewId = agentsNow.find(a => {
          const id = a.pokegent_id || a.session_id;
          return id && !beforeIds.has(id);
        });
        newAgent = byLaunchId || byNewId || newAgent;
        if (byLaunchId || byNewId) break;
      }

      const sid = newAgent ? (newAgent.pokegent_id || newAgent.session_id || launchedId) : launchedId;
      let result = sid
        ? `Spawned ${profile} as dashboard card [${sid.slice(0, 8)}] using ${inheritedBackend || "default chat backend"}.`
        : `Spawned ${profile} as dashboard card using ${inheritedBackend || "default chat backend"}.`;
      if (name) result = result.replace(`Spawned ${profile}`, `Spawned ${profile} as "${name}"`);
      if (task_group) result += ` Group: ${task_group}.`;

      if (sid && message) {
        const toName = name || newAgent?.display_name || newAgent?.profile_name || profile;
        const fromId = caller ? (caller.pokegent_id || caller.session_id) : selfId;
        const fromName = caller ? (caller.display_name || caller.profile_name) : fromId;
        try {
          await apiCall("/api/messages", {
            method: "POST",
            body: JSON.stringify({ from: fromId, to: sid, content: message }),
          });
          result += ` Message sent.`;
        } catch {
          fileSendMessage(fromId, fromName, sid, toName, message);
          result += ` Message queued.`;
        }
      } else if (message && !sid) {
        result += ` Could not resolve new agent ID to send message — use list_agents and send_message manually.`;
      }

      invalidateAgentCache();
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
        targetId = me.pokegent_id || me.session_id;
      } else {
        targetId = getMySessionId();
      }
    } else {
      // Resolve prefix
      const agents = await getCachedAgents();
      const match = resolveAgent(agents, targetId);
      if (match) {
        targetId = match.pokegent_id || match.session_id;
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

// Release (shutdown all agents in) a task group
server.tool(
  "release_task_group",
  "Shut down all agents in a task group. Use this when the group's work is done and you want to free up resources. Sends /exit to each agent and closes their terminals.",
  {
    task_group: z
      .string()
      .describe("Name of the task group to release (e.g. 'proxy', 'auth-migration')."),
  },
  async ({ task_group }) => {
    try {
      const res = await fetch(
        `${DASHBOARD_URL}/api/task-groups/${encodeURIComponent(task_group)}/release`,
        { method: "POST" }
      );
      if (!res.ok) {
        const err = await res.text();
        return { content: [{ type: "text", text: `Failed to release group: ${err}` }] };
      }
      const data = await res.json();
      invalidateAgentCache();
      return {
        content: [
          {
            type: "text",
            text: `Released task group "${task_group}": ${data.count} agent(s) shutting down.`,
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to release group: ${err.message}` }] };
    }
  }
);

// List sessions that belonged to a task group (including inactive ones from the search index)
server.tool(
  "list_group_sessions",
  "List all sessions (active and inactive) that belonged to a task group. Use this to find former teammates to resume. Returns session IDs, roles, titles, and whether each is currently active.",
  {
    task_group: z
      .string()
      .describe("Name of the task group to look up."),
  },
  async ({ task_group }) => {
    try {
      const res = await fetch(
        `${DASHBOARD_URL}/api/task-groups/${encodeURIComponent(task_group)}/sessions`
      );
      if (!res.ok) {
        const err = await res.text();
        return { content: [{ type: "text", text: `Failed to list group sessions: ${err}` }] };
      }
      const sessions = await res.json();
      if (!sessions || sessions.length === 0) {
        return { content: [{ type: "text", text: `No sessions found for group "${task_group}".` }] };
      }
      const lines = sessions.map((s) => {
        const status = s.active ? "ACTIVE" : "inactive";
        const role = s.role ? ` (${s.role})` : "";
        const title = s.custom_title || s.session_id.slice(0, 8);
        return `[${status}] ${s.session_id.slice(0, 8)} — ${title}${role}`;
      });
      return {
        content: [{
          type: "text",
          text: `Sessions in group "${task_group}":\n${lines.join("\n")}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to list group sessions: ${err.message}` }] };
    }
  }
);

// Resume a previous session from the PC Box (search index)
server.tool(
  "resume_session",
  "Resume a previous Claude Code session by ID. Opens a new iTerm2 tab with the full conversation history restored via pokegent. Optionally assign it to a task group and send an initial message. Use list_group_sessions to find session IDs.",
  {
    session_id: z
      .string()
      .describe("Session ID to resume (8-char prefix or full UUID). Use list_group_sessions to find IDs."),
    task_group: z
      .string()
      .optional()
      .describe("Task group to assign the resumed session to."),
    message: z
      .string()
      .optional()
      .describe("Optional message to send once the session is active. Include context about what you need."),
  },
  async ({ session_id, task_group, message }) => {
    // Snapshot agents before resume so we can detect the new one
    let agentsBefore;
    try {
      agentsBefore = await apiCall("/api/sessions");
    } catch {
      agentsBefore = fileListAgents();
    }
    const beforeIds = new Set(agentsBefore.map((a) => a.session_id));

    // Resolve prefix to full session ID from search index
    let fullSessionId = session_id;
    if (session_id.length < 36) {
      try {
        const searchRes = await fetch(
          `${DASHBOARD_URL}/api/search/recent?limit=200`
        );
        if (searchRes.ok) {
          const results = await searchRes.json();
          const match = results.find((r) => r.session_id.startsWith(session_id));
          if (match) fullSessionId = match.session_id;
        }
      } catch {
        // Fall through with prefix — the resume endpoint will handle it
      }
    }

    try {
      const res = await fetch(
        `${DASHBOARD_URL}/api/sessions/${fullSessionId}/resume`,
        { method: "POST" }
      );
      if (!res.ok) {
        const err = await res.text();
        return {
          content: [{
            type: "text",
            text: `Failed to resume ${session_id}: ${err}`,
          }],
        };
      }

      // Wait for the resumed agent to appear
      let newAgent = null;
      for (let attempt = 0; attempt < 15; attempt++) {
        await new Promise((r) => setTimeout(r, 2000));
        let agentsNow;
        try {
          agentsNow = await apiCall("/api/sessions");
        } catch {
          agentsNow = fileListAgents();
        }
        newAgent = agentsNow.find((a) => !beforeIds.has(a.session_id));
        if (newAgent) break;
      }

      let result = `Resumed session ${fullSessionId.slice(0, 8)}.`;

      if (newAgent && task_group) {
        const sid = newAgent.pokegent_id || newAgent.session_id;
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
        const toId = newAgent.pokegent_id || newAgent.session_id;
        const toName = newAgent.display_name || newAgent.profile_name;
        const sessionIdEnv = getMySessionId();
        const agents = await getCachedAgents();
        const me = resolveSelf(agents);
        const fromId = me ? (me.pokegent_id || me.session_id) : sessionIdEnv;
        try {
          await apiCall("/api/messages", {
            method: "POST",
            body: JSON.stringify({ from: fromId, to: toId, content: message }),
          });
          result += ` Message sent.`;
        } catch {
          const fromName = me ? (me.display_name || me.profile_name) : fromId;
          fileSendMessage(fromId, fromName, toId, toName, message);
          result += ` Message queued.`;
        }
      } else if (message && !newAgent) {
        result += ` Could not detect resumed agent — use list_agents and send_message manually.`;
      }

      if (newAgent) {
        const sid = newAgent.pokegent_id || newAgent.session_id;
        result += ` New session ID: ${sid.slice(0, 8)}.`;
      }

      invalidateAgentCache();
      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `Failed to resume ${session_id}: ${err.message}`,
        }],
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
