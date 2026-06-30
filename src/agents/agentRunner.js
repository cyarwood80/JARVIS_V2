/**
 * Agent Runner
 * ------------
 * Runs a single specialist agent to completion using a ReAct loop:
 *   Reason → Act → Observe → Reason → ... → Finish
 *
 * All reasoning and execution is LOCAL (Ollama). No cloud calls happen here.
 * Gemini is only used by the Planner (upstream) to decompose goals.
 *
 * The agent loop:
 *  1. Feed the goal + history + available tools to the local model
 *  2. Model outputs a JSON "thought" with either an action or a finish signal
 *  3. If action: execute via ToolRegistry, append observation, loop
 *  4. If finish: return the final answer
 *  5. Max turns enforced to prevent infinite loops
 *
 * Emits progress events to broadcastMsg for live UI streaming.
 */

import { runLocalModel, getBestLocalModel } from '../fleet/index.js';
import { toolRegistry } from '../gateway/toolRegistry.js';

const MAX_TURNS = 8;

/**
 * Run a specialist agent for a single task.
 *
 * @param {object} task        - Task descriptor from the Planner
 *   task.id          {string}   - Unique task ID
 *   task.agent       {string}   - Agent role name (e.g. 'researcher', 'coder')
 *   task.instruction {string}   - The specific goal for this agent
 *   task.tools       {string[]} - Tool names this agent is allowed to use
 *   task.context     {string}   - Optional: output from a dependency task
 * @param {string}   agentName  - Jarvis name for system prompt
 * @param {function} broadcastMsg - WebSocket broadcast fn
 *
 * @returns {Promise<string>} The agent's final output
 */
export async function runAgent(task, agentName, broadcastMsg = null) {
    const model = getBestLocalModel(task.agent === 'coder' ? 'coding' : 'reasoning');
    const history = [];
    let turn = 0;

    const emit = (msg) => {
        if (broadcastMsg) broadcastMsg({ type: 'agent_update', taskId: task.id, agent: task.agent, message: msg });
    };

    emit(`Agent [${task.agent}] started on task: "${task.instruction.slice(0, 80)}..."`);

    // Build the allowed tools description for the system prompt
    const allTools = toolRegistry.getAllTools();
    const allowedToolDefs = [
        ...allTools.native.filter(t => task.tools.includes(t.name)),
        ...allTools.gateway.filter(t => task.tools.includes(t.name)),
        ...allTools.vault.filter(t => task.tools.includes(t.name))
    ];

    const toolsDescription = allowedToolDefs.length > 0
        ? '\nAvailable tools:\n' + allowedToolDefs.map(t =>
            `  - ${t.name}: ${t.description || t.name}`
          ).join('\n')
        : '\nNo tools available — respond only from knowledge.';

    const contextSection = task.context
        ? `\n\nContext from previous agents:\n${task.context}\n`
        : '';

    const SYSTEM_PROMPT = `You are ${agentName} acting as a specialist [${task.agent}] agent. You are one step in an autonomous multi-agent pipeline.

Your ONLY goal: ${task.instruction}
${contextSection}
You operate in a ReAct loop. On each turn, output ONLY valid JSON:

If you need to use a tool:
{ "thought": "Why you need this tool", "action": "tool_name", "args": { "key": "value" } }

If you have enough information to finish:
{ "thought": "Why I'm done", "action": "finish", "result": "Your complete answer or output" }
${toolsDescription}

Rules:
- ALWAYS respond with JSON only. No markdown, no prose outside JSON.
- Use "finish" as soon as you have a complete answer. Do not loop unnecessarily.
- If a tool fails, try an alternative or finish with what you have.
- Max ${MAX_TURNS} turns — if you reach the limit, finish immediately.`;

    while (turn < MAX_TURNS) {
        turn++;
        emit(`Turn ${turn}/${MAX_TURNS} — thinking...`);

        let rawOutput;
        try {
            rawOutput = await runLocalModel(model, [
                ...history,
                { role: 'user', content: turn === 1 ? task.instruction : 'Continue.' }
            ], SYSTEM_PROMPT);
        } catch (e) {
            emit(`Model error on turn ${turn}: ${e.message}`);
            break;
        }

        // Parse the JSON thought
        let thought;
        try {
            const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
            thought = JSON.parse(jsonMatch ? jsonMatch[0] : rawOutput);
        } catch {
            // Model didn't output valid JSON — treat raw output as finish
            emit(`Agent [${task.agent}] produced non-JSON output — treating as final answer.`);
            return rawOutput;
        }

        if (thought.action === 'finish') {
            emit(`Agent [${task.agent}] finished.`);
            return thought.result || rawOutput;
        }

        // Execute the tool action
        const toolName = thought.action;
        const toolArgs = thought.args || {};
        emit(`Calling tool: ${toolName}`);

        let observation;
        try {
            observation = await toolRegistry.executeTool(toolName, toolArgs, [], broadcastMsg);
        } catch (e) {
            observation = `Tool '${toolName}' failed: ${e.message}`;
        }

        emit(`Tool result: ${String(observation).slice(0, 120)}...`);

        // Add to history so the model has full context
        history.push({ role: 'user',      content: task.instruction });
        history.push({ role: 'assistant', content: rawOutput });
        history.push({ role: 'user',      content: `Tool observation: ${observation}` });
    }

    // Hit max turns — do a final synthesis pass
    emit(`Agent [${task.agent}] hit max turns — synthesising final answer.`);
    const synthPrompt = `Based on your work so far, provide a final, concise answer to: "${task.instruction}". 
History:\n${history.map(m => `${m.role}: ${m.content}`).join('\n')}
Output ONLY the final answer text, no JSON.`;

    const finalAnswer = await runLocalModel(model, [{ role: 'user', content: synthPrompt }]);
    return finalAnswer;
}
