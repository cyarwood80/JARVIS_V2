/**
 * Tool Registry
 * -------------
 * Singleton that merges all tool sources into a single, queryable registry:
 *   1. Native tools   — from src/tools/definitions.js (browser, exec, notify, etc.)
 *   2. Gateway tools  — from OpenClaw MCP client (whatsapp_send, whatsapp_status)
 *   3. Vault scripts  — from scripts/meta.json (saved .ps1 / .js automation scripts)
 *
 * The Orchestrator queries this at startup and on every routing decision so it
 * always has an accurate, live picture of what Jarvis can do.
 *
 * Approval whitelist:
 *   When an autonomous agent wants to call a tool, it checks vault/approved_plans.json.
 *   If the tool is NOT whitelisted, it emits an approval_required event and waits.
 *   On user approval the tool name is added to the whitelist for future autonomous use.
 */

import { toolDefinitions } from '../tools/definitions.js';
import { executeTool as executeNativeTool } from '../tools/executor.js';
import { openClawGateway } from './mcpClient.js';
import { getVaultIndex } from '../vault/vaultIndex.js';
import { ROOT_DIR } from '../../config/index.js';
import fs from 'fs/promises';
import path from 'path';

const WHITELIST_PATH = path.join(ROOT_DIR, 'vault', 'approved_plans.json');

// ─── Approval Whitelist ───────────────────────────────────────────────────────

async function loadWhitelist() {
    try {
        const raw = await fs.readFile(WHITELIST_PATH, 'utf8');
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

async function saveWhitelist(whitelist) {
    await fs.mkdir(path.dirname(WHITELIST_PATH), { recursive: true });
    await fs.writeFile(WHITELIST_PATH, JSON.stringify(whitelist, null, 2), 'utf8');
}

export async function isToolApproved(toolName) {
    const wl = await loadWhitelist();
    return wl[toolName] === true;
}

export async function approveToolForever(toolName) {
    const wl = await loadWhitelist();
    wl[toolName] = true;
    await saveWhitelist(wl);
    console.log(`[REGISTRY] Tool '${toolName}' added to autonomous whitelist.`);
}

// ─── Tool Registry Class ──────────────────────────────────────────────────────

class ToolRegistry {
    constructor() {
        this._nativeTools   = [];
        this._gatewayTools  = [];
        this._vaultScripts  = [];
        this._gateways      = [openClawGateway];
        this._discovered    = false;
    }

    /**
     * Discover all tools. Call once at startup.
     * Safe to call multiple times (idempotent after first call).
     */
    async discover() {
        this._nativeTools  = toolDefinitions;
        this._vaultScripts = await getVaultIndex();
        this._gatewayTools = this._gateways.flatMap(gw => gw.getTools());
        this._discovered   = true;
        console.log(`[REGISTRY] Discovered ${this._nativeTools.length} native, ${this._gatewayTools.length} gateway, ${this._vaultScripts.length} vault tools.`);
    }

    /** Refresh vault scripts (called after a save_script action) */
    async refreshVault() {
        this._vaultScripts = await getVaultIndex();
    }

    /** Returns all tools grouped by source — used by /api/tools and the Orchestrator */
    getAllTools() {
        return {
            native: this._nativeTools,
            gateway: this._gatewayTools,
            vault: this._vaultScripts
        };
    }

    /**
     * Returns a flat array of all tool names for whitelist/routing checks.
     */
    getAllToolNames() {
        const gatewayNames = this._gatewayTools.map(t => t.name);
        const nativeNames  = this._nativeTools.map(t => t.name);
        const vaultNames   = this._vaultScripts.map(s => s.name);
        return [...nativeNames, ...gatewayNames, ...vaultNames];
    }

    /**
     * Execute a tool by name.
     * Gateway tools are dispatched to the appropriate gateway.
     * All others fall through to the native executor.
     *
     * @param {string}   name         - Tool name
     * @param {object}   args         - Tool arguments
     * @param {Array}    chatHistory  - Conversation history (for execute_command security)
     * @param {function} broadcastMsg - WebSocket broadcast fn for streaming events
     */
    async executeTool(name, args, chatHistory = [], broadcastMsg = null) {
        // Check gateway tools first
        for (const gw of this._gateways) {
            const gwTools = gw.getTools();
            if (gwTools.find(t => t.name === name)) {
                return gw.callTool(name, args);
            }
        }

        // Handle vault script run via native executor (it already handles run_saved_script)
        return executeNativeTool(name, args, chatHistory, broadcastMsg);
    }
}

// Export singleton
export const toolRegistry = new ToolRegistry();
