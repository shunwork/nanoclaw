/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

import { ContainerInput, ContainerOutput, SDKUserMessage } from './types.js';
import { log } from './logging.js';
import { loadCoreMemory, loadVolatileContext } from './memory.js';
import { createPreCompactHook } from './transcript.js';
import { createSanitizeBashHook } from './hooks.js';
import {
  IPC_INPUT_DIR,
  IPC_INPUT_CLOSE_SENTINEL,
  IPC_RESET_SESSION_SENTINEL,
  IPC_POLL_MS,
  shouldClose,
  shouldResetSession,
  drainIpcInput,
  waitForIpcMessage,
} from './ipc-input.js';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/**
 * Load known UUIDs from the session transcript to detect replayed messages.
 * During session resume, the SDK replays old assistant messages. Messages with
 * UUIDs in this set are skipped to avoid re-sending old text to the user.
 */
function loadKnownUuids(sessionId: string | undefined): Set<string> {
  const uuids = new Set<string>();
  if (!sessionId) return uuids;

  const projectDir = '/home/node/.claude/projects/-workspace-group';
  const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
  if (!fs.existsSync(transcriptPath)) return uuids;

  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.uuid) uuids.add(entry.uuid);
      } catch { /* skip malformed lines */ }
    }
    log(`Loaded ${uuids.size} known UUIDs from transcript`);
  } catch (err) {
    log(`Failed to load UUIDs from transcript: ${err instanceof Error ? err.message : String(err)}`);
  }

  return uuids;
}

/**
 * Extract text content from an assistant message's content blocks.
 */
function extractAssistantText(message: unknown): string {
  const content = (message as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text)
    .join('');
}

/**
 * Log details of an assistant message's tool use blocks.
 */
