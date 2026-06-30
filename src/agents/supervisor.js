/**
 * Supervisor
 * ----------
 * Executes a TaskPlan produced by the Planner.
 * Manages the lifecycle of all sub-agents: scheduling, dependency resolution,
 * approval gating, and result synthesis.
 *
 * Approval Gate (security model):
 *  - Before any agent executes a tool, the Supervisor checks vault/approved_plans.json
 *  - If the tool is NOT whitelisted, an approval_required event is sent to the UI via WebSocket
 *  - Execution pauses until the user responds (approve / approve_always / deny)
 *  - "approve_always" whitelists the tool name for all future autonomous runs
 *  - Once a tool is whitelisted, it runs autonomously on all subsequent calls
 *
 * Dependency resolution:
 *  - Tasks with empty dependsOn[] run immediately (in parallel via Promise.all)
 *  - Tasks with dependsOn wait until all dependencies resolve
 *  - The output of dependency tasks is injected as "context" into dependent tasks
 *
 * Local execution principle:
 *  - All agent reasoning and tool execution is local (Ollama)
 *  - The Planner uses Gemini but only receives the plain-text goal — no private data
 */

import { runAgent } from './agentRunner.js';
import { toolRegistry, isToolApproved, approveToolForever } from '../gateway/toolRegistry.js';
import { getBestLocalModel, runLocalModel } from '../fleet/index.js';
import { AGENT_NAME } from '../../config/index.js';

// Map of pending approval promises: requestId → { resolve, reject }
const pendingApprovals = new Map();

/**
 * Called by the API server when the user responds to an approval request.
 * @param {string} requestId - The approval request ID
 * @param {string} decision  - 'approve' | 'approve_always' | 'deny'
 */
export function resolveApproval(requestId, decision) {
    const pending = pendingApprovals.get(requestId);
    if (pending) {
        pending.resolve(decision);
        pendingApprovals.delete(requestId);
    }
}

/**
 * Request user approval before running a tool.
 * Returns a promise that resolves when the user responds.
 *
 * @param {string}   toolName     - Name of the tool requesting approval
 * @param {object}   args         - Arguments that will be passed to the tool
 * @param {string}   taskId       - Task ID for UI context
 * @param {string}   agentRole    - Agent role requesting the action
 * @param {function} broadcastMsg - WebSocket broadcast fn
 * @returns {Promise<string>} 'approve' | 'approve_always' | 'deny'
 */
