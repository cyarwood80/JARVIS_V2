import express from 'express';
import { exec } from 'child_process';
import cors from 'cors';
import path from 'path';
import { WebSocketServer } from 'ws';
import { PORT, ROOT_DIR, AGENT_NAME } from '../../config/index.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(ROOT_DIR, 'public')));

import { Orchestrator } from '../orchestrator/index.js';
import { addRagMemory } from '../memory/rag.js';
import { toolRegistry } from '../gateway/toolRegistry.js';
import { resolveApproval } from '../agents/supervisor.js';
import { GEMINI_API_KEY, updateCloudSettings, CLOUD_MODEL } from '../../config/index.js';
import { listDaemons, killDaemon, setDaemonBroadcaster } from '../daemon/manager.js';

import { METRICS, MODEL_REGISTRY, modelWarmth, COLD_THRESHOLD_MS, loadMetrics } from '../../config/index.js';
import { getPcDiagnostics } from '../hardware/system.js';
import { generateSpeechBuffer } from '../voice/tts.js';

// Give daemon manager access to broadcast events
setDaemonBroadcaster((msgObj) => {
    wss.clients.forEach(c => {
        if (c.readyState === 1) {
            c.send(JSON.stringify(msgObj));
        }
    });
});

import fs from 'fs/promises';

const orchestrator = new Orchestrator();

// ── CONVERSATION PERSISTENCE ──────────────────────────────────────────────────
const CONV_DIR = path.join(ROOT_DIR, 'vault', 'conversations');

async function ensureConvDir() {
    await fs.mkdir(CONV_DIR, { recursive: true });
}

function newConversationId() {
    return `conv_${Date.now()}`;
}

async function saveConversation(conv) {
    await ensureConvDir();
    await fs.writeFile(path.join(CONV_DIR, `${conv.id}.json`), JSON.stringify(conv, null, 2), 'utf8');
}

async function loadConversation(id) {
    try {
        const raw = await fs.readFile(path.join(CONV_DIR, `${id}.json`), 'utf8');
        return JSON.parse(raw);
    } catch { return null; }
}

async function listConversations() {
    await ensureConvDir();
    const files = await fs.readdir(CONV_DIR);
    const convs = [];
    for (const f of files.filter(f => f.endsWith('.json')).reverse()) {
        try {
            const raw = await fs.readFile(path.join(CONV_DIR, f), 'utf8');
            const { id, title, createdAt, messages } = JSON.parse(raw);
            convs.push({ id, title, createdAt, messageCount: messages.length });
        } catch {}
    }
    return convs;
}

// Active conversation state
let activeConversation = null;

async function getOrCreateConversation() {
    if (!activeConversation) {
        activeConversation = {
            id: newConversationId(),
            title: 'New Conversation',
            createdAt: new Date().toISOString(),
            messages: []
        };
    }
    return activeConversation;
}
// ─────────────────────────────────────────────────────────────────────────────

// Minimal API for UI testing
app.get('/api/config', (req, res) => {
    res.json({ agentName: AGENT_NAME });
});

// ── CONVERSATION API ──
app.get('/api/conversations', async (req, res) => {
    res.json(await listConversations());
});

app.get('/api/conversations/active', async (req, res) => {
    const conv = await getOrCreateConversation();
    res.json(conv);
});

app.post('/api/conversations/new', async (req, res) => {
    // Save current conversation before creating a new one
    if (activeConversation && activeConversation.messages.length > 0) {
        await saveConversation(activeConversation);
    }
    activeConversation = {
        id: newConversationId(),
        title: 'New Conversation',
        createdAt: new Date().toISOString(),
        messages: []
    };
    res.json(activeConversation);
});

app.post('/api/conversations/:id/load', async (req, res) => {
    // Save current conversation first
    if (activeConversation && activeConversation.messages.length > 0) {
        await saveConversation(activeConversation);
    }
    const conv = await loadConversation(req.params.id);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    activeConversation = conv;
    res.json(conv);
});

app.delete('/api/conversations/:id', async (req, res) => {
    try {
        await fs.unlink(path.join(CONV_DIR, `${req.params.id}.json`));
        if (activeConversation?.id === req.params.id) activeConversation = null;
        res.json({ success: true });
    } catch { res.status(404).json({ error: 'Not found' }); }
});

// ── TOOLS API — all registered tools (native + gateway + vault) ──────────────
app.get('/api/tools', (req, res) => {
    const all = toolRegistry.getAllTools();
    res.json(all);
});

// ── SETTINGS API ──────────────
app.get('/api/settings/cloud', (req, res) => {
    res.json({
        hasApiKey: !!GEMINI_API_KEY,
        cloudModel: CLOUD_MODEL || 'gemini-1.5-pro'
    });
});

