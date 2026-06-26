import fs from 'fs/promises';
import path from 'path';
import { ROOT_DIR, OWNER_NAME } from '../../config/index.js';
import { searchRagMemory, addRagMemory } from './rag.js';

// Dynamic memory file path — named after the owner set during onboarding.
function getMemoryPath() {
    const safeName = (OWNER_NAME || 'user').replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
    return path.join(ROOT_DIR, 'vault', `${safeName}.md`);
}

export let lastInteractionTime = Date.now();
let hasConsolidatedMemoryToday = false;

export function updateInteractionTime() {
    lastInteractionTime = Date.now();
}

async function fileExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

export function startSleepCycle() {
    setInterval(async () => {
        const idleTime = Date.now() - lastInteractionTime;
        
        // Wait 10 minutes of idle time. No Cloud API key required!
        if (idleTime > 10 * 60 * 1000 && !hasConsolidatedMemoryToday) {
            const memPath = getMemoryPath();
            if (await fileExists(memPath)) {
                try {
                    console.log("[SLEEP CYCLE] System idle. Initiating local memory consolidation...");
                    const rawMemory = await fs.readFile(memPath, 'utf8');
                    if (!rawMemory.trim() || rawMemory.length < 100) return; // Don't consolidate tiny memories

                    const prompt = `You are JARVIS's background memory manager. Consolidate the following raw memory vault. 
Merge overlapping facts, delete duplicate lines, correct any conflicting information, and rewrite it as a beautifully clean, categorized Markdown Knowledge Graph. 
Do not add conversational text, just output the pure Markdown.
\n\nRAW MEMORY:\n${rawMemory}\n\nCONSOLIDATED MARKDOWN:`;

                    // Find a reasoning model locally, fallback to anything
                    let bestModel = Object.keys(MODEL_REGISTRY)[0] || 'llama3.1:8b';
                    for (const name of Object.keys(MODEL_REGISTRY)) {
                        if (name.includes('gemma4') || name.includes('qwen2.5')) bestModel = name;
                    }

                    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: bestModel,
                            prompt: prompt,
                            stream: false,
                            keep_alive: '2h'
                        })
                    });
                    
                    if (!res.ok) throw new Error("Local model failed to consolidate.");
                    const data = await res.json();
                    
                    let cleanedMemory = data.response?.trim();
                    if (!cleanedMemory) throw new Error("Empty response");
                    
                    cleanedMemory = cleanedMemory.replace(/^```(?:markdown)?\s*/i, '').replace(/\s*```$/, '').trim();
                    
                    await fs.writeFile(memPath, cleanedMemory, 'utf8');
                    console.log(`[SLEEP CYCLE] Local memory consolidation complete using ${bestModel}.`);
                    
                    hasConsolidatedMemoryToday = true;
                    setTimeout(() => hasConsolidatedMemoryToday = false, 12 * 60 * 60 * 1000); // Reset after 12 hours
                } catch(e) {
                    console.error("[SLEEP CYCLE] Consolidation failed:", e.message);
                }
            }
        }
    }, 60 * 1000);
}

export async function getCoreMemory(messages = []) {
    const memPath = getMemoryPath();
    let coreStr = '';
    if (await fileExists(memPath)) {
        const mem = await fs.readFile(memPath, 'utf8');
        if (mem) coreStr += `\n\n<LONG_TERM_MEMORY>\n${mem}\n</LONG_TERM_MEMORY>\n`;
    }

    if (messages && messages.length > 0) {
        const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
        if (lastUserMsg) {
            const ragResults = await searchRagMemory(lastUserMsg, 3);
            if (ragResults && ragResults.length > 0) {
                const ragText = ragResults.map(r => `[${r.timestamp}] ${r.text}`).join('\n');
                coreStr += `\n<RELEVANT_PAST_MEMORIES>\n${ragText}\n</RELEVANT_PAST_MEMORIES>\n`;
            }
        }
    }
    return coreStr;
}

export async function manageMemoryAction(action, fact) {
    const vaultDir = path.join(ROOT_DIR, 'vault');
    if (!(await fileExists(vaultDir))) {
        await fs.mkdir(vaultDir, { recursive: true });
    }
    const memFile = getMemoryPath();
    
    if (action === 'append') {
        const dateStr = new Date().toISOString().split('T')[0];
        const newFact = `- [${dateStr}] ${fact}\n`;
        await fs.appendFile(memFile, newFact, 'utf8');
        await addRagMemory(fact);
        return `Successfully remembered: ${fact}`;
    } else if (action === 'read' || action === 'search') {
        if (await fileExists(memFile)) return await fs.readFile(memFile, 'utf8') || "Memory is currently empty.";
        return "Memory is currently empty.";
    } else if (action === 'clear') {
        if (await fileExists(memFile)) await fs.writeFile(memFile, '', 'utf8');
        return "Memory cleared.";
    }
    return "Unknown memory action.";
}
