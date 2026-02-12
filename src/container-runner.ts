/**
 * Container Runner for NanoClaw
 * Spawns agent execution in Docker container and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  AGENTBRAIN_DIR,
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  TIMEZONE,
} from './config.js';
import { logger } from './logger.js';
import { validateAdditionalMounts } from './mount-security.js';
import { OwnerConfig } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
}

export interface AgentResponse {
  outputType: 'message' | 'log';
  userMessage?: string;
  internalLog?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: AgentResponse | null;
  newSessionId?: string;
  error?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function buildVolumeMounts(config: OwnerConfig): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();

  // Always mount project root (single-user = full access)
  mounts.push({
    hostPath: projectRoot,
    containerPath: '/workspace/project',
    readonly: false,
  });

  // Group folder as working directory
  mounts.push({
    hostPath: path.join(GROUPS_DIR, config.folder),
    containerPath: '/workspace/group',
    readonly: false,
  });

  // AgentBrain vault
  fs.mkdirSync(AGENTBRAIN_DIR, { recursive: true });
  mounts.push({
    hostPath: AGENTBRAIN_DIR,
    containerPath: '/workspace/brain',
    readonly: false,
  });

  // Claude sessions directory
  const sessionsDir = path.join(
    DATA_DIR,
    'sessions',
    config.folder,
    '.claude',
  );
  fs.mkdirSync(sessionsDir, { recursive: true });
  mounts.push({
    hostPath: sessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // IPC namespace
  const ipcDir = path.join(DATA_DIR, 'ipc', config.folder);
  fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });
  mounts.push({
    hostPath: ipcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Environment file directory
  const envDir = path.join(DATA_DIR, 'env');
  fs.mkdirSync(envDir, { recursive: true });
  const envFile = path.join(projectRoot, '.env');
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf-8');
    const allowedVars = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
    const filteredLines = envContent.split('\n').filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return false;
      return allowedVars.some((v) => trimmed.startsWith(`${v}=`));
    });

    if (filteredLines.length > 0) {
      fs.writeFileSync(
        path.join(envDir, 'env'),
        filteredLines.join('\n') + '\n',
      );
      mounts.push({
        hostPath: envDir,
        containerPath: '/workspace/env-dir',
        readonly: true,
      });
    }
  }

  // Additional mounts validated against external allowlist
  if (config.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      config.containerConfig.additionalMounts,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

function buildContainerArgs(mounts: VolumeMount[], containerName: string): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass timezone so container's Date functions use the correct local time
  args.push('-e', `TZ=${TIMEZONE}`);

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(
        '--mount',
        `type=bind,source=${mount.hostPath},target=${mount.containerPath},readonly`,
      );
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  config: OwnerConfig,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = path.join(GROUPS_DIR, config.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(config);
  const containerName = `nanoclaw-main-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName);

  logger.debug(
    {
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      containerName,
      mountCount: mounts.length,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(GROUPS_DIR, config.folder, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn('docker', containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    container.stdout.on('data', (data) => {
      if (stdoutTruncated) return;
      const chunk = data.toString();
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
      if (chunk.length > remaining) {
        stdout += chunk.slice(0, remaining);
        stdoutTruncated = true;
        logger.warn(
          { size: stdout.length },
          'Container stdout truncated due to size limit',
        );
      } else {
        stdout += chunk;
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: config.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      logger.error({ containerName }, 'Container timeout, stopping gracefully');
      exec(`docker stop ${containerName}`, { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn({ containerName, err }, 'Graceful stop failed, force killing');
          container.kill('SIGKILL');
        }
      });
    }, config.containerConfig?.timeout || CONTAINER_TIMEOUT);

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(timeoutLog, [
          `=== Container Run Log (TIMEOUT) ===`,
          `Timestamp: ${new Date().toISOString()}`,
          `Container: ${containerName}`,
          `Duration: ${duration}ms`,
          `Exit Code: ${code}`,
        ].join('\n'));

        logger.error(
          { containerName, duration, code },
          'Container timed out',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${config.containerConfig?.timeout || CONTAINER_TIMEOUT}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      // Helper to append request/response details to log file (non-verbose only)
      const appendInteractionLog = (sections: string[]) => {
        if (!isVerbose) {
          try {
            fs.appendFileSync(logFile, '\n' + sections.join('\n') + '\n');
          } catch {
            // Non-critical — don't fail the response
          }
        }
      };

      if (code !== 0) {
        logger.error(
          {
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        appendInteractionLog([
          `=== User Request ===`,
          input.prompt.slice(0, 2000),
          ``,
          `=== Error ===`,
          `Container exited with code ${code}`,
          stderr.slice(-500),
        ]);

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        // Append request/response to log file
        const result = output.result;
        const userMsg = result?.userMessage || '';
        const internalLog = result?.internalLog || '';
        appendInteractionLog([
          `=== User Request ===`,
          input.prompt.slice(0, 2000),
          ``,
          `=== Agent Response ===`,
          `Output Type: ${result?.outputType || 'unknown'}`,
          `User Message (${userMsg.length} chars):`,
          userMsg.slice(0, 2000),
          `Internal Log:`,
          internalLog.slice(0, 500),
        ]);

        resolve(output);
      } catch (err) {
        logger.error(
          {
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        appendInteractionLog([
          `=== User Request ===`,
          input.prompt.slice(0, 2000),
          ``,
          `=== Parse Error ===`,
          `${err instanceof Error ? err.message : String(err)}`,
        ]);

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error({ containerName, error: err }, 'Container spawn error');
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));
}
