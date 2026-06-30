# Usage Guide

This guide covers how to interact with and manage JARVIS V2.

## Starting JARVIS

JARVIS is built as a Node.js backend with an Electron frontend. To start the entire application:

```bash
npm start
```
This launches the backend API on `http://localhost:3000` and opens the Electron dashboard.

## The Dashboard UI

The main interface is split into several tabs located on the left sidebar:

1. **Terminal**: The main chat interface where you interact with JARVIS. You can type instructions, ask questions, or request script execution.
2. **System Health**: Displays live system metrics (CPU, RAM, Uptime) and tracks the token usage between the Cloud models and your Local fleet.
3. **Model Fleet**: Shows you which Ollama models are currently loaded into memory, their assigned roles (reasoning, coding, etc.), and their "warmth" (if they are ready for instant inference).
4. **OpenClaw Gateway**: Connect your WhatsApp account via QR code so you can chat with JARVIS from your phone.
5. **Automation Vault**: A visual grid of all the scripts JARVIS has written and saved. You can see what tools JARVIS currently knows how to use.
6. **Active Daemons**: Manage background tasks. If you ask JARVIS to "monitor X continuously", it will spawn a background Daemon. Here you can see running tasks, read their live terminal output, and kill them if necessary.
7. **Capabilities**: A list of native tools JARVIS can access (web search, desktop notifications, etc.).
8. **Settings**: Configure your Cloud API Keys and select your preferred cloud reasoning model.

## Interacting with JARVIS

You can speak to JARVIS naturally. Depending on what you ask, it will automatically route to the right capability:

- **General Knowledge**: "What is the capital of France?" (Routes to a fast, general local model).
- **Coding**: "Write a python script that plays snake." (Routes to your local coding model, saves the script to the vault).
- **Execution**: "Run the snake game." (JARVIS will find the script in the vault and execute it).
- **Background Tasks**: "Write a PowerShell script that prints the date every 5 seconds, and run it proactively in the background." (JARVIS will write the script, save it, and launch it as a Daemon. You can view the output in the Daemons tab).
- **Multi-Agent Mode**: "Research the history of the iPhone, write a 3 paragraph summary, and send it to me on WhatsApp." (Triggers the multi-agent swarm to handle the pipeline).

## Viewing Cloud Logs

If you want to see exactly how the Cloud Librarian is interpreting your prompts, check the `vault/cloud_logs/` directory on your hard drive. 
Every time the Orchestrator makes a routing decision or the Planner decomposes a task, the raw JSON is saved here with a timestamp.
