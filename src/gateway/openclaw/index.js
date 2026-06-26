const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

let agentName = "Agent";
try {
    // vault/agent_config.json lives at the project root — go up from src/gateway/openclaw/
    const configPath = path.join(__dirname, '..', '..', '..', 'vault', 'agent_config.json');
    if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (config.agentName) agentName = config.agentName;
    }
} catch (e) {
    // Keep default
}

let browserExecutablePath;
try {
    const puppeteerPath = require('puppeteer').executablePath();
    if (fs.existsSync(puppeteerPath)) {
        browserExecutablePath = puppeteerPath;
    } else {
        console.log(`[WARNING] Chrome missing at ${puppeteerPath}. Falling back to MS Edge...`);
        browserExecutablePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
        if (!fs.existsSync(browserExecutablePath)) {
            browserExecutablePath = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
        }
    }
} catch (e) {
    browserExecutablePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    if (!fs.existsSync(browserExecutablePath)) {
        browserExecutablePath = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
    }
}

console.log("-----------------------------------------");
console.log("  OpenClaw Gateway v2.0.0 (Traffic Master)");
console.log("-----------------------------------------");
console.log(`Initializing WhatsApp Puppeteer engine using: ${browserExecutablePath}`);

// Store conversation history and session state per user
const chatHistories = new Map();
const activeSessions = new Map();

// Large models that trigger a cold-start warning message
const LARGE_MODELS = new Set(['qwen2.5:32b', 'gemma4:26b']);
const SESSION_WINDOW_MS = 5 * 60 * 1000; // 5 minute active session window
const JARVIS_PROXY = 'http://127.0.0.1:3000/v1/chat/completions';

// Auto-cleanup: Force kill orphaned Chromium processes and delete lockfiles
console.log("Running auto-cleanup for leftover Puppeteer sessions...");
try {
    const sessionDir = path.join(__dirname, '.wwebjs_auth', 'session');
    execSync('Get-WmiObject Win32_Process -Filter "Name=\'chrome.exe\'" | Where-Object {$_.CommandLine -match "wwebjs_auth"} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }', { shell: 'powershell.exe', stdio: 'ignore' });
    const lockFile = path.join(sessionDir, 'lockfile');
    const devPortFile = path.join(sessionDir, 'DevToolsActivePort');
    const singletonLock = path.join(sessionDir, 'SingletonLock');
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
    if (fs.existsSync(devPortFile)) fs.unlinkSync(devPortFile);
    if (fs.existsSync(singletonLock)) fs.unlinkSync(singletonLock);
} catch (e) {
    // Ignore cleanup errors silently
}

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: browserExecutablePath,
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--disable-gpu'
        ]
    }
});

client.on('qr', (qr) => {
    console.log('\n[!] ACTION REQUIRED: Scan this QR code with WhatsApp (Linked Devices):');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('\n[SUCCESS] ✅ OpenClaw linked to WhatsApp!');
    if (process.argv.includes('--setup')) {
        console.log('Initial setup complete! Exiting setup mode...');
        process.exit(0);
    }
    console.log(`Listening for messages with wake word "${agentName.toLowerCase()}"...`);
});