app.post('/api/settings/cloud', async (req, res) => {
    const { apiKey, cloudModel } = req.body;
    
    // We only strictly require at least one thing to be updated
    if (!apiKey && !cloudModel) return res.status(400).json({ error: 'Nothing to update' });

    const success = await updateCloudSettings(apiKey, cloudModel);
    if (success) {
        // Invalidate models
        orchestrator.invalidateModel();
        
        wss.clients.forEach(c => {
            if (c.readyState === 1) {
                c.send(JSON.stringify({ type: 'log', message: 'Cloud API settings updated successfully.' }));
            }
        });
        
        res.json({ success: true, message: 'Cloud settings updated and applied.' });
    } else {
        res.status(500).json({ error: 'Failed to update Cloud Settings' });
    }
});

// ── DAEMON API ──────────────
app.get('/api/daemons', (req, res) => {
    res.json(listDaemons());
});

app.post('/api/daemons/kill', (req, res) => {
    const { id } = req.body;
    if (killDaemon(id)) {
        res.json({ success: true });
    } else {
        res.status(400).json({ error: 'Failed to kill daemon or daemon not found.' });
    }
});

app.get('/api/settings/cloud/models', async (req, res) => {
    const key = GEMINI_API_KEY;
    const defaultModels = ['gemini-pro-latest', 'gemini-3.1-pro-preview', 'gemini-3.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash'];
    
    if (!key) {
        return res.json({ models: defaultModels });
    }
    
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
        if (!response.ok) throw new Error('API request failed');
        const data = await response.json();
        
        if (data.models) {
            const useful = data.models
                .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
                .map(m => m.name.replace('models/', ''))
                // Sort to put Pro/Thinking models first
                .sort((a, b) => {
                    if (a.includes('pro') && !b.includes('pro')) return -1;
                    if (!a.includes('pro') && b.includes('pro')) return 1;
                    return 0;
                });
            return res.json({ models: useful });
        }
        res.json({ models: defaultModels });
    } catch (e) {
        console.error('Failed to query Gemini models:', e.message);
        res.json({ models: defaultModels });
    }
});

app.get('/api/stats', async (req, res) => {
    try {
        const stats = await getPcDiagnostics();
        res.json({ ...stats, metrics: METRICS, registry: MODEL_REGISTRY });
    } catch {
        res.status(500).json({ error: 'Failed' });
    }
});

app.get('/api/warmth', (req, res) => {
    const status = {};
    for (const model of Object.keys(MODEL_REGISTRY)) {
        const lastUsed = modelWarmth[model] || 0;
        status[model] = {
            warm: lastUsed > 0 && (Date.now() - lastUsed) < COLD_THRESHOLD_MS,
            lastUsed: lastUsed > 0 ? new Date(lastUsed).toISOString() : null,
            info: MODEL_REGISTRY[model]
        };
    }
    res.json(status);
});

app.get('/api/scripts', async (req, res) => {
    const scriptsDir = path.join(ROOT_DIR, 'scripts');
    try {
        await fs.access(scriptsDir);
        
        async function getFiles(dir, prefix = '') {
            let results = [];
            const list = await fs.readdir(dir, { withFileTypes: true });
            for (const file of list) {
                if (file.isDirectory()) {
                    const subResults = await getFiles(path.join(dir, file.name), path.join(prefix, file.name));
                    results = results.concat(subResults);
                } else if (file.name.endsWith('.ps1') || file.name.endsWith('.js')) {
                    const relPath = path.join(prefix, file.name).replace(/\\/g, '/');
                    results.push(relPath);
                }
            }
            return results;
        }
        
        const files = await getFiles(scriptsDir);
        let meta = {};
        try { meta = JSON.parse(await fs.readFile(path.join(scriptsDir, 'meta.json'), 'utf8')); } catch {}
        res.json({ scripts: files.map(f => ({ name: f, description: meta[f] || meta[path.basename(f)] || '', size: 0 })) });
    } catch {
        res.json({ scripts: [] });
    }
});

app.post('/api/scripts/delete', async (req, res) => {
    try {
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: 'Script name required' });
        
        const normalizedName = path.normalize(name).replace(/^(\.\.[\/\\])+/, '');
        const targetPath = path.join(ROOT_DIR, 'scripts', normalizedName);
        
        if (!targetPath.startsWith(path.join(ROOT_DIR, 'scripts'))) {
            return res.status(403).json({ error: 'Invalid path' });
        }
        
        await fs.unlink(targetPath);
        
        if (typeof orchestrator !== 'undefined' && orchestrator.invalidateModel) {
            orchestrator.invalidateModel();
        }
        
        res.json({ success: true });
    } catch (err) {
        console.error('Failed to delete script:', err);
        res.status(500).json({ error: 'Deletion failed' });
    }
});

// Legacy history API (reads from active conversation)
app.get('/api/history', async (req, res) => {
    const conv = await getOrCreateConversation();
    res.json(conv.messages);
});

app.delete('/api/history', async (req, res) => {
    if (activeConversation) {
        activeConversation.messages = [];
        activeConversation.title = 'New Conversation';
        await saveConversation(activeConversation);
    }
    res.json({ success: true });
});

