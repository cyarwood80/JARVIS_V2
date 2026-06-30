import { GoogleGenerativeAI } from '@google/generative-ai';
import { GEMINI_API_KEY, CLOUD_MODEL, AGENT_NAME, METRICS, updatePublicTokens, ROOT_DIR } from '../../config/index.js';
import fs from 'fs/promises';
import path from 'path';
import { runLocalModel, getBestLocalModel } from '../fleet/index.js';
import { toolRegistry } from '../gateway/toolRegistry.js';
import { executeTool } from '../tools/executor.js';
import { getCoreMemory, updateInteractionTime } from '../memory/index.js';
import { getVaultContextString } from '../vault/vaultIndex.js';
import { planner } from '../agents/planner.js';
import { executePlan } from '../agents/supervisor.js';

// Build the orchestrator routing prompt dynamically.
// Includes the full vault context so Jarvis knows what scripts exist.
async function buildOrchestratorPrompt() {
    const vaultContext = await getVaultContextString();

    // Build action list from live tool registry
    const { native, gateway, vault } = toolRegistry.getAllTools();
    const gatewayActionNames = gateway.map(t => t.name).join(' | ');
    const vaultScriptNote = vault.length > 0
        ? `\nVault scripts (run via run_saved_script or run_daemon_script): ${vault.map(v => v.name).join(', ')}`
        : '';

    return `You are the Head Librarian for ${AGENT_NAME}. Your job is NOT to execute tasks or generate code yourself.
Your job is purely routing. You must read the user's request and decide which local model capability should handle it, and what exact instructions to give it.

You must ALWAYS respond in valid JSON format matching this schema exactly:
{
  "capability": "coding" | "reasoning" | "os" | "general",
  "instruction": "The explicit, detailed instruction for the local model to follow to achieve the user's goal",
  "action": "save_script" | "execute_command" | "run_saved_script" | "run_daemon_script" | "browser_open" | "browser_click" | "browser_type" | "browser_extract" | "browser_close" | "search_web" | "reply_to_user" | "whatsapp_send" | "whatsapp_status" | "desktop_notify" | "get_vault_index" | "manage_memory" | "spawn_agents",
  "actionArgs": { "any": "arguments needed for the action, e.g. scriptName, url, selector, text, query" }
}

Example 1: User asks for a python script to calculate pi.
{
  "capability": "coding",
  "instruction": "Write a Python script to calculate pi. Output ONLY the raw Python code, with no markdown formatting or conversational text.",
  "action": "save_script",
  "actionArgs": { "scriptName": "calc_pi.py" }
}

Example 2: User says 'hello' or asks a general question.
{
  "capability": "general",
  "instruction": "The user said 'hello'. Respond naturally and concisely.",
  "action": "reply_to_user",
  "actionArgs": {}
}

Example 3: User wants to search for 'SpaceX news'.
{
  "capability": "reasoning",
  "instruction": "The user wants to search for 'SpaceX news'. We will use the search tool.",
  "action": "search_web",
  "actionArgs": { "query": "SpaceX news" }
}

Example 4: User says "run the downloads monitor" and MonitorDownloads.ps1 exists in the vault.
{
  "capability": "os",
  "instruction": "Run the saved MonitorDownloads.ps1 script from the Automation Vault.",
  "action": "run_saved_script", // or "run_daemon_script" if it needs to run proactively/continuously
  "actionArgs": { "scriptName": "MonitorDownloads.ps1" }
}

Example 5: User asks for something complex requiring multiple steps (research + notify, write + send, etc.)
{
  "capability": "reasoning",
  "instruction": "The user wants to research AI tools and send results via WhatsApp. This requires multi-agent handling.",
  "action": "spawn_agents",
  "actionArgs": { "goal": "Research the top 5 AI tools and send a WhatsApp summary to the user" }
}

Use "spawn_agents" when the request clearly involves 2+ distinct steps that could benefit from specialist agents (e.g., research then notify, analyse then report, search then send).
Use "run_saved_script" instead of "save_script" when a matching vault script already exists.
12. Use "run_daemon_script" for tasks that require continuous monitoring, infinite loops, or proactive background execution.
13. Always format your output as a single JSON object. No markdown wrappers around the JSON.
${vaultScriptNote}
${vaultContext}`;
}

export class Orchestrator {
    constructor() {
        this._model = null; // lazily built after vault is loaded
    }

