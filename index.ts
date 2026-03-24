/**
 * KCC Office Notifier Plugin for OpenClaw
 * 
 * Hooks into message_received, message_sent, and after_tool_call to:
 * 1. Push all Boss messages to /api/workflow (start_flow)
 * 2. Push all messages (received + sent) to /api/messages for the dashboard feed
 * 3. Filter out harmless exec failures to reduce notification spam
 */

const DEFAULT_WORKFLOW_ENDPOINT = 'http://localhost:4200/api/workflow';
const DEFAULT_MESSAGES_ENDPOINT = 'http://localhost:4200/api/messages';
const DEFAULT_TIMEOUT_MS = 2000;

/** System noise patterns that should never create tasks or dashboard entries */
const HEARTBEAT_NOISE = ['System heartbeat check', 'Periodic health check', 'Read HEARTBEAT.md', 'HEARTBEAT_OK'];

/**
 * Send an instant wake event to the main agent session via /hooks/wake.
 * This replaces the old flag-file + heartbeat approach with immediate continuation.
 */
async function sendPipelineWake(text: string): Promise<boolean> {
  try {
    const fs = require('fs');
    const path = require('path');
    // Read hooks token from config
    let hooksToken = '';
    try {
      const config = JSON.parse(fs.readFileSync(path.join(require('os').homedir(), '.openclaw', 'openclaw.json'), 'utf8'));
      hooksToken = config?.hooks?.token || '';
    } catch {}
    if (!hooksToken) {
      console.log('[kcc-notify] No hooks token found, cannot send wake');
      return false;
    }
    const gatewayPort = 18789;
    const resp = await fetch(`http://127.0.0.1:${gatewayPort}/hooks/wake`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${hooksToken}`,
      },
      body: JSON.stringify({ text, mode: 'now' }),
      signal: AbortSignal.timeout(5000),
    });
    const ok = resp.ok;
    console.log(`[kcc-notify] Wake sent (${ok ? 'ok' : resp.status}): ${text.slice(0, 80)}`);
    return ok;
  } catch (err: any) {
    console.log(`[kcc-notify] Failed to send wake: ${err?.message || err}`);
    return false;
  }
}

// ── Exec failure filter logic ──

/** Commands where exit code 1 is normal/expected */
const BENIGN_EXIT1_COMMANDS = ['cat', 'grep', 'ls', 'egrep', 'fgrep', 'diff', 'test'];

/** Patterns in stderr/output that indicate harmless failures */
const BENIGN_STDERR_PATTERNS = [
  /no matches found/i,
  /zsh:.*no matches/i,
];

/**
 * Determine if an exec failure is harmless and should be suppressed.
 */
function isHarmlessExecFailure(command: string, exitCode: number, stderr?: string): boolean {
  // 1. Any command with 2>/dev/null that fails — user explicitly silenced errors
  if (command.includes('2>/dev/null') || command.includes('2>\/dev\/null')) {
    return true;
  }

  // 2. Exit code 1 from benign commands (grep no match, cat missing file, etc.)
  if (exitCode === 1) {
    const trimmed = command.trim();
    // Extract the base command (handle pipes, semicolons, &&, ||)
    // Check if the *failing* part is a benign command
    // For simplicity, check if the command starts with or contains a benign command
    for (const cmd of BENIGN_EXIT1_COMMANDS) {
      // Match: "grep ...", "cat ...", or last command in a pipe like "... | grep ..."
      const patterns = [
        new RegExp(`^${cmd}(\\s|$)`),           // starts with command
        new RegExp(`\\|\\s*${cmd}(\\s|$)`),      // piped to command
        new RegExp(`&&\\s*${cmd}(\\s|$)`),        // chained with &&
        new RegExp(`;\\s*${cmd}(\\s|$)`),         // chained with ;
      ];
      if (patterns.some(p => p.test(trimmed))) {
        return true;
      }
    }
  }

  // 3. Suppress zsh "no matches found" errors
  if (stderr) {
    if (BENIGN_STDERR_PATTERNS.some(p => p.test(stderr))) {
      return true;
    }
  }

  // 4. Only notify on exit codes > 1 for unrecognized commands?
  // No — exit code > 1 is always concerning. Exit code 1 from unknown commands
  // is still reported (only the benign list above gets suppressed).

  return false;
}

/**
 * Check if a sent message is just reporting a harmless exec failure.
 * This prevents forwarding "Command exited with code 1" type messages
 * for benign commands to the dashboard.
 */
function isHarmlessExecMessage(content: string): boolean {
  const lower = content.toLowerCase();

  // Check for common exec error message patterns
  const isExecErrorMsg = /command exited with code \d+/i.test(content)
    || /exited with code \d+/i.test(content)
    || /exit code[:\s]+\d+/i.test(content);

  if (!isExecErrorMsg) return false;

  // Extract exit code from message
  const codeMatch = content.match(/code[:\s]+(\d+)/i);
  const exitCode = codeMatch ? parseInt(codeMatch[1], 10) : 0;

  // Exit codes > 1 are always concerning
  if (exitCode > 1) return false;

  // Exit code 1 with benign command references
  for (const cmd of BENIGN_EXIT1_COMMANDS) {
    if (lower.includes(cmd)) return true;
  }

  // Messages about 2>/dev/null commands
  if (lower.includes('2>/dev/null')) return true;

  // zsh no matches
  if (/no matches found/i.test(content)) return true;

  return false;
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  bearerToken?: string
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (bearerToken) {
      headers['Authorization'] = `Bearer ${bearerToken}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    return response.ok;
  } catch (error) {
    console.log(`[kcc-notify] POST ${url} failed (non-blocking):`,
      error instanceof Error ? error.message : 'Unknown error');
    return false;
  }
}

export default function kccNotifyPlugin(api: any) {
  const config = api.config || {};
  const workflowEndpoint = config.endpoint || DEFAULT_WORKFLOW_ENDPOINT;
  const messagesEndpoint = config.messagesEndpoint || DEFAULT_MESSAGES_ENDPOINT;
  const enabled = config.enabled !== false;
  const timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;

  // Owner sender IDs: read from OpenClaw's channels.*.allowFrom config
  // This reuses the existing authorized senders — no extra config needed
  let ownerSenderIds: string[] = [];
  try {
    const fs = require('fs');
    const path = require('path');
    const configPath = path.join(require('os').homedir(), '.openclaw', 'openclaw.json');
    const ocConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const channels = ocConfig?.channels || {};
    for (const ch of Object.values(channels) as any[]) {
      if (Array.isArray(ch?.allowFrom)) {
        ownerSenderIds.push(...ch.allowFrom.map(String));
      }
    }
    // Deduplicate
    ownerSenderIds = [...new Set(ownerSenderIds)];
    if (ownerSenderIds.length > 0) {
      console.log(`[kcc-notify] Owner sender IDs (from allowFrom): ${ownerSenderIds.join(', ')}`);
    }
  } catch {}
  const isOwner = (senderId: string): boolean => {
    if (ownerSenderIds.length === 0) return true; // No allowFrom = all messages are from owner
    return ownerSenderIds.includes(String(senderId));
  };

  // Load API token: env var → config → .env.local fallback
  let apiToken = process.env.KCC_OFFICE_API_TOKEN || process.env.KCC_API_TOKEN || config.apiToken || '';
  if (!apiToken) {
    try {
      const fs = require('fs');
      // Try to find .env.local in the office directory (derive from workflow endpoint)
      const officeUrl = new URL(workflowEndpoint);
      const officePort = officeUrl.port || '4200';
      // Common locations for the office .env.local
      const paths = [
        require('path').join(process.cwd(), '.env.local'),
        require('os').homedir() + '/clawd/kcc-office/.env.local',
      ];
      for (const envPath of paths) {
        try {
          const envContent = fs.readFileSync(envPath, 'utf8');
          const match = envContent.match(/KCC_API_TOKEN=(.+)/);
          if (match) { apiToken = match[1].trim(); break; }
        } catch {}
      }
    } catch {}
  }

  if (!enabled) {
    console.log('[kcc-notify] Plugin disabled');
    return;
  }

  console.log('[kcc-notify] Plugin loaded — hooks: message_received + message_sent');
  console.log('[kcc-notify]   workflow:', workflowEndpoint);
  console.log('[kcc-notify]   messages:', messagesEndpoint);

  // ── message_received: Boss messages → workflow + messages feed ──
  api.on('message_received', async (event: any) => {
    const senderId = event?.metadata?.senderId || '';
    const content = event?.content || '';
    const messageId = event?.metadata?.messageId;
    const senderName = event?.metadata?.senderName || 'Unknown';
    const isBoss = isOwner(senderId);

    console.log(`[kcc-notify] message_received fired: senderId=${senderId} isBoss=${isBoss} content=${(content || '').slice(0, 60)}`);

    // Filter system heartbeat/health-check noise — never push to dashboard
    const HEARTBEAT_NOISE = ['System heartbeat check', 'Periodic health check', 'Read HEARTBEAT.md', 'HEARTBEAT_OK'];
    if (HEARTBEAT_NOISE.some(p => content.includes(p))) {
      console.log(`[kcc-notify] Filtered heartbeat noise: ${content.slice(0, 40)}`);
      return;
    }

    // Push to messages feed (all received messages from Boss)
    if (isBoss && content) {
      console.log(`[kcc-notify] Boss message → messages feed: ${content.slice(0, 60)}`);
      void postJson(messagesEndpoint, {
        message: content,
        from: 'Boss',
        type: 'received',
      }, timeoutMs, apiToken);
    }

    // Call start_flow for Boss messages (existing behavior)
    if (isBoss) {
      console.log(`[kcc-notify] Boss message → start_flow: ${content.slice(0, 60)}`);
      void postJson(workflowEndpoint, {
        action: 'start_flow',
        content: typeof content === 'string' ? content.slice(0, 200) : '',
        from: senderName,
        agent: 'wickedman',
        messageId: messageId ? Number(messageId) : undefined,
      }, timeoutMs, apiToken);
    }
  }, {
    name: 'kcc-message-received',
    description: 'Push received Boss messages to KCC Office dashboard',
  });

  // ── message_sent: bot replies → messages feed + auto agent_complete ──
  api.on('message_sent', async (event: any) => {
    const content = event?.content || event?.text || '';
    if (!content) return;

    // Filter out messages that are just reporting harmless exec failures
    if (isHarmlessExecMessage(content)) {
      console.log(`[kcc-notify] Suppressed harmless exec error message: ${content.slice(0, 60)}`);
      return;
    }

    // Only push messages sent to Boss (check recipient)
    const recipientId = event?.metadata?.recipientId || event?.metadata?.chatId || '';
    const isToBoss = isOwner(recipientId);

    if (isToBoss) {
      console.log(`[kcc-notify] Bot reply → messages feed: ${content.slice(0, 60)}`);
      void postJson(messagesEndpoint, {
        message: content,
        from: 'WickedMan',
        type: 'sent',
      }, timeoutMs, apiToken);

      // Auto-complete any active task when we send a reply to Boss
      console.log(`[kcc-notify] Bot reply → agent_complete`);
      void postJson(workflowEndpoint, {
        action: 'agent_complete',
        agent: 'wickedman',
        result: typeof content === 'string' ? content.slice(0, 200) : 'Task completed',
      }, timeoutMs, apiToken);
    }
  }, {
    name: 'kcc-message-sent',
    description: 'Push bot replies to KCC Office messages feed + auto-complete tasks',
  });

  // ── after_tool_call: detect delegation + filter exec failures ──
  api.on('after_tool_call', async (event: any) => {
    const toolName = event?.toolName || event?.name || '';

    // Detect sessions_spawn → notify dashboard about delegation
    if (toolName === 'sessions_spawn') {
      const args = event?.params || event?.input || {};
      const delegatedTo = args?.agentId || 'agent';
      const taskDetail = args?.task || 'Delegated task';
      console.log(`[kcc-notify] Delegation detected → ${delegatedTo}: ${taskDetail.slice(0, 60)}`);
      void postJson(workflowEndpoint, {
        action: 'start_flow',
        content: taskDetail.slice(0, 200),
        from: 'Boss',
        agent: 'wickedman',
        delegatedTo,
      }, timeoutMs, apiToken);
      return;
    }

    // Only care about exec tool calls from here
    if (toolName !== 'exec') return;

    const result = event?.result || event?.output || {};
    const status = result?.status || '';
    const exitCode = typeof result?.exitCode === 'number' ? result.exitCode
      : (status === 'error' ? 1 : 0);

    // Only process failures
    if (exitCode === 0 && status !== 'error') return;

    const command = event?.params?.command || event?.input?.command || '';
    const stderr = result?.stderr || result?.error || '';

    if (isHarmlessExecFailure(command, exitCode, stderr)) {
      console.log(`[kcc-notify] Suppressed harmless exec failure (code ${exitCode}): ${command.slice(0, 80)}`);
      return;
    }

    // Genuinely concerning failure — notify dashboard
    console.log(`[kcc-notify] Exec failure → dashboard (code ${exitCode}): ${command.slice(0, 80)}`);
    void postJson(messagesEndpoint, {
      message: `⚠️ Exec failure (exit ${exitCode}): ${command.slice(0, 150)}`,
      from: 'System',
      type: 'exec_error',
    }, timeoutMs, apiToken);
  }, {
    name: 'kcc-exec-filter',
    description: 'Filter harmless exec failures, notify only on real problems',
  });

  // ── subagent_spawned: detect delegation and notify dashboard ──
  api.on('subagent_spawned', async (event: any) => {
    const childSessionKey = event?.childSessionKey || '';
    const task = event?.task || event?.prompt || '';
    // Extract agent ID from session key: "agent:py:subagent:uuid" → "py"
    const parts = childSessionKey.split(':');
    const agentId = parts.length >= 2 ? parts[1] : '';
    
    if (agentId && task) {
      console.log(`[kcc-notify] Delegation detected → ${agentId}: ${task.slice(0, 60)}`);
      void postJson(workflowEndpoint, {
        action: 'start_flow',
        content: task.slice(0, 200),
        from: 'Boss',
        agent: 'wickedman',
        delegatedTo: agentId,
      }, timeoutMs, apiToken);
    }
  }, {
    name: 'kcc-delegation-detect',
    description: 'Detect sub-agent spawn and notify dashboard about delegation',
  });

  // ── subagent_delivery_target: suppress direct announce to chat ──
  // Return null to prevent delivery target resolution, letting orchestrator handle summary
  api.on('subagent_delivery_target', async (event: any, ctx: any) => {
    const childSessionKey = event?.childSessionKey || ctx?.childSessionKey || '';
    const requesterSessionKey = event?.requesterSessionKey || ctx?.requesterSessionKey || '';
    
    console.log(`[kcc-notify] subagent_delivery_target: child=${childSessionKey}, requester=${requesterSessionKey}`);
    
    // Suppress direct announce to chat — let orchestrator handle summary
    // Return null to prevent delivery target resolution
    return null;
  }, {
    name: 'kcc-suppress-announce',
    description: 'Suppress sub-agent direct announce to chat, orchestrator handles summary',
  });

  // ── subagent_ended: pipeline continuation via DB (single source of truth) ──
  api.on('subagent_ended', async (event: any, ctx: any) => {
    try {
      console.log(`[kcc-notify] subagent_ended FIRED`);

      const childSessionKey = event?.childSessionKey || event?.sessionKey || event?.targetSessionKey || ctx?.childSessionKey || '';
      const requesterSessionKey = event?.requesterSessionKey || event?.parentSessionKey || ctx?.requesterSessionKey || '';

      if (!childSessionKey || !requesterSessionKey) {
        console.log(`[kcc-notify] subagent_ended: missing session keys, skipping`);
        return;
      }

      // Extract agent ID from child session key (e.g. "agent:py:subagent:uuid" → "py")
      const sessionParts = childSessionKey.split(':');
      const agentId = sessionParts.length >= 2 ? sessionParts[1] : '';
      if (!agentId) return;

      // ── 1. Query KCC Office DB for active pipeline task involving this agent ──
      let pipelineTask: any = null;
      try {
        const url = `${workflowEndpoint.replace('/api/workflow', '')}/api/workflow?type=pipeline-task&agent=${agentId}`;
        const resp = await fetch(url, {
          headers: apiToken ? { 'Authorization': `Bearer ${apiToken}` } : {},
          signal: AbortSignal.timeout(3000),
        });
        if (resp.ok) {
          const data = await resp.json() as any;
          pipelineTask = data?.task;
        }
      } catch (err: any) {
        console.log(`[kcc-notify] Failed to query pipeline task: ${err?.message || err}`);
      }

      if (!pipelineTask) {
        console.log(`[kcc-notify] No active pipeline task for agent ${agentId}, skipping`);
        return;
      }

      const taskId = pipelineTask.id;
      const ps = pipelineTask.pipelineState;
      const currentStage = ps?.stages?.[ps?.currentStage];

      if (!currentStage || currentStage.status !== 'active') {
        console.log(`[kcc-notify] Pipeline task ${taskId}: no active stage, skipping`);
        return;
      }

      console.log(`[kcc-notify] Pipeline match: agent=${agentId}, taskId=${taskId}, stage=${currentStage.name}`);

      // ── 2. Fetch sub-agent's last message for QA verdict detection ──
      let firstLine = 'completed';
      let qaVerdict: string | undefined = undefined;

      const fs = require('fs');
      const path = require('path');
      let gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || '';
      if (!gatewayToken) {
        try {
          const config = JSON.parse(fs.readFileSync(path.join(require('os').homedir(), '.openclaw', 'openclaw.json'), 'utf8'));
          gatewayToken = config?.gateway?.auth?.token || '';
        } catch {}
      }

      try {
        const historyUrl = `http://127.0.0.1:18789/api/sessions/${encodeURIComponent(childSessionKey)}/history?limit=1`;
        const histResp = await fetch(historyUrl, {
          headers: gatewayToken ? { 'Authorization': `Bearer ${gatewayToken}` } : {},
          signal: AbortSignal.timeout(3000),
        });
        if (histResp.ok) {
          const histData = await histResp.json() as any;
          const messages = Array.isArray(histData) ? histData : histData?.messages || [];
          if (messages.length > 0) {
            const msg = messages[messages.length - 1];
            const content = typeof msg?.content === 'string' ? msg.content
              : typeof msg?.text === 'string' ? msg.text : '';
            firstLine = content.split('\n')[0]?.trim() || 'completed';
          }
        }
      } catch (err: any) {
        console.log(`[kcc-notify] Failed to fetch session history: ${err?.message || err}`);
      }

      // Detect QA verdict if this is a QA stage
      if (currentStage.name === 'hawk_qa' || currentStage.name === 'vigil_review' || currentStage.name === 'florence_review') {
        if (/QA_PASS/i.test(firstLine)) qaVerdict = 'QA_PASS';
        else if (/QA_FAIL/i.test(firstLine)) qaVerdict = 'QA_FAIL';
        // If no explicit verdict, leave undefined — API will just advance
      }

      // ── 3. Call advance_pipeline API — single source of truth ──
      let advanceResult: any = null;
      try {
        const resp = await fetch(workflowEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiToken ? { 'Authorization': `Bearer ${apiToken}` } : {}),
          },
          body: JSON.stringify({
            action: 'advance_pipeline',
            taskId,
            agent: agentId,
            result: firstLine.slice(0, 200),
            qaVerdict,
          }),
          signal: AbortSignal.timeout(5000),
        });
        if (resp.ok) {
          advanceResult = await resp.json() as any;
          console.log(`[kcc-notify] advance_pipeline: nextAction=${advanceResult.nextAction}, nextAgent=${advanceResult.nextAgent}, stage=${advanceResult.stage}`);
        } else {
          console.log(`[kcc-notify] advance_pipeline failed: ${resp.status}`);
        }
      } catch (err: any) {
        console.log(`[kcc-notify] advance_pipeline error: ${err?.message || err}`);
      }

      if (!advanceResult?.success || advanceResult.nextAction === 'none') {
        console.log(`[kcc-notify] No pipeline action needed`);
        return;
      }

      // ── 4. Send wake event with structured pipeline instruction ──
      const wakeText = `[Pipeline] taskId=${taskId} action=${advanceResult.nextAction} agent=${advanceResult.nextAgent || 'none'} stage=${advanceResult.stage} childSession=${childSessionKey}`;
      void sendPipelineWake(wakeText);

    } catch (err: any) {
      console.log(`[kcc-notify] subagent_ended hook ERROR: ${err?.stack || err?.message || err}`);
    }
  }, {
    name: 'kcc-pipeline-continuation',
    description: 'Pipeline continuation via DB single source of truth',
  });

  // ── HTTP route for manual notifications ──
  api.registerHttpRoute({
    path: '/kcc-notify',
    async handler(req: any) {
      const body = await req.json();
      const { content, from = 'Unknown', messageId } = body;

      if (!content) {
        return new Response(JSON.stringify({ error: 'content is required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const success = await postJson(workflowEndpoint, {
        action: 'start_flow',
        content: typeof content === 'string' ? content.slice(0, 200) : '',
        from,
        agent: 'wickedman',
        messageId: messageId ? Number(messageId) : undefined,
      }, timeoutMs, apiToken);

      return new Response(JSON.stringify({ success }), {
        status: success ? 200 : 502,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
}
