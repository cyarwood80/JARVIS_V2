import { OLLAMA_URL, MODEL_REGISTRY, setModelRegistry, systemHardwareProfile, METRICS, markModelWarm, updateLocalTokens, ROOT_DIR } from '../../config/index.js';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';

const KNOWN_CAPABILITIES = {
    'hermes3': { domain: 'general', specialisms: 'OS commands, system queries, user/session info, event logs, file operations', toolCalling: 'reliable' },
    'qwen': { domain: 'coding', specialisms: 'Code generation, scripts, debugging, programming tasks', toolCalling: 'very reliable' },
    'gemma': { domain: 'reasoning', specialisms: 'Complex multi-step reasoning, data analysis', toolCalling: 'native best' },
    'llama': { domain: 'general', specialisms: 'Simple factual Q&A, general conversation', toolCalling: 'limited' }
};

// Role assignments from onboarding fleet negotiation (planner/synthesiser/chat)
let fleetRoles = {};

async function loadFleetConfig() {
    try {
        const raw = await fs.readFile(path.join(ROOT_DIR, 'vault', 'fleet_config.json'), 'utf8');
        fleetRoles = JSON.parse(raw);
        console.log('[FLEET] Loaded fleet config:', fleetRoles);
    } catch {
        // No fleet config yet (pre-setup or setup skipped) — fall through to capability scoring
        fleetRoles = {};
    }
}

// Load fleet config on startup
loadFleetConfig();

let ollamaStarted = false;

export async function refreshModels() {
    try {
        const res = await fetch(`${OLLAMA_URL}/api/tags`);
        if (!res.ok) return;
        const data = await res.json();
        const newRegistry = {};
        for (const model of data.models) {
            const name = model.name;
            const sizeGB = (model.size / 1e9).toFixed(1) + 'GB';
            let matchedCaps = { domain: 'general', specialisms: 'General purpose tasks', toolCalling: 'unknown' };
            for (const [key, caps] of Object.entries(KNOWN_CAPABILITIES)) {
                if (name.toLowerCase().includes(key)) {
                    matchedCaps = caps;
                    break;
                }
            }
            // Annotate with fleet role if assigned during onboarding
            const role = Object.entries(fleetRoles).find(([, m]) => m === name)?.[0] || null;
            newRegistry[name] = { ...matchedCaps, size: sizeGB, role };
        }
        setModelRegistry(newRegistry);
    } catch (e) {
        if (!ollamaStarted) {
            console.log('[FLEET] Attempting to start Ollama automatically...');
            const child = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', shell: true });
            child.unref();
            ollamaStarted = true;
        }
        console.error('[FLEET] Failed to connect to Ollama. Ensure Ollama is running.');
    }
}

// Auto-refresh models every 15 seconds
setInterval(refreshModels, 15000);

export function getBestLocalModel(requiredCapability) {
    let bestModel = null;
    let maxScore = -1;
    const fallback = Object.keys(MODEL_REGISTRY)[0] || 'llama3.1:8b';

    // Map capability to fleet role
    const CAPABILITY_TO_ROLE = {
        'coding': 'planner',
        'reasoning': 'planner',
        'os': 'planner',
        'general': 'chat'
    };
    const preferredRole = CAPABILITY_TO_ROLE[requiredCapability] || 'chat';

    for (const [name, meta] of Object.entries(MODEL_REGISTRY)) {
        let score = 0;
        const sizeGB = parseFloat(meta.size) || 0;
        score += (sizeGB * 10); 

        // Fleet role assignment is the highest priority signal
        if (meta.role === preferredRole) score += 2000;
        if (meta.role === 'synthesiser' && requiredCapability === 'reasoning') score += 1500;

        // Domain capability scoring as tiebreaker (boosted heavily to override raw size)
        if (requiredCapability === 'coding' && meta.domain === 'coding') score += 1000;
        if (requiredCapability === 'os' && name.includes('hermes3')) score += 1000;
        if (requiredCapability === 'reasoning' && meta.domain === 'reasoning') score += 1000;
        if (requiredCapability === 'general' && meta.domain === 'general') score += 500;

        // HARDWARE LIMITER
        if (systemHardwareProfile && systemHardwareProfile.ramGB) {
            if (sizeGB > (systemHardwareProfile.ramGB - 2)) score -= 1000;
        }
        
        if (score > maxScore) {
            maxScore = score;
            bestModel = name;
        }
    }
    return bestModel || fallback;
}

export async function runLocalModel(modelName, messages, systemPrompt = "") {
    const ollamaMessages = systemPrompt ? [{ role: "system", content: systemPrompt }, ...messages] : messages;
    const body = { model: modelName, messages: ollamaMessages, stream: false, keep_alive: "2h" };

    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!res.ok) throw new Error(`Ollama returned status ${res.status}`);
    const data = await res.json();
    
    if (data.eval_count) {
        updateLocalTokens(modelName, data.eval_count);
    }
    
    markModelWarm(modelName);
    return data.message?.content || "";
}
