# Autonomous Agent Hub V2 — Setup & Onboarding Guide

## Prerequisites

Before you begin, ensure you have the following on your Windows PC:

- **Node.js** v18 or higher ([nodejs.org](https://nodejs.org))
- **Ollama** running in the background ([ollama.com/download](https://ollama.com/download))
- A **Google Gemini API Key** — free at [aistudio.google.com](https://aistudio.google.com/app/apikey)
  *(Optional — the system will prompt you during setup and can run in Offline/Local-Only mode without one)*

---

## Step 1: Run the Setup Script

Open **PowerShell** in the project directory and run:

```powershell
.\setup.ps1
```

This will:
- Check and install Node.js and Ollama if missing
- Install all NPM dependencies
- Set up the OpenClaw WhatsApp gateway (optional)
- Create the `.env` configuration file
- Prompt for WhatsApp QR code authentication (optional)

---

## Step 2: Start the Agent

```bash
npm start
```

On **first launch**, the system detects that no agent has been configured and automatically pauses to launch the **Intelligent Onboarding Wizard** in the terminal.

---

## Step 3: Onboarding Wizard

The wizard walks you through the following phases:

### Identity & Owner
- **Name your Agent** — choose any name (e.g. `ATLAS`, `ARGUS`, `NOVA`). This name becomes the agent's identity, the WhatsApp wake word, and appears across the entire UI.
- **Your Name** — personalises your long-term memory vault (e.g. `vault/alice.md`).

### API Key
- If no Gemini API key is in `.env`, the wizard will prompt you.
- A browser will open [aistudio.google.com](https://aistudio.google.com/app/apikey) to help you get a free key.
- The key is saved to `.env` automatically.

### Hardware Profiling
- The wizard silently scans your CPU, RAM, and VRAM.
- It also queries Ollama to detect any models you have already downloaded.

### Goal Selection
Choose your primary use case:
- 🖥️ Heavy Coding & Autonomous Scripting
- 🧠 Complex Reasoning & Deep Research
- ⚡ Fast General Assistance
- 🌟 The Ultimate All-Rounder
- ✏️ Custom (type your own goal)

### Fleet Negotiation
Your hardware profile and goal are sent to **Gemini 2.5 Flash**, which recommends the optimal 3-model fleet for your specific rig:

| Role | Purpose |
|------|---------|
| `planner` | Heavy reasoning, coding, system routing |
| `synthesiser` | Creative tasks, analysis, summarisation |
| `chat` | Fast, lightweight everyday responses |

You can **Accept** the recommendation or **Suggest Changes** — Gemini will revise the fleet based on your feedback. This loop repeats until you're happy.

### Auto-Provisioning
Once accepted, the wizard automatically runs `ollama pull` for any models not yet installed. When complete, the Agent Hub window opens.

---

## Step 4: Use the Agent

Navigate to `http://localhost:3000` (or the Electron window opens automatically).

### Subsequent Launches
The wizard only runs on first launch. After that, `npm start` boots straight into the UI with your configured agent name.

To **reconfigure** (reset agent name, fleet, etc.), delete `vault/agent_config.json` and `vault/fleet_config.json`.

---

## Project Structure

```
jarvis-v2/
├── src/
│   ├── setup/        ← Onboarding wizard (runs once on first boot)
│   ├── api/          ← Express HTTP + WebSocket server
│   ├── orchestrator/ ← Gemini cloud router
│   ├── fleet/        ← Local Ollama model management
│   ├── memory/       ← Long-term memory & RAG
│   ├── tools/        ← Tool executor (scripts, browser, search)
│   ├── hardware/     ← Hardware profiling & context monitors
│   ├── gateway/      ← OpenClaw WhatsApp gateway
│   └── desktop/      ← Electron entry point
├── public/           ← Frontend dashboard (HTML/CSS/JS)
├── vault/            ← Persistent data (config, memory, metrics)
├── scripts/          ← Automation Vault (agent-created scripts)
├── setup.ps1         ← One-click setup script
└── .env              ← Environment variables
```

---

## Environment Variables (`.env`)

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Web server port | `3000` |
| `OLLAMA_URL` | Ollama API endpoint | `http://127.0.0.1:11434` |
| `GEMINI_API_KEY` | Google Gemini API key | *(set during wizard)* |
| `DEFAULT_LOCAL_MODEL` | Fallback model if fleet not configured | `hermes3` |

---

## Troubleshooting

**Wizard doesn't appear on first run**
- Ensure Electron is running in a terminal that shows stdout (not minimised or piped to `/dev/null`).

**"Gemini API key is required" error**
- Add `GEMINI_API_KEY=your_key_here` to `.env` and restart.

**Ollama models won't pull**
- Ensure Ollama is running: `ollama serve`
- Check `OLLAMA_URL` in `.env` matches your Ollama address.

**WhatsApp not responding to messages**
- Confirm the OpenClaw gateway is running (visible in the OpenClaw tab of the dashboard).
- Check that you're using the correct wake word — it's the **agent name** you chose during setup.

**Resetting the agent**
```powershell
Remove-Item vault\agent_config.json
Remove-Item vault\fleet_config.json
npm start
```
The wizard will run again on next launch.
