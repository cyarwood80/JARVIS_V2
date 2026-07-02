import { exec } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { search } from 'duck-duck-scrape';
import notifier from 'node-notifier';
import puppeteer from 'puppeteer';

// Global stateful browser session
let globalBrowser = null;
let globalPage = null;
import { ROOT_DIR, PORT, AGENT_NAME } from '../../config/index.js';
import { manageMemoryAction } from '../memory/index.js';
import { getPcDiagnostics } from '../hardware/system.js';
import { getVaultIndex } from '../vault/vaultIndex.js';
import { startDaemon } from '../daemon/manager.js';


async function fileExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function getApprovedCommands() {
    const vaultDir = path.join(ROOT_DIR, 'vault');
    if (!(await fileExists(vaultDir))) await fs.mkdir(vaultDir, { recursive: true });
    
    const whitelistPath = path.join(vaultDir, 'approved_commands.json');
    if (await fileExists(whitelistPath)) {
        try {
            const data = await fs.readFile(whitelistPath, 'utf8');
            return JSON.parse(data);
        } catch {
            return [];
        }
    }
    return [];
}

async function addApprovedCommand(command) {
    const whitelistPath = path.join(ROOT_DIR, 'vault', 'approved_commands.json');
    const cmds = await getApprovedCommands();
    if (!cmds.includes(command)) {
        cmds.push(command);
        await fs.writeFile(whitelistPath, JSON.stringify(cmds, null, 2), 'utf8');
    }
}

