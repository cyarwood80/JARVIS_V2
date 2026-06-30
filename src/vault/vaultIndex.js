/**
 * Vault Index
 * -----------
 * Reads the Automation Vault at runtime and provides:
 *  - getVaultIndex()        — structured list of all saved scripts
 *  - getVaultContextString() — formatted string injected into Orchestrator prompts
 *
 * This ensures Jarvis always knows which vault scripts exist and can route
 * to run_saved_script intelligently instead of just saving scripts blindly.
 */

import fs from 'fs/promises';
import path from 'path';
import { ROOT_DIR } from '../../config/index.js';

const SCRIPTS_DIR = path.join(ROOT_DIR, 'scripts');
const META_PATH   = path.join(SCRIPTS_DIR, 'meta.json');

/**
 * Returns a structured list of all saved vault scripts.
 * @returns {Promise<Array<{ name: string, description: string, type: string }>>}
 */
export async function getVaultIndex() {
    try {
        const files = await fs.readdir(SCRIPTS_DIR);
        const scripts = files.filter(f => f.endsWith('.ps1') || f.endsWith('.js'));
        
        let meta = {};
        try {
            const raw = await fs.readFile(META_PATH, 'utf8');
            meta = JSON.parse(raw);
        } catch { /* ignore missing meta */ }
        
        return scripts.map(name => ({
            name,
            description: meta[name] || `Script saved by Jarvis`,
            type: name.endsWith('.ps1') ? 'powershell' : 'node'
        }));
    } catch {
        // Vault is empty or dir doesn't exist
        return [];
    }
}

/**
 * Returns a formatted string listing all vault scripts, ready to be injected
 * into the Orchestrator's system prompt.
 * Returns an empty string if the vault is empty.
 */
export async function getVaultContextString() {
    const scripts = await getVaultIndex();
    if (scripts.length === 0) return '';

    const lines = scripts.map(s => `  - ${s.name} [${s.type}]: ${s.description}`).join('\n');
    return `

AUTOMATION VAULT — Scripts you have saved (call via run_saved_script or run_daemon_script):
${lines}

If the user's request matches any of the above scripts, prefer calling run_saved_script (or run_daemon_script if it runs continuously) over writing new code.`;
}
