import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// config is in jarvis-v2/config, so root is one level up
export const ROOT_DIR = path.resolve(__dirname, '..');

export const PORT = process.env.PORT || 3000; 
export const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

export const COLD_THRESHOLD_MS = 5 * 60 * 1000;
export const LARGE_MODELS = new Set(['qwen2.5:32b', 'gemma4:26b']);

export const modelWarmth = {};
import fs from 'fs/promises';

export const METRICS = {
    sessionTokensLocal: 0,
    sessionTokensPublic: 0,
    historicTokensLocal: 0,
    historicTokensPublic: 0,
    models: {}
};

export async function loadMetrics() {
    try {
        const data = JSON.parse(await fs.readFile(path.join(ROOT_DIR, 'vault', 'metrics.json'), 'utf8'));
        METRICS.historicTokensLocal = data.historicTokensLocal || 0;
        METRICS.historicTokensPublic = data.historicTokensPublic || 0;
        if (data.models) METRICS.models = data.models;
    } catch {}
}

async function saveMetrics() {
    try {
        const vaultDir = path.join(ROOT_DIR, 'vault');
        await fs.mkdir(vaultDir, { recursive: true });
        await fs.writeFile(path.join(vaultDir, 'metrics.json'), JSON.stringify({
            historicTokensLocal: METRICS.historicTokensLocal,
            historicTokensPublic: METRICS.historicTokensPublic,
            models: METRICS.models
        }, null, 2), 'utf8');
    } catch {}
}

export function updatePublicTokens(count) {
    METRICS.sessionTokensPublic += count;
    METRICS.historicTokensPublic += count;
    saveMetrics();
}

export function updateLocalTokens(modelName, count) {
    METRICS.sessionTokensLocal += count;
    METRICS.historicTokensLocal += count;
    if (!METRICS.models[modelName]) METRICS.models[modelName] = { runs: 0, tokens: 0 };
    METRICS.models[modelName].runs++;
    METRICS.models[modelName].tokens += count;
    saveMetrics();
}
export let MODEL_REGISTRY = {};
export let systemHardwareProfile = null;

export function setSystemHardwareProfile(profile) {
    systemHardwareProfile = profile;
}

// AGENT_NAME is set during onboarding (src/setup/index.js).
// Default is used only as a last-resort fallback before setup runs.
export let AGENT_NAME = "Agent";
export let OWNER_NAME = "User";

export function setAgentName(name) {
    AGENT_NAME = name;
}

export function setOwnerName(name) {
    OWNER_NAME = name;
}

export function setModelRegistry(registry) {
    MODEL_REGISTRY = registry;
}

export function isModelCold(modelName) {
    const last = modelWarmth[modelName] || 0;
    return (Date.now() - last) > COLD_THRESHOLD_MS;
}

export function markModelWarm(modelName) {
    modelWarmth[modelName] = Date.now();
    console.log(`[WARMTH] Marked ${modelName} as warm.`);
}