export async function executeTool(name, args, chatHistory, broadcastMsg) {
    console.log(`[TOOL CALLED] ${name}`, args);

    if (name === 'get_vault_index') {
        const scripts = await getVaultIndex();
        if (scripts.length === 0) return 'The Automation Vault is empty. No scripts have been saved yet.';
        const list = scripts.map(s => `- ${s.name} [${s.type}]: ${s.description}`).join('\n');
        return `Automation Vault contents (${scripts.length} script${scripts.length !== 1 ? 's' : ''}):\n${list}`;
    }

    if (name === 'get_pc_diagnostics') {
        const stats = await getPcDiagnostics();
        return `CPU Usage: ${stats.cpu}%, Memory Usage: ${stats.memory}%, Disk Usage: ${stats.disk}%`;
    }

    if (name === 'open_application') {
        return new Promise((resolve) => {
            exec(`start ${args.appName}`, (err) => {
                if (err) resolve(`Failed to open ${args.appName}. Error: ${err.message}`);
                else resolve(`Successfully launched ${args.appName}.`);
            });
        });
    }

    if (name === 'save_script') {
        const scriptsDir = path.join(ROOT_DIR, 'scripts');
        if (!(await fileExists(scriptsDir))) await fs.mkdir(scriptsDir);
        
        let filename = path.basename(args.scriptName);
        if (!filename.endsWith('.ps1') && !filename.endsWith('.js')) {
            filename += '.ps1';
        }
        const scriptPath = path.join(scriptsDir, filename);
        
        const targetDir = path.dirname(scriptPath);
        if (!(await fileExists(targetDir))) await fs.mkdir(targetDir, { recursive: true });
        
        let rawCode = args.code || '';
        // If the LLM hallucinated markdown code blocks (e.g. ```powershell), extract just the code inside
        const match = rawCode.match(/```[a-z]*\r?\n([\s\S]*?)\r?\n```/i);
        if (match) {
            rawCode = match[1];
        }
        
        await fs.writeFile(scriptPath, rawCode, 'utf8');
        
        const metaPath = path.join(scriptsDir, 'meta.json');
        let meta = {};
        if (await fileExists(metaPath)) {
            meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
        }
        meta[filename] = args.description || `Created by ${AGENT_NAME}`;
        await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');

        // Refresh the tool registry so the new script is immediately discoverable
        try {
            const { toolRegistry } = await import('../gateway/toolRegistry.js');
            await toolRegistry.refreshVault();
        } catch { /* non-fatal — registry will refresh on next query */ }

        return `Successfully saved script: ${filename} to the Automation Vault.`;
    }

    if (name === 'run_saved_script') {
        const scriptsDir = path.join(ROOT_DIR, 'scripts');
        const filename = path.basename(args.scriptName);
        const scriptPath = path.join(scriptsDir, filename);
        if (!(await fileExists(scriptPath))) {
            return `Error: Script '${args.scriptName}' does not exist in the Automation Vault.`;
        }
        
        return new Promise((resolve) => {
            const isNode = args.scriptName.endsWith('.js');
            const cmdArgs = args.args || '';
            const cmd = isNode 
                ? `node "${scriptPath}" ${cmdArgs}`
                : `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}" ${cmdArgs}`;
                
            exec(cmd, { timeout: 30000 }, (err, stdout, stderr) => {
                if (err) resolve(`Script failed: ${stderr || err.message}`);
                else resolve(stdout.trim() || '[Script ran successfully with no output]');
            });
        });
    }

    if (name === 'run_daemon_script') {
        const scriptsDir = path.join(ROOT_DIR, 'scripts');
        const filename = path.basename(args.scriptName);
        const scriptPath = path.join(scriptsDir, filename);
        if (!(await fileExists(scriptPath))) {
            return `Error: Script '${args.scriptName}' does not exist in the Automation Vault.`;
        }
        
        try {
            const daemon = startDaemon(args.scriptName, args.args || '');
            return `Daemon successfully started in background. Name: ${daemon.name}, PID: ${daemon.pid}, ID: ${daemon.id}. You do not need to wait for its output.`;
        } catch (e) {
            return `Error starting daemon: ${e.message}`;
        }
    }

    if (name === 'list_scripts') {
        const scriptsDir = path.join(ROOT_DIR, 'scripts');
        if (!(await fileExists(scriptsDir))) return "The Automation Vault is empty.";
        const files = (await fs.readdir(scriptsDir)).filter(f => f.endsWith('.ps1') || f.endsWith('.js'));
        if (files.length === 0) return "The Automation Vault is empty.";
        return `Available scripts:\n` + files.map(f => `- ${f}`).join('\n');
    }

    if (name === 'search_web') {
        try {
            const searchResults = await search(args.query);
            if (!searchResults || !searchResults.results || searchResults.results.length === 0) {
                return `No web search results found for: ${args.query}`;
            }
            const topResults = searchResults.results.slice(0, 4).map(r => 
                `TITLE: ${r.title}\nURL: ${r.url}\nSUMMARY: ${r.description}\n`
            ).join('\n---\n');
            return `Web Search Results for "${args.query}":\n\n${topResults}`;
        } catch (err) {
            return `Web search failed: ${err.message}`;
        }
    }

    if (name === 'browser_open') {
        try {
            if (!globalBrowser) {
                if (broadcastMsg) broadcastMsg({ type: 'log', message: `[Browser] Launching Headless Chromium for ${args.url}...` });
                globalBrowser = await puppeteer.launch({ 
                    headless: false, // Let's make it visible for interactive demo purposes, or args.visible
                    defaultViewport: null,
                    args: ['--start-maximized', '--no-sandbox']
                });
            }
            if (!globalPage) {
                const pages = await globalBrowser.pages();
                globalPage = pages.length > 0 ? pages[0] : await globalBrowser.newPage();
            }
            
            await globalPage.goto(args.url, { waitUntil: 'networkidle2', timeout: 30000 });
            return `Successfully opened ${args.url}.`;
        } catch (err) {
            return `Failed to open website: ${err.message}`;
        }
    }

    if (name === 'browser_click') {
        try {
            if (!globalPage) return "No active browser session. Call browser_open first.";
            await globalPage.waitForSelector(args.selector, { timeout: 5000 });
            await globalPage.click(args.selector);
            await new Promise(r => setTimeout(r, 1000)); // wait for transitions
            return `Clicked element matching selector: ${args.selector}`;
        } catch (err) {
            return `Failed to click element: ${err.message}`;
        }
    }

    if (name === 'browser_type') {
        try {
            if (!globalPage) return "No active browser session. Call browser_open first.";
            await globalPage.waitForSelector(args.selector, { timeout: 5000 });
            await globalPage.type(args.selector, args.text, { delay: 50 });
            return `Typed "${args.text}" into element matching selector: ${args.selector}`;
        } catch (err) {
            return `Failed to type into element: ${err.message}`;
        }
    }

    if (name === 'browser_extract') {
        try {
            if (!globalPage) return "No active browser session. Call browser_open first.";
            const text = await globalPage.evaluate(() => document.body.innerText);
            const cleanedText = text.replace(/[\r\n]+/g, '\n').replace(/\s{2,}/g, ' ').substring(0, 8000);
            return `Extracted text from current page:\n\n${cleanedText}...`;
        } catch (err) {
            return `Failed to extract text: ${err.message}`;
        }
    }

    if (name === 'browser_close') {
        try {
            if (globalBrowser) {
                await globalBrowser.close();
                globalBrowser = null;
                globalPage = null;
                return "Browser session closed.";
            }
            return "No active browser session to close.";
        } catch (err) {
            return `Failed to close browser: ${err.message}`;
        }
    }

    if (name === 'manage_memory') {
        return await manageMemoryAction(args.action, args.fact);
    }

    if (name === 'execute_command') {
        const commandStr = args.command;
        const approvedCmds = await getApprovedCommands();
        const isApproved = approvedCmds.includes(commandStr);
        
        const READ_ONLY_PREFIXES = ['ipconfig', 'ping', 'dir', 'ls', 'echo', 'whoami', 'get-', 'systeminfo', 'netstat', 'tasklist', 'tree'];
        const isReadOnly = READ_ONLY_PREFIXES.some(prefix => commandStr.toLowerCase().startsWith(prefix));
        
        if (!isApproved && !isReadOnly) {
            const lastMsg = chatHistory[chatHistory.length - 1]?.content?.toLowerCase() || "";
            const GRANT_WORDS = ['yes', 'approve', 'proceed', 'permission', 'granted', 'go ahead', 'do it', 'run it', 'ok', 'sure', 'fine', 'authorized', 'authorise'];
            const permissionGranted = GRANT_WORDS.some(w => lastMsg.includes(w));
            
            if (!permissionGranted) {
                return `SECURITY BLOCK: Command '${commandStr}' is unapproved. You MUST ask the user for explicit permission to run it, and ask if they want to whitelist it.`;
            }
            
            // If we have permission, check if they wanted to whitelist it
            if (lastMsg.includes('whitelist') || lastMsg.includes('remember') || lastMsg.includes('always')) {
                await addApprovedCommand(commandStr);
                if (broadcastMsg) broadcastMsg({ type: 'log', message: `[APPROVED] Command added to whitelist.` });
            }
        }

        return new Promise(async (resolve) => {
            const tmpFile = path.join(ROOT_DIR, `_${AGENT_NAME}_tmp_${Date.now()}.ps1`);
            await fs.writeFile(tmpFile, commandStr, 'utf8');
            exec(`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmpFile}"`,
                { timeout: 15000 },
                async (err, stdout, stderr) => {
                    try { await fs.unlink(tmpFile); } catch (_) {}
                    if (err) resolve(`Command failed: ${stderr || err.message}`);
                    else resolve(stdout.trim() || '[Command ran successfully with no output]');
                }
            );
        });
    }

    if (name === 'whatsapp_push') {
        return new Promise(async (resolve) => {
            try {
                const res = await fetch('http://127.0.0.1:3001/api/send', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: args.message })
                });
                if (res.ok) resolve('WhatsApp push message sent successfully.');
                else resolve('Failed to send WhatsApp push message. OpenClaw might be disconnected.');
            } catch (e) {
                resolve(`WhatsApp push error: ${e.message}`);
            }
        });
    }

    if (name === 'voice_alert') {
        if (broadcastMsg) broadcastMsg({ type: 'log', message: `[Voice Alert] ${args.message}` });
        if (broadcastMsg) broadcastMsg({ type: 'speak', text: args.message });
        return 'Voice alert played through PC speakers.';
    }

    if (name === 'desktop_notify') {
        notifier.notify({
            title: args.title || `${AGENT_NAME} Notification`,
            message: args.message,
            sound: true,
            wait: false
        });
        return 'Windows desktop notification sent.';
    }

    return "Tool not found.";
}
