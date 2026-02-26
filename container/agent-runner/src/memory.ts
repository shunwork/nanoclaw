/**
 * AgentBrain memory loading for container agent.
 * Loads core memory (stable, for systemPrompt) and volatile context (for first prompt).
 */

import fs from 'fs';
import path from 'path';

import { log } from './logging.js';

const BRAIN_DIR = '/workspace/brain';

/**
 * Load core memory from AgentBrain vault for system prompt injection.
 * Volatile content (context.md, daily logs) is loaded separately via loadVolatileContext().
 */
export function loadCoreMemory(): string {
  if (!fs.existsSync(BRAIN_DIR)) {
    log('AgentBrain vault not found at /workspace/brain');
    return '';
  }

  const files = [
    { path: 'agentmind/soul.md', tag: 'soul' },
    { path: 'agentmind/identity.md', tag: 'identity' },
    { path: 'memory/user.md', tag: 'user-profile' },
    { path: 'memory/tool.md', tag: 'tool-knowledge' },
    { path: 'memory/memory.md', tag: 'long-term-memory' },
  ];

  const sections: string[] = [];

  for (const f of files) {
    const fullPath = path.join(BRAIN_DIR, f.path);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, 'utf-8').trim();
      if (content) {
        sections.push(`<${f.tag}>\n${content}\n</${f.tag}>`);
      }
    }
  }

  if (sections.length === 0) return '';
  return `<agentbrain>\n${sections.join('\n\n')}\n</agentbrain>`;
}

/**
 * Load volatile context (context.md + daily logs) for injection into the first
 * user message of a new session. Not included in systemPrompt to keep it stable
 * for prompt caching. On session resume, the agent can read these files via
 * the Read tool if needed.
 */
export function loadVolatileContext(): string {
  if (!fs.existsSync(BRAIN_DIR)) return '';

  const parts: string[] = [];

  // Current context
  const contextPath = path.join(BRAIN_DIR, 'memory', 'context.md');
  if (fs.existsSync(contextPath)) {
    const content = fs.readFileSync(contextPath, 'utf-8').trim();
    if (content) {
      parts.push(`<context>\n${content}\n</context>`);
    }
  }

  // Daily logs: yesterday then today (chronological order, separate tags)
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  const dailyDir = path.join(BRAIN_DIR, 'memory', 'daily');

  const yesterdayPath = path.join(dailyDir, `${yesterdayStr}.md`);
  if (fs.existsSync(yesterdayPath)) {
    const content = fs.readFileSync(yesterdayPath, 'utf-8').trim();
    if (content) {
      parts.push(`<yesterday_notes date="${yesterdayStr}">\n${content}\n</yesterday_notes>`);
    }
  }

  const todayPath = path.join(dailyDir, `${todayStr}.md`);
  if (fs.existsSync(todayPath)) {
    const content = fs.readFileSync(todayPath, 'utf-8').trim();
    if (content) {
      parts.push(`<today_notes date="${todayStr}">\n${content}\n</today_notes>`);
    }
  }

  return parts.join('\n\n');
}
