#!/usr/bin/env node
// apple-data-mcp daemon - MCP server exposing Apple data (Notes, Calendar,
// Reminders, iMessage, Mail, Contacts, Obsidian) to AI agents.
// HTTP transport on localhost (default :9230), bearer auth via APPLE_DATA_MCP_KEY.
// Send tools are gated behind APPLE_DATA_WRITES=1.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";

const exec = promisify(execFile);
const WRITES = process.env.APPLE_DATA_WRITES === "1";
const VAULT = process.env.OBSIDIAN_VAULT || path.join(homedir(), "Second Brain");
const CHAT_DB = path.join(homedir(), "Library/Messages/chat.db");

function esc(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function q(s) {
  return String(s).replace(/'/g, "''");
}

async function osa(script) {
  try {
    const { stdout } = await exec("/usr/bin/osascript", ["-e", script], { timeout: 30000 });
    return stdout.trim();
  } catch (e) {
    throw new Error(`AppleScript error: ${String(e.stderr || e.message).slice(0, 300)}`);
  }
}

async function sqlite(db, sql) {
  try {
    const { stdout } = await exec("/usr/bin/sqlite3", ["-json", db, sql], { timeout: 15000 });
    return stdout.trim() ? JSON.parse(stdout) : [];
  } catch (e) {
    throw new Error(`sqlite error (${db}): ${String(e.stderr || e.message).slice(0, 300)}`);
  }
}

function text(result) {
  return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };
}
function needWrites() {
  if (!WRITES) throw new Error("Send/write tools are disabled. Start the daemon with APPLE_DATA_WRITES=1 to enable.");
}

function createMcpServer() {
  const server = new McpServer({ name: "apple-data-mcp", version: "1.0.0" });

  // ---------- iMessage ----------
  server.registerTool("imessage_send", {
    description: "Send an iMessage/SMS to a phone number or email (Apple ID) via Messages.app. Requires APPLE_DATA_WRITES=1.",
    inputSchema: { to: z.string().describe("Phone number (+1...) or Apple ID email"), message: z.string().describe("Message text") },
  }, async ({ to, message }) => {
    needWrites();
    const out = await osa(`tell application "Messages"
  set svc to 1st account whose service type is iMessage
  set bud to participant "${esc(to)}" of svc
  send "${esc(message)}" to bud
end tell`);
    return text({ sent: true, to, detail: out || "message sent" });
  });

  server.registerTool("imessage_recent_threads", {
    description: "List recent iMessage/SMS conversations (handle, last message, timestamp). Read-only.",
    inputSchema: { limit: z.coerce.number().optional().default(15) },
  }, async ({ limit }) => {
    const rows = await sqlite(CHAT_DB, `SELECT c.chat_identifier AS handle, c.display_name AS display_name,
      datetime(MAX(m.date)/1000000000 + 978307200, 'unixepoch') AS last_ts,
      (SELECT m2.text FROM chat_message_join j2 JOIN message m2 ON m2.ROWID = j2.message_id
       WHERE j2.chat_id = c.ROWID AND m2.text IS NOT NULL ORDER BY j2.message_id DESC LIMIT 1) AS last_message
      FROM chat c JOIN chat_message_join j ON j.chat_id = c.ROWID JOIN message m ON m.ROWID = j.message_id
      WHERE c.chat_identifier IS NOT NULL AND c.chat_identifier != ''
      GROUP BY c.ROWID ORDER BY MAX(m.date) DESC LIMIT ${Math.min(Number(limit) || 15, 50)}`);
    return text(rows);
  });

  server.registerTool("imessage_thread", {
    description: "Read a conversation thread with a contact (newest first). Read-only.",
    inputSchema: { handle: z.string().describe("Phone/email the chat is with"), limit: z.coerce.number().optional().default(30) },
  }, async ({ handle, limit }) => {
    const rows = await sqlite(CHAT_DB, `SELECT datetime(m.date/1000000000 + 978307200, 'unixepoch') AS ts,
      m.is_from_me AS from_me, m.text AS text
      FROM chat c JOIN chat_message_join j ON j.chat_id = c.ROWID JOIN message m ON m.ROWID = j.message_id
      WHERE c.chat_identifier = '${q(handle)}' AND m.text IS NOT NULL
      ORDER BY m.date DESC LIMIT ${Math.min(Number(limit) || 30, 100)}`);
    return text(rows);
  });

  // ---------- Mail ----------
  server.registerTool("mail_send", {
    description: "Send an email from the default Mail.app account. Requires APPLE_DATA_WRITES=1.",
    inputSchema: { to: z.string().describe("Recipient email"), subject: z.string(), body: z.string() },
  }, async ({ to, subject, body }) => {
    needWrites();
    await osa(`tell application "Mail"
  set m to make new outgoing message with properties {subject:"${esc(subject)}", content:"${esc(body)}", visible:false}
  tell m to make new to recipient at end of to recipients with properties {address:"${esc(to)}"}
  send m
end tell`);
    return text({ sent: true, to, subject });
  });

  server.registerTool("mail_unread", {
    description: "List unread messages in the Mail.app inbox (sender | subject | received date). Read-only.",
    inputSchema: { limit: z.coerce.number().optional().default(15) },
  }, async ({ limit }) => {
    const out = await osa(`set out to ""
tell application "Mail"
  set msgs to every message of inbox whose read status is false
  repeat with i from 1 to (count of msgs)
    if i > ${Math.min(Number(limit) || 15, 50)} then exit repeat
    set m to item i of msgs
    set out to out & (sender of m) & " | " & (subject of m) & " | " & ((date received of m) as string) & linefeed
  end repeat
end tell
return out`);
    return text(out || "No unread messages");
  });

  server.registerTool("mail_search", {
    description: "Search Mail.app inbox messages by subject substring. Read-only.",
    inputSchema: { query: z.string(), limit: z.coerce.number().optional().default(10) },
  }, async ({ query, limit }) => {
    const out = await osa(`set out to ""
tell application "Mail"
  set msgs to every message of inbox whose subject contains "${esc(query)}"
  repeat with i from 1 to (count of msgs)
    if i > ${Math.min(Number(limit) || 10, 30)} then exit repeat
    set m to item i of msgs
    set out to out & (sender of m) & " | " & (subject of m) & " | " & ((date received of m) as string) & linefeed
  end repeat
end tell
return out`);
    return text(out || `No mail matching: ${query}`);
  });

  // ---------- Notes ----------
  server.registerTool("notes_search", {
    description: "Search Apple Notes by note name substring. Returns name [folder]. Read-only.",
    inputSchema: { query: z.string(), limit: z.coerce.number().optional().default(10) },
  }, async ({ query, limit }) => {
    const out = await osa(`set out to ""
tell application "Notes"
  set ns to (every note whose name contains "${esc(query)}" and sealed is false)
  repeat with i from 1 to (count of ns)
    if i > ${Math.min(Number(limit) || 10, 30)} then exit repeat
    set n to item i of ns
    try
      set out to out & (name of n) & " [" & (name of container of n) & "]" & linefeed
    on error
      set out to out & (name of n) & linefeed
    end try
  end repeat
end tell
return out`);
    return text(out || `No notes matching: ${query}`);
  });

  server.registerTool("notes_read", {
    description: "Read the full plain text of an Apple Note by name substring. Read-only.",
    inputSchema: { name: z.string() },
  }, async ({ name }) => {
    const out = await osa(`tell application "Notes" to get plaintext of first note whose name contains "${esc(name)}"`);
    return text(out);
  });

  // ---------- Calendar ----------
  server.registerTool("calendar_events", {
    description: "List Calendar.app events for the next N days (default 3, max 14) across all calendars. Read-only.",
    inputSchema: { days: z.coerce.number().optional().default(3) },
  }, async ({ days }) => {
    const d = Math.min(Number(days) || 3, 14);
    const out = await osa(`set d1 to current date
set d2 to d1 + ${d} * days
set out to ""
tell application "Calendar"
  repeat with c in calendars
    try
      set evs to (every event of c whose start date is greater than or equal to d1 and start date is less than d2)
      repeat with e in evs
        set out to out & ((start date of e) as string) & " | " & ((end date of e) as string) & " | " & (summary of e) & " | [" & (name of c) & "]" & linefeed
      end repeat
    end try
  end repeat
end tell
return out`);
    return text(out || "No events in range");
  });

  // ---------- Reminders ----------
  server.registerTool("reminders_due_soon", {
    description: "List incomplete Reminders due within N days (default 7). Read-only.",
    inputSchema: { days: z.coerce.number().optional().default(7) },
  }, async ({ days }) => {
    const out = await osa(`set d2 to (current date) + ${Math.min(Number(days) || 7, 60)} * days
set out to ""
tell application "Reminders"
  repeat with l in lists
    try
      set rs to (every reminder of l whose completed is false and due date is less than or equal to d2)
      repeat with r in rs
        set out to out & (name of l) & " | " & (name of r) & " | " & ((due date of r) as string) & linefeed
      end repeat
    end try
  end repeat
end tell
return out`);
    return text(out || "No reminders due in range");
  });

  server.registerTool("reminders_lists", {
    description: "List Reminder lists with counts of incomplete items. Read-only.",
    inputSchema: {},
  }, async () => {
    const out = await osa(`set out to ""
tell application "Reminders"
  repeat with l in lists
    set out to out & (name of l) & " | incomplete: " & (count of (every reminder of l whose completed is false)) & linefeed
  end repeat
end tell
return out`);
    return text(out);
  });

  // ---------- Contacts ----------
  server.registerTool("contacts_search", {
    description: "Search macOS Contacts by name; returns name, first phone, first email. Read-only.",
    inputSchema: { name: z.string() },
  }, async ({ name }) => {
    const out = await osa(`set out to ""
tell application "Contacts"
  set ps to (every person whose name contains "${esc(name)}")
  repeat with i from 1 to (count of ps)
    if i > 5 then exit repeat
    set p to item i of ps
    set ph to ""
    try
      if (count of phone of p) > 0 then set ph to value of first phone of p
    end try
    set em to ""
    try
      if (count of email of p) > 0 then set em to value of first email of p
    end try
    set out to out & (name of p) & " | " & ph & " | " & em & linefeed
  end repeat
end tell
return out`);
    return text(out || `No contacts matching: ${name}`);
  });

  // ---------- Obsidian ----------
  server.registerTool("obsidian_search", {
    description: `Grep the Obsidian Second Brain vault (${VAULT}) for a string; returns file:line matches. Read-only.`,
    inputSchema: { query: z.string(), limit: z.coerce.number().optional().default(20) },
  }, async ({ query, limit }) => {
    if (!query) return text("empty query");
    try {
      const { stdout } = await exec("/usr/bin/grep", ["-rni", "--include=*.md", "-e", query, VAULT], { timeout: 20000, maxBuffer: 4e6 });
      const lines = stdout.split("\n").filter(Boolean).slice(0, Math.min(Number(limit) || 20, 60));
      return text(lines.length ? lines : "No matches");
    } catch (e) {
      if (e.code === 1) return text("No matches");
      throw new Error(String(e.message).slice(0, 300));
    }
  });

  server.registerTool("obsidian_read", {
    description: `Read a markdown note from the vault by vault-relative path (e.g. "10-Projects/tech/MCP Fleet.md"). Read-only.`,
    inputSchema: { path: z.string() },
  }, async ({ path: rel }) => {
    const abs = path.resolve(VAULT, rel);
    if (!abs.startsWith(path.resolve(VAULT))) throw new Error("Path must be inside the vault");
    const body = readFileSync(abs, "utf8");
    return text(body.slice(0, 20000) + (body.length > 20000 ? "\n... (truncated)" : ""));
  });

  server.registerTool("obsidian_recent", {
    description: "List recently modified vault notes (last 30 days, newest first). Read-only.",
    inputSchema: { limit: z.coerce.number().optional().default(15) },
  }, async ({ limit }) => {
    try {
      const { stdout } = await exec("/usr/bin/find", [VAULT, "-name", "*.md", "-mtime", "-30"], { timeout: 20000 });
      const files = stdout.split("\n").filter(Boolean);
      const withTime = files.map(f => { try { return { f, m: statSync(f).mtimeMs }; } catch { return { f, m: 0 }; } });
      withTime.sort((a, b) => b.m - a.m);
      return text(withTime.slice(0, Math.min(Number(limit) || 15, 40)).map(x => x.f));
    } catch (e) { throw new Error(String(e.message).slice(0, 300)); }
  });

  return server;
}

// ---------- HTTP transport (per-session, safari-mcp pattern) ----------
const PORT = parseInt(process.env.APPLE_DATA_MCP_HTTP_PORT || "9230", 10);
const HOST = process.env.APPLE_DATA_MCP_REMOTE === "1" ? "0.0.0.0" : "127.0.0.1";
const KEY = process.env.APPLE_DATA_MCP_KEY;
const transports = new Map();

const httpServer = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", writes: WRITES }));
    return;
  }
  if (req.method !== "POST") { res.writeHead(405).end(); return; }
  if (KEY && req.headers.authorization !== `Bearer ${KEY}`) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Unauthorized: invalid or missing bearer token" }, id: null }));
    return;
  }
  let body = "";
  req.on("data", c => { body += c; });
  req.on("end", async () => {
    try {
      let parsed;
      try { parsed = body ? JSON.parse(body) : undefined; } catch { res.writeHead(400).end(); return; }

      const sid = req.headers["mcp-session-id"];
      let transport = sid ? transports.get(sid) : undefined;

      if (!transport && parsed && parsed.method === "initialize") {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => { transports.set(id, transport); },
        });
        transport.onclose = () => { if (transport.sessionId) transports.delete(transport.sessionId); };
        await createMcpServer().connect(transport);
      }

      if (!transport) {
        res.writeHead(sid ? 404 : 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: sid ? "Session not found" : "No valid session" }, id: null }));
        return;
      }

      await transport.handleRequest(req, res, parsed);
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: String(e.message).slice(0, 300) }, id: null }));
      }
    }
  });
});

httpServer.listen(PORT, HOST, () => {
  console.error(`[apple-data-mcp] listening on http://${HOST}:${PORT}/mcp writes=${WRITES} vault=${VAULT}`);
});
