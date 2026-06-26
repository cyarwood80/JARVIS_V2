/**
 * bootstrap.js — Jarvis V2 Entry Point
 *
 * Runs as a plain Node.js process (NOT Electron) so that @inquirer/prompts
 * has full TTY access for interactive terminal input.
 *
 * Flow:
 *   1. Check vault/agent_config.json — skip wizard if already configured
 *   2. If not configured, run the interactive setup wizard
 *   3. Spawn Electron as a child process to open the UI
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VAULT_DIR   = path.join(__dirname, 'vault');
const CONFIG_PATH = path.join(VAULT_DIR, 'agent_config.json');
const FLEET_PATH  = path.join(VAULT_DIR, 'fleet_config.json');

async function isConfigured() {
    try {
        const [raw] = await Promise.all([
            fs.readFile(CONFIG_PATH, 'utf8'),
            fs.access(FLEET_PATH)
        ]);
        const config = JSON.parse(raw);
        return config.agentName && config.ownerName ? config : null;
    } catch {
        return null;
    }
}

async function main() {
    // Check whether setup has already been completed
    const existing = await isConfigured();

    if (!existing) {
        // Run the interactive wizard in this Node process (has full TTY)
        const { runSetupWizard } = await import('./src/setup/index.js');
        await runSetupWizard();
    } else {
        console.log(`[Boot] Config found. Starting ${existing.agentName}...`);
    }

    // Setup is done — launch Electron as a child process
    // Pass --no-sandbox for compatibility in some Windows environments
    const electronBin = path.join(__dirname, 'node_modules', '.bin', 'electron');
    const electronArgs = [path.join(__dirname, 'src', 'desktop', 'main.js')];

    const child = spawn(electronBin, electronArgs, {
        stdio: 'inherit',   // Electron's own output stays visible
        shell: process.platform === 'win32',
        env: { ...process.env }
    });

    child.on('close', (code) => {
        process.exit(code ?? 0);
    });

    child.on('error', (err) => {
        console.error('[Boot] Failed to launch Electron:', err.message);
        process.exit(1);
    });
}

main().catch(err => {
    console.error('[Boot] Fatal error during startup:', err);
    process.exit(1);
});