app.post('/api/tts', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text) return res.status(400).json({ error: 'Text required' });
        
        const buffer = await generateSpeechBuffer(text);
        res.set('Content-Type', 'audio/wav');
        res.send(buffer);
    } catch (err) {
        console.error('TTS Error:', err);
        res.status(500).json({ error: 'TTS failed' });
    }
});

app.post('/v1/chat/completions', async (req, res) => {
    let messages = req.body.messages || [];
    const userQuestion = messages[messages.length - 1]?.content || "";
    const userImage = messages[messages.length - 1]?.image || null;
    
    const conv = await getOrCreateConversation();
    
    // Save user message (omitting base64 image from permanent text logs to save space)
    if (userQuestion || userImage) {
        conv.messages.push({ role: 'user', content: userQuestion || "[Image]" });
        // Auto-title from first message
        if (conv.messages.filter(m => m.role === 'user').length === 1) {
            conv.title = userQuestion.length > 50 ? userQuestion.slice(0, 47) + '...' : (userQuestion || "Image Request");
        }
    }
    
    // Broadcast helper
    const broadcastMsg = (msgObj) => {
        const payload = JSON.stringify(msgObj);
        for (const client of wss.clients) {
            if (client.readyState === 1) client.send(payload);
        }
    };
    
    broadcastMsg({ type: 'status', stage: 'thinking', message: `Orchestrator analyzing intent...` });
    
    try {
        const userMsgCount = conv.messages.filter(m => m.role === 'user').length;
        let responseData;
        
        if (userMsgCount === 1 || userImage) {
            responseData = await orchestrator.processIntent(userQuestion, conv.messages.slice(0, -1), broadcastMsg, userImage);
        } else {
            responseData = await orchestrator.processIntentLocalFirst(userQuestion, conv.messages.slice(0, -1), broadcastMsg);
        }
        
        const responseText = responseData.text || "No response generated.";
        const modelUsed = responseData.modelUsed || "hybrid-engine";
        
        broadcastMsg({ type: 'status', stage: 'done', message: '' });
        res.json({
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: modelUsed,
            choices: [{ message: { role: "assistant", content: responseText } }]
        });
        
        // Save assistant message and persist
        conv.messages.push({ role: 'assistant', content: responseText });
        await saveConversation(conv);
        
        // Broadcast updated conversation list
        broadcastMsg({ type: 'conv_updated', id: conv.id, title: conv.title });
        
        addRagMemory(`User: ${userQuestion}\n${AGENT_NAME}: ${responseText}`);
    } catch (e) {
        broadcastMsg({ type: 'status', stage: 'done', message: '' });
        res.status(500).json({ error: e.message });
    }
});

import { spawn } from 'child_process';

let openClawProcess = null;

await loadMetrics();

// Discover all tools before accepting requests
await toolRegistry.discover();

const server = app.listen(PORT, async () => {
    const url = `http://localhost:${PORT}`;
    console.log(`\n${AGENT_NAME} Hub running on ${url}`);
    
    // Auto-start OpenClaw silently in background
    const openClawDir = path.join(ROOT_DIR, 'src', 'gateway', 'openclaw');
    try {
        await fs.access(openClawDir);
        console.log(`   Starting OpenClaw Gateway silently in background...`);
        openClawProcess = spawn('node', ['index.js'], { cwd: openClawDir });
        
        openClawProcess.stdout.on('data', d => {
            const payload = JSON.stringify({ type: 'log', message: d.toString().trim() });
            for (const client of wss.clients) {
                if (client.readyState === 1) client.send(payload);
            }
        });
        
        openClawProcess.stderr.on('data', d => {
            const payload = JSON.stringify({ type: 'log', message: `[ERROR] ${d.toString().trim()}` });
            for (const client of wss.clients) {
                if (client.readyState === 1) client.send(payload);
            }
        });
        
        openClawProcess.on('close', c => { openClawProcess = null; });
    } catch (e) {
        console.log("   OpenClaw directory not found or error starting it.", e.message);
    }

    // Auto-launch Agent UI in default browser (handled by Electron main.js)
    console.log(`[SYSTEM] ${AGENT_NAME} Server running. Waiting for Desktop App to connect...`);
});

const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
    ws.send(JSON.stringify({ type: 'log', message: `🔗 Connected to V2 Console...` }));

    // Handle UI → Server messages (approval gate responses)
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            // Approval gate: user responded to an approval_required event
            if (msg.type === 'approval_response' && msg.requestId && msg.decision) {
                resolveApproval(msg.requestId, msg.decision);
                console.log(`[APPROVAL] ${msg.requestId} → ${msg.decision}`);
            }
        } catch (e) {
            console.error('[WS] Failed to parse message:', e.message);
        }
    });
});

process.on('SIGINT', () => {
    if (openClawProcess) openClawProcess.kill('SIGKILL');
    process.exit();
});
