/**
 * src/setup/index.js
 * 
 * Intelligent Onboarding Wizard — Jarvis V2
 * 
 * Runs on first boot (before the server starts) to configure:
 *   1. Agent name & owner name
 *   2. Gemini API key
 *   3. Hardware profile
 *   4. AI model fleet (negotiated with Gemini, pulled via Ollama)
 * 
 * Saves to vault/agent_config.json and vault/fleet_config.json.
 * Subsequent boots skip the wizard if both files are present.
 */

import fs from 'fs/promises';
import path from 'path';
import { input, select } from '@inquirer/prompts';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { exec } from 'child_process';
import { ROOT_DIR, OLLAMA_URL, setAgentName, setOwnerName } from '../../config/index.js';
import { getHardwareProfile } from '../hardware/index.js';

const VAULT_DIR = path.join(ROOT_DIR, 'vault');
const CONFIG_PATH = path.join(VAULT_DIR, 'agent_config.json');
const FLEET_PATH = path.join(VAULT_DIR, 'fleet_config.json');
const ENV_PATH = path.join(ROOT_DIR, '.env');

/**
 * Checks if the agent has already been configured.
 * Returns the agent config if complete, null otherwise.
 */
export async function isConfigured() {
    try {
        const [configRaw] = await Promise.all([
            fs.readFile(CONFIG_PATH, 'utf8'),
            fs.access(FLEET_PATH)   // throws if missing
        ]);
        const config = JSON.parse(configRaw);
        if (config.agentName && config.ownerName) {
            setAgentName(config.agentName);
            setOwnerName(config.ownerName);
            return config;
        }
    } catch {
        // Not configured
    }
    return null;
}

/**
 * Main entry point. Runs the full onboarding wizard.
 * Returns the agent name when complete.
 */