    async _getModel() {
        if (!GEMINI_API_KEY) throw new Error("Gemini API key is missing. Please add it in Settings.");
        if (!this.genAI) {
            this.genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        }
        if (!this._model) {
            this._model = this.genAI.getGenerativeModel({
                model: CLOUD_MODEL,
                systemInstruction: { parts: [{ text: await buildOrchestratorPrompt() }] }
            });
        }
        return this._model;
    }

    /** Invalidate cached model so it rebuilds with fresh vault context on next call */
    invalidateModel() {
        this._model = null;
        this.genAI = null; // Also clear genAI to pick up potential key changes
    }

    async processIntent(userMessage, chatHistory = [], broadcastMsg) {
        // Format history for Gemini
        const history = [];
        let expectedRole = 'user';
        for (const m of chatHistory) {
            const mappedRole = m.role === 'assistant' ? 'model' : 'user';
            if (mappedRole === expectedRole) {
                history.push({ role: mappedRole, parts: [{ text: m.content }] });
                expectedRole = mappedRole === 'user' ? 'model' : 'user';
            } else if (history.length > 0) {
                history[history.length - 1].parts[0].text += `\n\n${m.content}`;
            }
        }

        const contents = [ ...history, { role: "user", parts: [{ text: userMessage }] } ];
        let result = null;
        let retries = 3;
        for (let i = 0; i < retries; i++) {
            try {
                const model = await this._getModel();
                result = await model.generateContent({ contents });
                break;
            } catch (e) {
                if (i === retries - 1 || (!e.message.includes('503') && !e.message.includes('429'))) throw e;
                if (broadcastMsg) broadcastMsg({ type: 'status', stage: 'thinking', message: `Gemini API overloaded. Retrying (${i + 1}/${retries})...` });
                await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
            }
        }

        const response = result.response;

        if (!response.candidates || response.candidates.length === 0) {
            return { text: "My response was blocked by safety filters or failed to generate.", modelUsed: CLOUD_MODEL };
        }

        if (response.usageMetadata && response.usageMetadata.totalTokenCount) {
            updatePublicTokens(response.usageMetadata.totalTokenCount);
        }

        let routingPlan = null;
        try {
            const text = response.text();
            let jsonStr = text;
            const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (jsonMatch) jsonStr = jsonMatch[1];
            routingPlan = JSON.parse(jsonStr.trim());
            
            // ── Save to File System for Inspection ──
            try {
                const logDir = path.join(ROOT_DIR, 'vault', 'cloud_logs');
                await fs.mkdir(logDir, { recursive: true });
                const fileName = `orchestrator_${Date.now()}.json`;
                await fs.writeFile(path.join(logDir, fileName), JSON.stringify(routingPlan, null, 2), 'utf8');
            } catch (err) {
                console.error("Failed to write Orchestrator JSON to disk:", err);
            }
            
        } catch (e) {
            console.error("Failed to parse Librarian JSON:", e, response.text());
            routingPlan = {
                capability: "reasoning",
                instruction: userMessage,
                action: "reply_to_user",
                actionArgs: {}
            };
        }

        if (broadcastMsg) broadcastMsg({ type: 'status', stage: 'routing', message: `Librarian routed to [${routingPlan.capability}] fleet for action [${routingPlan.action}]` });

        // ── SPAWN AGENTS path ────────────────────────────────────────────────
        if (routingPlan.action === 'spawn_agents') {
            if (broadcastMsg) broadcastMsg({ type: 'status', stage: 'planning', message: `Planner decomposing goal into multi-agent task plan...` });

            const goal = routingPlan.actionArgs?.goal || userMessage;
            const taskPlan = await planner.decompose(goal);

            if (!taskPlan.isMultiAgent || taskPlan.tasks.length <= 1) {
                // Planner decided single-agent is fine — fall through to normal flow
                routingPlan.action = 'reply_to_user';
            } else {
                if (broadcastMsg) broadcastMsg({ type: 'status', stage: 'executing', message: `Supervisor launching ${taskPlan.tasks.length} agents...` });
                const finalAnswer = await executePlan(taskPlan, AGENT_NAME, broadcastMsg);
                return { text: finalAnswer, modelUsed: 'multi-agent-local' };
            }
        }

        // ── STANDARD single-agent path ────────────────────────────────────────
        await new Promise(resolve => setTimeout(resolve, 1500));

        const localModel = getBestLocalModel(routingPlan.capability);

        if (broadcastMsg) broadcastMsg({ type: 'status', stage: 'generating', message: `Reasoning via Local Fleet (${localModel})...` });

        updateInteractionTime();
        const coreMemory = await getCoreMemory(chatHistory);

        let localSystemPrompt = `You are ${AGENT_NAME}, a highly capable AI agent running locally on the user's machine.

You have the following capabilities:
- **Local Long-Term Memory**: You store and recall facts about the user and past conversations in a local vault file. This memory persists across sessions.
- **RAG (Retrieval-Augmented Generation)**: You have a semantic vector memory store that automatically retrieves relevant past memories based on the current conversation.
- **Offline Memory Consolidation**: While idle, you automatically consolidate and clean your memory vault using a local AI model — no cloud required.
- **Local AI Fleet**: You run via a fleet of local Ollama models for full privacy and offline operation.
- **Tool Execution**: You can run scripts, execute OS commands, search the web, and control a browser.
- **Automation Vault**: You save and re-use scripts. If a script exists in the vault, you prefer to run it rather than rewrite it.
- **OpenClaw Gateway**: You can send WhatsApp messages via the OpenClaw local gateway.
- **Autonomous Agents**: For complex multi-step goals, you spawn specialist sub-agents (researcher, coder, messenger) that work in parallel.

When asked about your capabilities or memory, always confidently describe these features.${coreMemory}`;

        if (routingPlan.action === 'save_script' || routingPlan.action === 'execute_command') {
            localSystemPrompt = "You must output ONLY raw code. Do not include markdown formatting like ```python or ```powershell. Do not include conversational text.";
        }

        const localOutput = await runLocalModel(localModel, [{ role: 'user', content: routingPlan.instruction }], localSystemPrompt);

        if (routingPlan.action === 'reply_to_user') {
            return { text: localOutput, modelUsed: localModel };
        } else {
            if (broadcastMsg) broadcastMsg({ type: 'status', stage: 'executing', message: `Executing action ${routingPlan.action}...` });

            let args = { ...routingPlan.actionArgs };
            if (routingPlan.action === 'save_script') {
                args.code = localOutput.trim().replace(/^```[a-z]*\n/, '').replace(/```$/, '').trim();
                // Invalidate cached model so vault context rebuilds with new script
                this.invalidateModel();
            } else if (routingPlan.action === 'execute_command') {
                args.command = localOutput.trim().replace(/^```[a-z]*\n/, '').replace(/```$/, '').trim();
            }

            const toolOutput = await toolRegistry.executeTool(routingPlan.action, args, chatHistory, broadcastMsg);

            if (broadcastMsg) broadcastMsg({ type: 'status', stage: 'synthesising', message: `Synthesizing final output...` });
            const synthPrompt = `You executed an action: ${routingPlan.action}. Here is the result:\n${toolOutput}\n\nWrite a concise response to the user summarizing this. Do not show the raw code unless asked.`;
            const finalResponse = await runLocalModel(localModel, [{ role: 'user', content: synthPrompt }]);

            return { text: finalResponse, modelUsed: localModel };
        }
    }

