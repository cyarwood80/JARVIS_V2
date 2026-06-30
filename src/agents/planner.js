/**
 * Planner
 * -------
 * Uses Gemini (cloud reasoning) to decompose a user goal into a TaskPlan —
 * a directed graph of specialist sub-tasks that the Supervisor will execute.
 *
 * This embodies the "cloud reasoning, local execution" principle:
 *  - Gemini provides the intelligence to understand the goal and split it cleanly
 *  - Every task in the plan will be executed by local Ollama models via AgentRunner
 *  - No user data / execution context is sent to Gemini — only the task description
 *
 * The Planner also determines whether a goal warrants multi-agent handling at all.
 * Simple requests (single action, no dependencies) are returned as single-task plans
 * and handled by the existing Orchestrator flow.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { GEMINI_API_KEY, CLOUD_MODEL, AGENT_NAME, ROOT_DIR } from '../../config/index.js';
import { toolRegistry } from '../gateway/toolRegistry.js';
import fs from 'fs/promises';
import path from 'path';

const PLANNER_SCHEMA_EXAMPLE = `{
  "isMultiAgent": true,
  "goal": "Search the web for top AI tools and send me a WhatsApp summary",
  "tasks": [
    {
      "id": "t1",
      "agent": "researcher",
      "instruction": "Search the web for the top 5 AI productivity tools in 2025. Return a bullet-point list with names and one-sentence descriptions.",
      "tools": ["search_web"],
      "dependsOn": []
    },
    {
      "id": "t2",
      "agent": "messenger",
      "instruction": "Format the research results as a concise WhatsApp message and send it to the user.",
      "tools": ["whatsapp_send"],
      "dependsOn": ["t1"]
    }
  ]
}`;

function buildPlannerPrompt(availableTools) {
    const toolList = [
        ...availableTools.native.map(t => `${t.name}: ${t.description}`),
        ...availableTools.gateway.map(t => `${t.name} [gateway]: ${t.description}`),
        ...availableTools.vault.map(t => `${t.name} [vault script]: ${t.description}`)
    ].join('\n  - ');

    return `You are the strategic Planner for ${AGENT_NAME}, an autonomous AI agent system.

Your job: Analyse the user's goal and decide whether it needs multiple specialist agents working in sequence/parallel, or if it is simple enough for a single agent response.

Available tools:
  - ${toolList}

Respond ONLY with a JSON TaskPlan matching this EXACT schema:

For a SIMPLE request (single step, no tool needed or just one action):
{ "isMultiAgent": false, "goal": "...", "tasks": [ { "id": "t1", "agent": "general", "instruction": "...", "tools": [], "dependsOn": [] } ] }

For a COMPLEX request requiring multiple agents:
${PLANNER_SCHEMA_EXAMPLE}

Rules:
- "isMultiAgent" must be true ONLY if there are 2+ tasks with real dependencies or parallelism
- agent roles: "researcher" (web search, analysis), "coder" (scripts, code), "messenger" (notifications, WhatsApp), "general" (conversation, Q&A), "executor" (system commands, scripts)
- "tools" array must only contain tool names from the available list above
- "dependsOn" is a list of task IDs that must complete before this task starts
- Keep plans simple — 2 or 3 tasks maximum unless absolutely necessary
- Do NOT include reasoning outside the JSON`;
}

export class Planner {
    constructor() {
        this.genAI = null;
        this.model = null; // lazily initialized
    }

    _ensureModel() {
        if (!GEMINI_API_KEY) throw new Error("Gemini API key is missing. Please add it in Settings.");
        if (!this.genAI) {
            this.genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        }
        if (!this.model) {
            this.model = this.genAI.getGenerativeModel({
                model: CLOUD_MODEL,
                systemInstruction: { parts: [{ text: buildPlannerPrompt(toolRegistry.getAllTools()) }] }
            });
        }
    }

    /**
     * Decompose a user goal into a TaskPlan.
     * @param {string} userGoal - The user's request
     * @returns {Promise<object>} TaskPlan { isMultiAgent, goal, tasks }
     */
    async decompose(userGoal) {
        this._ensureModel();
        let result;
        try {
            result = await this.model.generateContent({
                contents: [{ role: 'user', parts: [{ text: userGoal }] }]
            });
        } catch (e) {
            console.error('[PLANNER] Gemini error, falling back to single-agent:', e.message);
            return this._singleTaskFallback(userGoal);
        }

        let plan;
        try {
            const text = result.response.text();
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            plan = JSON.parse(jsonMatch ? jsonMatch[0] : text);
            
            try {
                const logDir = path.join(ROOT_DIR, 'vault', 'cloud_logs');
                await fs.mkdir(logDir, { recursive: true });
                const fileName = `planner_${Date.now()}.json`;
                await fs.writeFile(path.join(logDir, fileName), JSON.stringify(plan, null, 2), 'utf8');
            } catch (err) {
                console.error("[PLANNER] Failed to write Planner JSON to disk:", err);
            }
        } catch (e) {
            console.error('[PLANNER] Failed to parse TaskPlan JSON:', e.message);
            return this._singleTaskFallback(userGoal);
        }

        // Validate plan structure
        if (!plan.tasks || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
            return this._singleTaskFallback(userGoal);
        }

        console.log(`[PLANNER] Decomposed into ${plan.tasks.length} task(s). isMultiAgent: ${plan.isMultiAgent}`);
        return plan;
    }

    /**
     * Fallback: single-task general agent plan when decomposition fails.
     */
    _singleTaskFallback(userGoal) {
        return {
            isMultiAgent: false,
            goal: userGoal,
            tasks: [{
                id: 't1',
                agent: 'general',
                instruction: userGoal,
                tools: ['search_web', 'reply_to_user'],
                dependsOn: []
            }]
        };
    }
}

// Singleton
export const planner = new Planner();