export async function runSetupWizard() {
    // Ensure vault directory exists
    await fs.mkdir(VAULT_DIR, { recursive: true });

    console.clear();
    console.log('\x1b[35m================================================\x1b[0m');
    console.log('\x1b[35m   AUTONOMOUS AGENT HUB -- FIRST RUN SETUP      \x1b[0m');
    console.log('\x1b[35m================================================\x1b[0m');
    console.log('\nWelcome! Let\'s get your agent configured.\n');

    // ── Phase 1: Identity ────────────────────────────────────────
    const agentName = await input({
        message: 'What would you like to name your AI Agent?',
        default: 'ARGUS',
        validate: (val) => val.trim().length > 0 ? true : 'Agent name cannot be empty.'
    });

    const ownerName = await input({
        message: 'What is your name? (Used to personalise your memory vault)',
        default: 'User',
        validate: (val) => val.trim().length > 0 ? true : 'Owner name cannot be empty.'
    });

    setAgentName(agentName.trim());
    setOwnerName(ownerName.trim());

    // ── Phase 2: Gemini API Key ──────────────────────────────────
    let geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey || geminiKey.trim() === '') {
        console.log(`\n\x1b[33m[NOTICE]\x1b[0m ${agentName} requires a Google Gemini API Key to orchestrate your local models.`);
        console.log('         Get a free key at: \x1b[36mhttps://aistudio.google.com/app/apikey\x1b[0m\n');

        const openBrowser = await input({
            message: 'Open Google AI Studio now to get your key? (Y/N)',
            default: 'Y'
        });
        if (openBrowser.trim().toUpperCase().startsWith('Y')) {
            exec('start https://aistudio.google.com/app/apikey');
            console.log('\x1b[2m(Browser opened — paste your key below when ready)\x1b[0m\n');
        }

        geminiKey = await input({
            message: 'Paste your Gemini API Key (leave blank for Offline/Local-Only mode):',
            default: ''
        });

        // Update .env file
        let envContent = '';
        try { envContent = await fs.readFile(ENV_PATH, 'utf8'); } catch { /* no .env yet */ }
        // Remove any existing GEMINI_API_KEY line
        envContent = envContent.split('\n').filter(l => !l.startsWith('GEMINI_API_KEY=')).join('\n');
        envContent += `\nGEMINI_API_KEY=${geminiKey.trim()}\n`;
        await fs.writeFile(ENV_PATH, envContent.trim(), 'utf8');
        process.env.GEMINI_API_KEY = geminiKey.trim();
    }

    // ── Phase 3: Hardware Profiling ──────────────────────────────
    console.log('\n\x1b[36m[1/3 — Hardware Profiling]\x1b[0m Scanning system resources...');
    const profile = await getHardwareProfile();
    console.log(`  [+] CPU  : ${profile.cpuBrand}`);
    console.log(`  [+] RAM  : ${profile.ramGB} GB`);
    console.log(`  [+] VRAM : ${profile.vramGB} GB`);
    console.log(`  [+] Tier : ${profile.tier} (${profile.tier === 'A' ? 'High-End' : profile.tier === 'B' ? 'Mid-Range' : 'Entry-Level'})`);

    // ── Phase 4: Ollama Model Scan ───────────────────────────────
    console.log('\n\x1b[36m[2/3 — Scanning Local Assets]\x1b[0m Checking Ollama...');
    let installedModels = [];
    try {
        const res = await fetch(`${OLLAMA_URL}/api/tags`);
        if (res.ok) {
            const data = await res.json();
            installedModels = data.models.map(m => m.name);
        }
    } catch {
        console.log('\x1b[31m  [!] Cannot connect to Ollama. Ensure Ollama is running before setup.\x1b[0m');
        console.log('      Download Ollama at: \x1b[36mhttps://ollama.com/download\x1b[0m\n');
    }

    if (installedModels.length > 0) {
        console.log(`  [+] Found models: ${installedModels.join(', ')}`);
    } else {
        console.log('  [-] No models installed yet - they will be downloaded after fleet selection.');
    }

    // ── Phase 5: Goal Selection ──────────────────────────────────
    const goalPreset = await select({
        message: `\nWhat is your primary goal for ${agentName}?`,
        choices: [
            { name: '[1] Heavy Coding & Autonomous Scripting', value: 'Coding & Scripts' },
            { name: '[2] Complex Reasoning & Deep Research',   value: 'Research & Reasoning' },
            { name: '[3] Fast General Assistance',             value: 'Fast General Chat' },
            { name: '[4] The Ultimate All-Rounder',            value: 'All-Rounder' },
            { name: '[5] Custom (Type your own goal)',         value: 'custom' }
        ]
    });

    let userGoal = goalPreset;
    if (goalPreset === 'custom') {
        userGoal = await input({ message: `Describe what you want to use ${agentName} for:` });
    }

    // ── Phase 6: Gemini Fleet Negotiation ───────────────────────
    console.log('\n\x1b[36m[3/3 — Fleet Negotiation]\x1b[0m Consulting Gemini for the optimal model fleet...\n');

    let finalFleet = null;
    if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim() !== '') {
        finalFleet = await negotiateFleetWithGemini(
            process.env.GEMINI_API_KEY, profile, installedModels, userGoal, agentName
        );
    } else {
        console.log('\x1b[33m  [!] No Gemini key — using static fallback fleet recommendations.\x1b[0m');
        finalFleet = getStaticFallbackFleet(profile);
        displayFleet(finalFleet, installedModels);
    }

    // ── Phase 7: Save Config & Auto-Provision ───────────────────
    const agentConfig = { agentName: agentName.trim(), ownerName: ownerName.trim() };
    await fs.writeFile(CONFIG_PATH, JSON.stringify(agentConfig, null, 2), 'utf8');

    const fleetConfigObj = {};
    const modelsToPull = [];
    finalFleet.forEach(f => {
        fleetConfigObj[f.role] = f.model;
        if (!installedModels.includes(f.model)) {
            modelsToPull.push(f.model);
        }
    });
    await fs.writeFile(FLEET_PATH, JSON.stringify(fleetConfigObj, null, 2), 'utf8');

    if (modelsToPull.length > 0) {
        console.log(`\n\x1b[36m[Auto-Provisioning]\x1b[0m Downloading ${modelsToPull.length} model(s) via Ollama. This may take a while...\n`);
        for (const model of modelsToPull) {
            console.log(`  >> Pulling ${model}...`);
            await pullModel(model);
        }
        console.log('\n\x1b[32m[Downloads Complete]\x1b[0m All fleet models installed!\n');
    } else {
        console.log('\n\x1b[32m[All Set]\x1b[0m All required models are already installed.\n');
    }

    console.log('\x1b[35m================================================\x1b[0m');
    console.log(`\x1b[35m   ${agentName} is ready. Starting up...\x1b[0m`);
    console.log('\x1b[35m================================================\x1b[0m\n');

    return agentName.trim();
}

// ─────────────────────────────────────────────────────────────
// FLEET NEGOTIATION
// ─────────────────────────────────────────────────────────────