    async processIntentLocalFirst(userMessage, chatHistory = [], broadcastMsg = null) {
        if (broadcastMsg) broadcastMsg({ type: 'status', stage: 'thinking', message: `Local Fleet analyzing follow-up intent...` });

        updateInteractionTime();
        const localModel = getBestLocalModel('reasoning');
        const coreMemory = await getCoreMemory(chatHistory);
        const vaultContext = await getVaultContextString();

        const historyText = chatHistory.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
        const prompt = `You are ${AGENT_NAME}, a local routing agent. The user is asking a follow-up question.
If you can directly answer the question or perform the action yourself, output a JSON routing map.
If the question is extremely complex and requires Google Gemini to analyze it, output exactly {"action": "escalate_to_cloud"}.

Output ONLY JSON in this format:
{
  "capability": "reasoning" or "coding" or "research",
  "instruction": "The exact instruction you need to process to fulfill the request",
  "action": "reply_to_user" or "execute_command" or "save_script" or "search_web" or "run_saved_script" or "run_daemon_script" or "spawn_agents",
  "actionArgs": { "command": "...", "query": "...", "scriptName": "..." }
}
${vaultContext}

Recent Chat History:
${historyText}

User Follow-Up: ${userMessage}
`;

        const localOutput = await runLocalModel(localModel, [{ role: 'user', content: prompt }]);

        let routingPlan;
        try {
            const jsonMatch = localOutput.match(/\{[\s\S]*\}/);
            const jsonStr = jsonMatch ? jsonMatch[0] : localOutput;
            routingPlan = JSON.parse(jsonStr.trim());
        } catch (e) {
            console.error("Local routing failed parsing, escalating to cloud.");
            routingPlan = { action: 'escalate_to_cloud' };
        }

        if (routingPlan.action === 'escalate_to_cloud') {
            if (broadcastMsg) broadcastMsg({ type: 'status', stage: 'thinking', message: `Local routing escalated to Cloud Orchestrator...` });
            return this.processIntent(userMessage, chatHistory, broadcastMsg);
        }

        // Handle spawn_agents locally-initiated plan
        if (routingPlan.action === 'spawn_agents') {
            if (broadcastMsg) broadcastMsg({ type: 'status', stage: 'planning', message: `Escalating multi-agent goal to Cloud Planner...` });
            return this.processIntent(userMessage, chatHistory, broadcastMsg);
        }

        if (broadcastMsg) broadcastMsg({ type: 'status', stage: 'routing', message: `Local Fleet self-routed to [${routingPlan.capability}] for action [${routingPlan.action}]` });

        await new Promise(resolve => setTimeout(resolve, 1500));

        const targetModel = getBestLocalModel(routingPlan.capability);

        if (broadcastMsg) broadcastMsg({ type: 'status', stage: 'generating', message: `Reasoning via Local Fleet (${targetModel})...` });

        const SYSTEM_PROMPT = `You are ${AGENT_NAME}, a highly capable AI agent running locally on the user's machine.

You have the following capabilities:
- **Local Long-Term Memory**: You store and recall facts about the user and past conversations in a local vault file. This memory persists across sessions and is never sent to the cloud.
- **RAG (Retrieval-Augmented Generation)**: You have a semantic vector memory store. Relevant past memories are automatically retrieved and injected into your context based on the current conversation.
- **Offline Memory Consolidation**: While you are idle, you automatically consolidate and clean your memory vault using a local AI model — fully offline, no cloud required.
- **Local AI Fleet**: You run via a fleet of local Ollama models for full privacy and offline capability.
- **Tool Execution**: You can run PowerShell/Python scripts, execute OS commands, search the web, and control a browser.
- **Automation Vault**: You save and re-use scripts. Check the vault before writing new code.
- **OpenClaw Gateway**: You can send WhatsApp messages to the user proactively.
- **Autonomous Agents**: For complex multi-step goals, you spawn specialist agents working in parallel.

When asked about your capabilities or memory, always confidently describe these features. You always aim to be helpful, concise, and accurate.${coreMemory}`;

        const finalOutput = await runLocalModel(targetModel, [{ role: 'user', content: routingPlan.instruction }], SYSTEM_PROMPT);

        if (routingPlan.action === 'reply_to_user') {
            return { text: finalOutput, modelUsed: targetModel };
        } else {
            if (broadcastMsg) broadcastMsg({ type: 'status', stage: 'executing', message: `Executing action ${routingPlan.action}...` });

            let args = { ...routingPlan.actionArgs };
            if (routingPlan.action === 'save_script') {
                args.code = finalOutput.trim().replace(/^```[a-z]*\n/, '').replace(/```$/, '').trim();
                this.invalidateModel(); // Rebuild prompt with new vault entry
            } else if (routingPlan.action === 'execute_command') {
                args.command = finalOutput.trim().replace(/^```[a-z]*\n/, '').replace(/```$/, '').trim();
            }

            const toolOutput = await toolRegistry.executeTool(routingPlan.action, args, chatHistory, broadcastMsg);

            if (broadcastMsg) broadcastMsg({ type: 'status', stage: 'synthesising', message: `Synthesizing final output...` });
            const synthPrompt = `You executed an action: ${routingPlan.action}. Here is the result:\n${toolOutput}\n\nWrite a concise response to the user summarizing this.`;
            const finalResponse = await runLocalModel(targetModel, [{ role: 'user', content: synthPrompt }]);

            return { text: finalResponse, modelUsed: targetModel };
        }
    }
}