async function requestApproval(toolName, args, taskId, agentRole, broadcastMsg) {
    const requestId = `approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    return new Promise((resolve, reject) => {
        pendingApprovals.set(requestId, { resolve, reject });

        if (broadcastMsg) {
            broadcastMsg({
                type: 'approval_required',
                requestId,
                taskId,
                agent: agentRole,
                toolName,
                args,
                message: `Agent [${agentRole}] wants to call: ${toolName}`,
                description: buildApprovalDescription(toolName, args)
            });
        }

        // 5 minute timeout — deny automatically if user doesn't respond
        setTimeout(() => {
            if (pendingApprovals.has(requestId)) {
                pendingApprovals.delete(requestId);
                resolve('deny');
            }
        }, 5 * 60 * 1000);
    });
}

function buildApprovalDescription(toolName, args) {
    const argSummary = Object.entries(args || {})
        .map(([k, v]) => `${k}: "${String(v).slice(0, 80)}"`)
        .join(', ');
    return `${toolName}(${argSummary})`;
}

/**
 * Wraps tool execution with the approval gate.
 * Checks whitelist first — if approved, runs immediately.
 * If not approved, pauses and waits for user confirmation.
 */
async function executeWithApproval(toolName, args, taskId, agentRole, broadcastMsg) {
    // Skip approval gate for safe read-only tools
    const SAFE_TOOLS = new Set(['search_web', 'get_pc_diagnostics', 'list_scripts', 'get_vault_index', 'reply_to_user']);

    const alreadyApproved = SAFE_TOOLS.has(toolName) || await isToolApproved(toolName);

    if (alreadyApproved) {
        return toolRegistry.executeTool(toolName, args, [], broadcastMsg);
    }

    // Pause and ask the user
    const decision = await requestApproval(toolName, args, taskId, agentRole, broadcastMsg);

    if (decision === 'deny') {
        return `User denied permission to run: ${toolName}`;
    }

    if (decision === 'approve_always') {
        await approveToolForever(toolName);
        if (broadcastMsg) broadcastMsg({ type: 'log', message: `[WHITELIST] ${toolName} approved for autonomous use.` });
    }

    return toolRegistry.executeTool(toolName, args, [], broadcastMsg);
}

/**
 * Execute a full TaskPlan.
 *
 * @param {object}   plan         - TaskPlan from Planner { goal, tasks }
 * @param {string}   agentName    - Agent display name
 * @param {function} broadcastMsg - WebSocket broadcast fn
 * @returns {Promise<string>} Final synthesised response
 */
export async function executePlan(plan, agentName, broadcastMsg = null) {
    const emit = (msg) => {
        if (broadcastMsg) broadcastMsg({ type: 'status', stage: 'autonomous', message: msg });
    };

    emit(`Supervisor initialising plan: "${plan.goal}"`);
    if (broadcastMsg) broadcastMsg({ type: 'plan_started', plan });

    const taskResults = {}; // taskId → string output
    const completed   = new Set();
    const tasks       = [...plan.tasks];

    // Topological execution: keep iterating until all tasks complete
    let maxPasses = tasks.length * 2; // safety cap
    while (completed.size < tasks.length && maxPasses-- > 0) {
        // Find tasks whose dependencies are all satisfied
        const ready = tasks.filter(t =>
            !completed.has(t.id) &&
            t.dependsOn.every(dep => completed.has(dep))
        );

        if (ready.length === 0) break; // No progress possible — circular dep or all done

        // Run ready tasks in parallel
        await Promise.all(ready.map(async (task) => {
            emit(`Launching agent [${task.agent}] for task ${task.id}...`);
            if (broadcastMsg) broadcastMsg({ type: 'task_started', taskId: task.id, agent: task.agent });

            // Inject context from dependency outputs
            const dependencyContext = task.dependsOn
                .map(dep => taskResults[dep] ? `[Task ${dep} output]: ${taskResults[dep]}` : '')
                .filter(Boolean)
                .join('\n');

            const enrichedTask = { ...task, context: dependencyContext };

            // Override tool execution to use the approval gate
            // We monkey-patch a guarded executeTool for this task only
            const guardedBroadcast = (msg) => {
                // Intercept and gate tool calls
                if (msg && msg._toolCall) {
                    return executeWithApproval(msg._toolCall.name, msg._toolCall.args, task.id, task.agent, broadcastMsg);
                }
                if (broadcastMsg) broadcastMsg(msg);
            };

            try {
                // runAgent uses toolRegistry.executeTool directly — we pass a wrapper
                const output = await runAgentWithApproval(enrichedTask, agentName, task, broadcastMsg, executeWithApproval);
                taskResults[task.id] = output;
                completed.add(task.id);
                if (broadcastMsg) broadcastMsg({ type: 'task_done', taskId: task.id, agent: task.agent, output: output.slice(0, 200) });
                emit(`Agent [${task.agent}] completed task ${task.id}.`);
            } catch (err) {
                taskResults[task.id] = `Error: ${err.message}`;
                completed.add(task.id);
                if (broadcastMsg) broadcastMsg({ type: 'task_failed', taskId: task.id, agent: task.agent, error: err.message });
                emit(`Agent [${task.agent}] failed task ${task.id}: ${err.message}`);
            }
        }));
    }

    emit('All tasks complete. Synthesising final response...');
    if (broadcastMsg) broadcastMsg({ type: 'plan_done', results: taskResults });

    // Final synthesis using best local model
    const allOutputs = tasks.map(t => `[${t.agent}]: ${taskResults[t.id] || 'No output'}`).join('\n\n');
    const synthModel = getBestLocalModel('reasoning');

    if (tasks.length === 1) {
        // Single task — return its output directly
        return taskResults['t1'] || allOutputs;
    }

    const synthPrompt = `You completed a multi-agent task. The goal was: "${plan.goal}"

Agent outputs:
${allOutputs}

Write a clear, concise response to the user summarising what was accomplished. Be direct — no meta-commentary about agents or tasks.`;

    const finalResponse = await runLocalModel(synthModel, [{ role: 'user', content: synthPrompt }]);
    return finalResponse;
}

/**
 * Variant of runAgent that uses the approval-gated tool executor.
 * Replaces direct toolRegistry calls with executeWithApproval.
 */
async function runAgentWithApproval(task, agentName, originalTask, broadcastMsg, approvalFn) {
    const { runLocalModel, getBestLocalModel } = await import('../fleet/index.js');
    const { toolRegistry } = await import('../gateway/toolRegistry.js');

    const model = getBestLocalModel(task.agent === 'coder' ? 'coding' : 'reasoning');
    const history = [];
    const MAX_TURNS = 8;
    let turn = 0;

    const emit = (msg) => {
        if (broadcastMsg) broadcastMsg({ type: 'agent_update', taskId: task.id, agent: task.agent, message: msg });
    };

    const allTools = toolRegistry.getAllTools();
    const allowedToolDefs = [
        ...allTools.native.filter(t => task.tools.includes(t.name)),
        ...allTools.gateway.filter(t => task.tools.includes(t.name)),
        ...allTools.vault.filter(t => task.tools.includes(t.name))
    ];

    const toolsDescription = allowedToolDefs.length > 0
        ? '\nAvailable tools:\n' + allowedToolDefs.map(t => `  - ${t.name}: ${t.description || t.name}`).join('\n')
        : '\nNo tools — respond from knowledge only.';

    const contextSection = task.context ? `\n\nContext from previous agents:\n${task.context}\n` : '';

    const SYSTEM_PROMPT = `You are ${agentName} acting as a specialist [${task.agent}] agent.
Your ONLY goal: ${task.instruction}
${contextSection}
Output ONLY JSON. On each turn:
If using a tool: { "thought": "...", "action": "tool_name", "args": { } }
If done: { "thought": "...", "action": "finish", "result": "..." }
${toolsDescription}
Max ${MAX_TURNS} turns. Finish as soon as you have the answer.`;

    while (turn < MAX_TURNS) {
        turn++;
        emit(`Turn ${turn}/${MAX_TURNS}`);

        let rawOutput;
        try {
            rawOutput = await runLocalModel(model, [
                ...history,
                { role: 'user', content: turn === 1 ? task.instruction : 'Continue.' }
            ], SYSTEM_PROMPT);
        } catch (e) {
            return `Agent error: ${e.message}`;
        }

        let thought;
        try {
            const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
            thought = JSON.parse(jsonMatch ? jsonMatch[0] : rawOutput);
        } catch {
            return rawOutput;
        }

        if (thought.action === 'finish') {
            emit(`Finished.`);
            return thought.result || rawOutput;
        }

        const toolName = thought.action;
        const toolArgs = thought.args || {};
        emit(`Calling tool: ${toolName}`);

        let observation;
        try {
            // Use approval-gated execution
            observation = await approvalFn(toolName, toolArgs, task.id, task.agent, broadcastMsg);
        } catch (e) {
            observation = `Tool '${toolName}' failed: ${e.message}`;
        }

        emit(`Observed: ${String(observation).slice(0, 120)}`);
        history.push({ role: 'user',      content: task.instruction });
        history.push({ role: 'assistant', content: rawOutput });
        history.push({ role: 'user',      content: `Tool observation: ${observation}` });
    }

    // Synthesise if max turns hit
    const synthPrompt = `Based on work so far, give a final answer to: "${task.instruction}"
${history.map(m => `${m.role}: ${m.content}`).join('\n')}
Output the final answer only.`;
    return runLocalModel(model, [{ role: 'user', content: synthPrompt }]);
}