async function negotiateFleetWithGemini(geminiKey, profile, installedModels, userGoal, agentName) {
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const basePrompt = `You are a Senior AI Hardware Architect. Your job is to curate the absolute best 3-model local AI fleet for a user running Ollama.
The fleet must contain EXACTLY three roles:
1. "planner": The heavy, intelligent system router (best for coding/logic).
2. "synthesiser": The creative/reasoning model (best for writing/summarising).
3. "chat": The extremely fast, lightweight fallback model (for quick casual chat).

USER HARDWARE:
- RAM: ${profile.ramGB} GB
- VRAM: ${profile.vramGB} GB
- Tier: ${profile.tier}

ALREADY INSTALLED MODELS:
[${installedModels.length > 0 ? installedModels.join(', ') : 'None'}]

USER'S PRIMARY GOAL:
"${userGoal}"

INSTRUCTIONS:
1. Select exactly 3 specific Ollama model tags (e.g. "qwen2.5:32b", "gemma2:9b", "llama3.1:8b").
2. DO NOT recommend any single model that exceeds the user's total RAM in GB.
3. If an already-installed model is excellent for a role, USE IT — respect existing downloads.
4. Recommend the very best models available for the hardware tier.
5. Include a brief reason for each choice.

Return STRICTLY raw JSON (no markdown, no backticks):
[
  {"role": "planner", "model": "model_tag_here", "reason": "Why this is the best choice..."},
  {"role": "synthesiser", "model": "model_tag_here", "reason": "Why this is the best choice..."},
  {"role": "chat", "model": "model_tag_here", "reason": "Why this is the best choice..."}
]`;

    let userFeedback = '';
    let finalFleet = null;

    while (!finalFleet) {
        const fullPrompt = userFeedback
            ? basePrompt + `\n\nUSER FEEDBACK ON PREVIOUS SUGGESTION:\n"${userFeedback}"\n\nAdjust your recommendation to accommodate this feedback.`
            : basePrompt;

        try {
            const result = await model.generateContent(fullPrompt);
            let text = result.response.text().trim();
            text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

            const fleet = JSON.parse(text);

            // Display the recommendation
            console.log('\x1b[32m--- Recommended Fleet Roster ---\x1b[0m\n');
            displayFleet(fleet, installedModels);

            const action = await select({
                message: `Accept this fleet for ${agentName}?`,
                choices: [
                    { name: '[Y] Yes - Accept and Provision', value: 'accept' },
                    { name: '[N] No  - Suggest Changes',      value: 'suggest' }
                ]
            });

            if (action === 'accept') {
                finalFleet = fleet;
            } else {
                userFeedback = await input({
                    message: 'What would you like to change? (e.g. "I want a smaller model for chat")'
                });
                console.log('\n\x1b[36m[Re-Negotiating]\x1b[0m Consulting Gemini with your feedback...\n');
            }
        } catch (e) {
            console.error('\x1b[31m  [!] Gemini Fleet Negotiation Failed:\x1b[0m', e.message);
            console.log('\x1b[33m      Falling back to static hardware-tier recommendations.\x1b[0m\n');
            finalFleet = getStaticFallbackFleet(profile);
            displayFleet(finalFleet, installedModels);
        }
    }

    return finalFleet;
}

function displayFleet(fleet, installedModels = []) {
    fleet.forEach(f => {
        const isInstalled = installedModels.includes(f.model);
        const statusTag = isInstalled
            ? '\x1b[32m(Already Installed)\x1b[0m'
            : '\x1b[33m(Will Download)\x1b[0m';
        console.log(`  \x1b[1mRole:\x1b[0m ${f.role.toUpperCase()}`);
        console.log(`  \x1b[1mModel:\x1b[0m \x1b[36m${f.model}\x1b[0m ${statusTag}`);
        if (f.reason) console.log(`  \x1b[2mReason: ${f.reason}\x1b[0m`);
        console.log('');
    });
}

function getStaticFallbackFleet(profile) {
    const fallbacks = {
        'A': { planner: 'qwen2.5:32b',  synthesiser: 'gemma4:26b',  chat: 'llama3.1:8b' },
        'B': { planner: 'qwen2.5:14b',  synthesiser: 'gemma2:9b',   chat: 'llama3.1:8b' },
        'C': { planner: 'llama3.1:8b',  synthesiser: 'gemma2:2b',   chat: 'llama3.2:1b'  }
    };
    const f = fallbacks[profile.tier] || fallbacks['C'];
    return [
        { role: 'planner',     model: f.planner,     reason: 'Best coding & reasoning model for your hardware tier' },
        { role: 'synthesiser', model: f.synthesiser, reason: 'Strong creative and analysis model for your hardware tier' },
        { role: 'chat',        model: f.chat,        reason: 'Fast lightweight model for quick responses' }
    ];
}

// ─────────────────────────────────────────────────────────────
// OLLAMA MODEL PULL
// ─────────────────────────────────────────────────────────────

function pullModel(modelName) {
    return new Promise((resolve) => {
        const child = exec(`ollama pull ${modelName}`);
        child.stdout.pipe(process.stdout);
        child.stderr.pipe(process.stderr);
        child.on('exit', () => resolve());
    });
}
