import { GoogleGenerativeAI } from '@google/generative-ai';
import { GEMINI_API_KEY, AGENT_NAME, METRICS, updatePublicTokens } from '../../config/index.js';
import { runLocalModel, getBestLocalModel } from '../fleet/index.js';
import { executeTool } from '../tools/executor.js';
import { getCoreMemory, updateInteractionTime } from '../memory/index.js';

// Build the orchestrator system prompt dynamically so it uses the configured agent name.
function buildOrchestratorPrompt() {
    return `You are the Head Librarian for ${AGENT_NAME}. Your job is NOT to execute tasks or generate code yourself. 
Your job is purely routing. You must read the user's request and decide which local model capability should handle it, and what exact instructions to give it.

You must ALWAYS respond in valid JSON format matching this schema exactly:
{
  "capability": "coding" | "reasoning" | "os" | "general",
  "instruction": "The explicit, detailed instruction for the local model to follow to achieve the user's goal",
  "action": "save_script" | "execute_command" | "browser_open" | "browser_click" | "browser_type" | "browser_extract" | "browser_close" | "search_web" | "reply_to_user",
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
}`;
}

export class Orchestrator {
    constructor() {
        if (!GEMINI_API_KEY) throw new Error("Gemini API key is required for Orchestrator.");
        this.genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        // We use gemini-2.5-flash for fast intent parsing and routing
        this.model = this.genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash",
            systemInstruction: { parts: [{ text: buildOrchestratorPrompt() }] }
        });
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
                result = await this.model.generateContent({ contents });
                break;
            } catch (e) {
                if (i === retries - 1 || (!e.message.includes('503') && !e.message.includes('429'))) throw e;
                if (broadcastMsg) broadcastMsg({ type: 'status', stage: 'thinking', message: `Gemini API overloaded. Retrying (${i + 1}/${retries})...` });
                await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1))); // exponential backoff
            }
        }
        
        const response = result.response;
        
        // Safety check for empty/blocked responses
        if (!response.candidates || response.candidates.length === 0) {
            return { text: "My response was blocked by safety filters or failed to generate.", modelUsed: "gemini-2.5-flash" };
        }

        if (response.usageMetadata && response.usageMetadata.totalTokenCount) {
            updatePublicTokens(response.usageMetadata.totalTokenCount);
        }
        
        let routingPlan = null;
        try {
            const text = response.text();
            // Extract json block if wrapped in markdown
            let jsonStr = text;
            const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (jsonMatch) jsonStr = jsonMatch[1];
            
            routingPlan = JSON.parse(jsonStr.trim());
        } catch (e) {
            console.error("Failed to parse Librarian JSON:", e, response.text());
            // Fallback to general reasoning
            routingPlan = {
                capability: "reasoning",
                instruction: userMessage,
                action: "reply_to_user",
                actionArgs: {}
            };
        }

        if (broadcastMsg) broadcastMsg({ type: 'status', stage: 'routing', message: `Librarian routed to [${routingPlan.capability}] fleet for action [${routingPlan.action}]` });
        
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

When asked about your capabilities or memory, always confidently describe these features.${coreMemory}`;

        if (routingPlan.action === 'save_script' || routingPlan.action === 'execute_command') {
            localSystemPrompt = "You must output ONLY raw code. Do not include markdown formatting like ```python or ```powershell. Do not include conversational text.";
        }
        
        // Pass the Librarian's instruction to the Local Fleet
        const localOutput = await runLocalModel(localModel, [{ role: 'user', content: routingPlan.instruction }], localSystemPrompt);
        
        if (routingPlan.action === 'reply_to_user') {
            return { text: localOutput, modelUsed: localModel };
        } else {
            // Execute the action with the local model's output
            if (broadcastMsg) broadcastMsg({ type: 'status', stage: 'executing', message: `Executing action ${routingPlan.action}...` });
            
            let args = { ...routingPlan.actionArgs };
            if (routingPlan.action === 'save_script') {
                args.code = localOutput.trim();
                // Ensure it doesn't wrap in markdown again
                args.code = args.code.replace(/^```[a-z]*\n/, '').replace(/```$/, '').trim();
            } else if (routingPlan.action === 'execute_command') {
                args.command = localOutput.trim();
                args.command = args.command.replace(/^```[a-z]*\n/, '').replace(/```$/, '').trim();
            }
            
            const toolOutput = await executeTool(routingPlan.action, args, chatHistory, broadcastMsg);
            
            // Final synthesis of what happened
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
        
        const historyText = chatHistory.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
        const prompt = `You are ${AGENT_NAME}, a local routing agent. The user is asking a follow-up question.
If you can directly answer the question or perform the action yourself, output a JSON routing map.
If the question is extremely complex and requires Google Gemini to analyze it, output exactly {"action": "escalate_to_cloud"}.

Output ONLY JSON in this format:
{
  "capability": "reasoning" or "coding" or "research",
  "instruction": "The exact instruction you need to process to fulfill the request",
  "action": "reply_to_user" or "execute_command" or "save_script" or "search_web",
  "actionArgs": { "command": "...", "query": "..." }
}

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
            if (broadcastMsg) broadcastMsg({ type: 'status', stage: 'thinking', message: `Local routing failed or escalated. Handing off to Cloud...` });
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

When asked about your capabilities or memory, always confidently describe these features. You always aim to be helpful, concise, and accurate.${coreMemory}`;
        
        const finalOutput = await runLocalModel(targetModel, [{ role: 'user', content: routingPlan.instruction }], SYSTEM_PROMPT);
        
        if (routingPlan.action === 'reply_to_user') {
            return { text: finalOutput, modelUsed: targetModel };
        } else {
            if (broadcastMsg) broadcastMsg({ type: 'status', stage: 'executing', message: `Executing action ${routingPlan.action}...` });
            
            let args = { ...routingPlan.actionArgs };
            if (routingPlan.action === 'save_script') {
                args.code = finalOutput.trim().replace(/^```[a-z]*\n/, '').replace(/```$/, '').trim();
            } else if (routingPlan.action === 'execute_command') {
                args.command = finalOutput.trim().replace(/^```[a-z]*\n/, '').replace(/```$/, '').trim();
            }
            
            const toolOutput = await executeTool(routingPlan.action, args, chatHistory, broadcastMsg);
            
            if (broadcastMsg) broadcastMsg({ type: 'status', stage: 'synthesising', message: `Synthesizing final output...` });
            const synthPrompt = `You executed an action: ${routingPlan.action}. Here is the result:\n${toolOutput}\n\nWrite a concise response to the user summarizing this.`;
            const finalResponse = await runLocalModel(targetModel, [{ role: 'user', content: synthPrompt }]);
            
            return { text: finalResponse, modelUsed: targetModel };
        }
    }
}