function logToolUseBlocks(message: unknown, queryNumber: number, messageCount: number, uuid: string): void {
  const content = (message as { message?: { content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }> } }).message?.content;
  const toolUseBlocks = content?.filter((b) => b.type === 'tool_use') ?? [];
  if (toolUseBlocks.length > 0) {
    log(`[Q${queryNumber} #${messageCount}] assistant uuid=${uuid.slice(0, 8)}…`);
    for (const block of toolUseBlocks) {
      const params = block.input
        ? Object.entries(block.input)
            .map(([k, v]) => {
              const s = typeof v === 'string' ? v : JSON.stringify(v);
              return `${k}: ${JSON.stringify(s.length > 80 ? s.slice(0, 80) + '…' : s)}`;
            })
            .join(', ')
        : '';
      log(`  → ${block.name || 'unknown'}${params ? ` { ${params} }` : ''}`);
    }
  } else {
    log(`[Q${queryNumber} #${messageCount}] assistant uuid=${uuid.slice(0, 8)}… (tool_use only)`);
  }
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 *
 * UUID-based replay detection: messages with UUIDs already in knownUuids
 * are skipped (replayed from session resume). New UUIDs are added to the set
 * so they persist across queries within the same container.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt: string | undefined,
  knownUuids: Set<string>,
  queryNumber: number,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean; resetRequested: boolean }> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages, _close sentinel, and _reset_session sentinel
  let ipcPolling = true;
  let closedDuringQuery = false;
  let resetRequested = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    if (!resetRequested && shouldResetSession()) {
      log('Session reset sentinel detected during query, ending stream for new session');
      resetRequested = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;
  let lastAssistantText = '';

  // Discover additional directories mounted at /workspace/extra/*
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  const coreMemory = loadCoreMemory();
  if (coreMemory) {
    log(`Core memory loaded: ${coreMemory.length} chars`);
  }

  for await (const message of query({
    prompt: stream,
    options: {
      model: process.env.AGENT_MODEL || 'claude-sonnet-4-6',
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: coreMemory
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: coreMemory }
        : undefined,
      allowedTools: [
        'Bash',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'Task', 'TaskOutput', 'TaskStop',
        'TeamCreate', 'TeamDelete', 'SendMessage',
        'TodoWrite', 'ToolSearch', 'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*',
        'mcp__heptabase__*'
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
          },
        },
        heptabase: {
          command: 'npx',
          args: ['-y', 'mcp-remote@latest', 'https://api.heptabase.com/mcp', '--transport', 'http-only'],
        },
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [createSanitizeBashHook()] }],
      },
    }
  })) {
    messageCount++;

    // --- Assistant message: UUID-based replay detection ---
    if (message.type === 'assistant' && 'uuid' in message) {
      const uuid = (message as { uuid: string }).uuid;
      lastAssistantUuid = uuid;

      if (knownUuids.has(uuid)) {
        log(`[Q${queryNumber} #${messageCount}] assistant uuid=${uuid.slice(0, 8)}… (replay, skipped)`);
        continue;
      }

      // New assistant message — add to known set and extract text
      knownUuids.add(uuid);
      const text = extractAssistantText(message);
      if (text) {
        lastAssistantText = text;
        log(`[Q${queryNumber} #${messageCount}] assistant uuid=${uuid.slice(0, 8)}… text=${text.slice(0, 100)}… (${text.length} chars)`);
      } else {
        logToolUseBlocks(message, queryNumber, messageCount, uuid);
      }
      continue;
    }

    // --- System messages ---
    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`[Q${queryNumber} #${messageCount}] system/init session=${newSessionId}`);
    } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`[Q${queryNumber} #${messageCount}] task_notification task=${tn.task_id} status=${tn.status}`);
    } else if (message.type === 'system') {
      log(`[Q${queryNumber} #${messageCount}] system/${(message as { subtype?: string }).subtype}`);
    }

    // --- Tool use summary ---
    if (message.type === 'tool_use_summary') {
      const msg = message as Record<string, unknown>;
      const summary = (msg.summary || msg.tool_use_summary || msg.text || '') as string;
      if (summary) {
        log(`[Q${queryNumber} #${messageCount}] tool_summary: ${summary.slice(0, 200)}`);
      }
    }

    // --- Result message: emit output with fallback ---
    if (message.type === 'result') {
      resultCount++;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      const outputText = textResult || lastAssistantText || null;
      const source = textResult ? 'result' : lastAssistantText ? 'assistant-fallback' : 'none';

      log(`[Q${queryNumber} result#${resultCount}] source=${source} text=${(outputText || '(null)').slice(0, 200)} (${outputText?.length || 0} chars)`);

      writeOutput({
        status: 'success',
        result: outputText,
        newSessionId
      });
      lastAssistantText = ''; // Reset for next result
    }
  }

  ipcPolling = false;
  log(`Query Q${queryNumber} done. Messages: ${messageCount}, results: ${resultCount}, closedDuringQuery: ${closedDuringQuery}, resetRequested: ${resetRequested}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery, resetRequested };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    // Delete the temp file the entrypoint wrote — it contains secrets
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Build SDK env: merge secrets into process.env for the SDK only.
  // Secrets never touch process.env itself, so Bash subprocesses can't see them.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale sentinels from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
  try { fs.unlinkSync(IPC_RESET_SESSION_SENTINEL); } catch { /* ignore */ }

  // Load known UUIDs from transcript for replay detection (shared across queries)
  const knownUuids = loadKnownUuids(sessionId);

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }

  // Inject volatile context (context.md + daily logs) into first prompt only
  if (!containerInput.sessionId) {
    const volatileContext = loadVolatileContext();
    if (volatileContext) {
      log(`Volatile context loaded: ${volatileContext.length} chars`);
      prompt = `${volatileContext}\n\n${prompt}`;
    }
  }

  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  let queryNumber = 0;
  try {
    while (true) {
      queryNumber++;
      log(`Starting query Q${queryNumber} (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'}, knownUuids: ${knownUuids.size})...`);

      const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt, knownUuids, queryNumber);
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Handle session reset: clear state so next query starts a fresh session
      let pendingReset = queryResult.resetRequested;
      if (pendingReset) {
        log('Session reset: clearing sessionId, resumeAt, knownUuids');
        sessionId = undefined;
        resumeAt = undefined;
        knownUuids.clear();
      }

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      // Check for reset sentinel that arrived while waiting between queries
      if (!pendingReset && shouldResetSession()) {
        log('Session reset detected between queries: clearing sessionId, resumeAt, knownUuids');
        sessionId = undefined;
        resumeAt = undefined;
        knownUuids.clear();
        pendingReset = true;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;

      // Inject volatile context for the new session (same as container startup)
      if (pendingReset) {
        const volatileContext = loadVolatileContext();
        if (volatileContext) {
          log(`Volatile context loaded for new session: ${volatileContext.length} chars`);
          prompt = `${volatileContext}\n\n${prompt}`;
        }
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