client.on('message_create', async (msg) => {
    // Prevent infinite loops: ignore Agent's own replies
    if (msg.body.startsWith(`[${agentName}]`) || (msg.fromMe && msg.body.startsWith(`[${agentName}]`))) {
        return;
    }

    const isWakeWord = msg.body.toLowerCase().includes(agentName.toLowerCase());
    const sessionActive = activeSessions.has(msg.from) &&
        (Date.now() - activeSessions.get(msg.from) < SESSION_WINDOW_MS);

    // Only respond if message contains the agent's wake word or an active session is within the 5 min window
    if (!isWakeWord && !sessionActive) {
        console.log(`[IGNORED] No wake word from ${msg.from}`);
        return;
    }

    // Refresh session timestamp
    activeSessions.set(msg.from, Date.now());
    
    // Save admin number so the agent knows who to push autonomous messages to
    const adminFile = path.join(__dirname, 'admin.txt');
    fs.writeFileSync(adminFile, msg.from, 'utf8');

    let userText = msg.body;
    let images = undefined;

    if (msg.hasMedia) {
        try {
            const media = await msg.downloadMedia();
            if (media && media.mimetype.startsWith('image/')) {
                images = [media.data]; // Extract base64
                if (!userText.trim()) {
                    userText = "Please analyze this image.";
                }
            }
        } catch (e) {
            console.error("[MEDIA] Failed to download media:", e.message);
        }
    }

    console.log(`\n[INCOMING] From ${msg.from}: "${userText}" ${images ? '[+IMAGE]' : ''}`);

    // ──────────────────────────────────────────────────────────
    // STEP 1: IMMEDIATE ACKNOWLEDGMENT — fires < 1 second
    // User never waits in silence regardless of model cold-start
    // ──────────────────────────────────────────────────────────
    try {
        await msg.reply(`[${agentName}] ⚡ Request received — working on it...`);
        console.log('[ACK] Immediate acknowledgment sent to WhatsApp.');
    } catch (ackErr) {
        console.error('[ACK] Failed to send acknowledgment:', ackErr.message);
    }

    // ──────────────────────────────────────────────────────────
    // STEP 2: PEEK at the routing plan BEFORE calling the full proxy
    // This lets us send a cold-start warning if a large model is assigned
    // ──────────────────────────────────────────────────────────
    let planData = null;
    try {
        const planRes = await fetch('http://127.0.0.1:3000/api/plan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: buildHistory(msg.from, userText, images) })
        });
        if (planRes.ok) {
            const planBody = await planRes.json();
            planData = planBody.plan;
            console.log('[PLAN PEEK]', JSON.stringify(planData));

            // Send cold-start warning if a large model is assigned AND it might be cold
            if (planData && LARGE_MODELS.has(planData.local_model)) {
                const modelShortName = planData.local_model.split(':')[0];
                await msg.reply(
                    `[${agentName}] 🧠 Routing to ${modelShortName} — a specialist model for this task. ` +
                    `If it hasn't been used recently, this may take ~30s. Hang tight!`
                );
                console.log(`[COLD-START WARN] Sent large model warning for ${planData.local_model}`);
            } else if (planData && planData.needs_tool) {
                await msg.reply(`[${agentName}] 🔧 Running a system command on your PC, will report back shortly...`);
            }
        }
    } catch (planErr) {
        console.log('[PLAN PEEK] Could not fetch plan preview:', planErr.message);
        // Non-fatal — we still continue to the full proxy call
    }

    // ──────────────────────────────────────────────────────────
    // STEP 3: BUILD HISTORY & CALL THE FULL PROXY PIPELINE
    // ──────────────────────────────────────────────────────────
    if (!chatHistories.has(msg.from)) {
        chatHistories.set(msg.from, []);
    }
    const history = chatHistories.get(msg.from);
    const userMsg = { role: "user", content: userText };
    if (images) userMsg.images = images;
    history.push(userMsg);

    // Cap memory to last 10 messages
    if (history.length > 10) history.shift();

    try {
        console.log('[PROXY] Calling agent 3-stage pipeline...');
        const res = await fetch(JARVIS_PROXY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: history })
        });

        const data = await res.json();

        if (!res.ok || !data.choices) {
            console.error('[PROXY ERROR]', data.error || data);
            await msg.reply(`[${agentName}] ❌ System error — check the server logs for details.`);
            history.pop(); // Remove failed message from history
            return;
        }

        const responseText = data.choices[0].message.content;
        const modelChain = data.model || 'unknown';

        // Add assistant response to history
        history.push({ role: "assistant", content: responseText });

        console.log(`[ROUTED VIA] ${modelChain.toUpperCase()}`);
        console.log(`[RESPONSE] Sending to WhatsApp...`);

        // Send the final response
        await msg.reply(`[${agentName}] ` + responseText);
        console.log('[SUCCESS] Reply sent ✅');

    } catch (e) {
        console.error('[ERROR] Failed to reach Agent Proxy:', e.message);
        await msg.reply(`[${agentName}] ⚠️ I had trouble connecting to my neural net. Please check the server is running.`);
    }
});

/**
 * Build a message history snapshot for the plan-peek call.
 * Doesn't mutate the stored history — just creates a view.
 */
function buildHistory(sender, newMessage, images) {
    const existing = chatHistories.get(sender) || [];
    const userMsg = { role: "user", content: newMessage };
    if (images) userMsg.images = images;
    return [...existing, userMsg];
}

client.initialize();

// ==========================================
// PUSH API SERVER
// Listens for push requests from the agent core
// ==========================================
const app = express();
app.use(cors());
app.use(express.json());

app.post('/api/send', async (req, res) => {
    const adminFile = path.join(__dirname, 'admin.txt');
    if (!fs.existsSync(adminFile)) {
        return res.status(400).json({ error: 'No admin number registered. Send a message to OpenClaw first.' });
    }
    const target = fs.readFileSync(adminFile, 'utf8').trim();
    const { message } = req.body;
    
    if (!message) return res.status(400).json({ error: 'Message is required.' });

    try {
        await client.sendMessage(target, `[${agentName}] ` + message);
        console.log(`[PUSH] Sent autonomous message to ${target}`);
        res.json({ success: true });
    } catch (e) {
        console.error('[PUSH ERROR]', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.listen(3001, () => {
    console.log('[PUSH API] Listening on port 3001');
});
