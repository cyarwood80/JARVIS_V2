# JARVIS V2

**JARVIS V2** is a hybrid AI agent architecture that combines the power of cloud reasoning (via Google Gemini) with the privacy and execution capabilities of a local AI fleet (via Ollama).

It acts as an autonomous assistant capable of executing scripts, managing local memory, running headless browsing tasks, and orchestrating a local fleet of specialized LLMs—all controlled from an Electron desktop application or via WhatsApp (using the OpenClaw Gateway).

## Key Features

- **Hybrid Orchestration**: Uses a fast cloud model (Gemini 2.5 Flash) as a "Librarian" to route tasks to specialized local models.
- **Local AI Fleet**: Automatically provisions and manages local Ollama models tailored to your hardware (e.g., `planner`, `synthesiser`, `chat`).
- **Persistent Local Memory**: Features a long-term memory vault and RAG (Retrieval-Augmented Generation) system. Memories are stored locally, continuously consolidated offline, and never sent to the cloud.
- **Automation & Tool Execution**: Executes Python/PowerShell scripts, controls browsers, and searches the web autonomously.
- **WhatsApp Gateway (OpenClaw)**: A built-in traffic master for routing WhatsApp messages to the local agent.
- **Desktop UI**: A React-like dashboard built on Electron for real-time system telemetry, agent communication, and model warmth tracking.

## Getting Started

Please see the [SETUP.md](./SETUP.md) for full prerequisites and an onboarding guide.

### Quick Start
1. Ensure Node.js and Ollama are installed.
2. Run the automated setup script in PowerShell:
   ```powershell
   .\setup.ps1
   ```
3. Start the Agent:
   ```bash
   npm start
   ```

## Architecture

- `src/api/` - Express HTTP + WebSocket server
- `src/orchestrator/` - Gemini cloud router
- `src/fleet/` - Local Ollama model management
- `src/memory/` - Long-term memory & RAG
- `src/tools/` - Tool executor
- `src/gateway/openclaw/` - WhatsApp gateway
- `src/desktop/` - Electron entry point
- `public/` - Frontend dashboard
- `vault/` - Persistent local data (config, memory, conversations)

## License
MIT License
