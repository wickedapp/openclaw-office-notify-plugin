# OpenClaw Office Notify Plugin

> **Companion plugin for [OpenClaw Office](https://github.com/wickedapp/openclaw-office)** — bridges OpenClaw agent events to the Office dashboard in real-time.

## What It Does

```
User Message → OpenClaw Gateway
                    ↓
              [This Plugin]
                    ↓ message_received → start_flow (creates request + task)
                    ↓ message_sent → agent_complete (marks task done)
                    ↓ after_tool_call → exec error notifications
                    ↓ subagent_ended → pipeline continuation
                    ↓
              OpenClaw Office Dashboard (localhost:4200)
```

When you send a message to your agent, this plugin notifies the Office dashboard so it can:
- Show the request arriving (📥 animation)
- Analyze and create a task (🔍 → 📋)
- Show delegation to agents (📧 envelope animation)
- Track work in progress (⚡)
- Mark completion (✅)

## Installation

### 1. Clone the plugin

```bash
git clone https://github.com/wickedapp/openclaw-office-notify-plugin.git ~/.openclaw/extensions/openclaw-office-notify
```

### 2. Register in OpenClaw config

Add to your `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["openclaw-office-notify"],
    "load": {
      "paths": ["~/.openclaw/extensions/openclaw-office-notify"]
    },
    "entries": {
      "openclaw-office-notify": {
        "enabled": true
      }
    }
  }
}
```

### 3. Restart OpenClaw

```bash
openclaw gateway restart
```

## Configuration

All options go in `plugins.entries.openclaw-office-notify` in your OpenClaw config:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `endpoint` | string | `http://localhost:4200/api/workflow` | Office workflow API endpoint |
| `messagesEndpoint` | string | `http://localhost:4200/api/messages` | Office messages feed endpoint |
| `apiToken` | string | `""` | Bearer token for Office API auth (also reads `KCC_OFFICE_API_TOKEN` env var) |
| `enabled` | boolean | `true` | Enable/disable the plugin |
| `timeoutMs` | number | `2000` | Request timeout in milliseconds |

### Owner Detection

The plugin automatically reads `channels.*.allowFrom` from your OpenClaw config to determine which sender IDs are "owners". Only owner messages create dashboard entries. If no `allowFrom` is configured, all messages are tracked (single-user default).

### With API authentication

If your Office dashboard has API auth enabled:

```json
{
  "openclaw-office-notify": {
    "enabled": true,
    "apiToken": "your-kcc-api-token"
  }
}
```

## Hooks Registered

| Hook | Purpose |
|------|---------|
| `message_received` | Creates dashboard request + task on incoming messages |
| `message_sent` | Auto-completes active task when agent replies |
| `after_tool_call` | Filters exec failures, notifies on real errors |
| `subagent_delivery_target` | Suppresses direct sub-agent announces (orchestrator handles) |
| `subagent_ended` | Advances pipeline stages when sub-agents complete |

## Non-Blocking Design

All notifications are fire-and-forget with configurable timeouts. If the Office dashboard is down, OpenClaw continues working normally.

## Automatic Noise Filtering

System heartbeat checks, health polls, and `HEARTBEAT_OK` messages are automatically filtered — they never create tasks or dashboard entries.

## License

MIT
