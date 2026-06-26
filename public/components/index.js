document.addEventListener('DOMContentLoaded', () => {
    // ── UI ELEMENTS ──
    const pulsePath = document.getElementById('pulse-path');
    const statusLabel = document.getElementById('status-label');
    const chatInput = document.getElementById('chat-input');
    const sendBtn = document.getElementById('send-btn');
    const chatHistory = document.getElementById('chat-history');
    const navBtns = document.querySelectorAll('.nav-btn');
    const views = document.querySelectorAll('.view-section');

    // ── AGENT NAME (fetched from /api/config) ──
    let agentName = 'Agent';
    async function loadAgentName() {
        try {
            const res = await fetch('/api/config');
            const data = await res.json();
            agentName = data.agentName || 'Agent';
            // Update all dynamic name placeholders in the HTML
            const logoEl = document.getElementById('logo-name');
            const titleEl = document.getElementById('page-title');
            const welcomeEl = document.getElementById('welcome-agent-name');
            if (logoEl) logoEl.textContent = agentName;
            if (titleEl) titleEl.textContent = `${agentName} — Hybrid AI Hub`;
            if (welcomeEl) welcomeEl.textContent = agentName;
        } catch (e) {
            console.warn('Could not load agent config:', e);
        }
    }
    loadAgentName();

    navBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            navBtns.forEach(b => b.classList.remove('active'));
            views.forEach(v => v.classList.remove('active'));
            
            btn.classList.add('active');
            const target = btn.getAttribute('data-target');
            document.getElementById(target).classList.add('active');
        });
    });

    // ── MOTION GRAPHIC LOGIC (Pulse Line) ──
    let animationFrame;
    let time = 0;
    let currentState = 'idle'; // idle, cloud, local

    function drawPulse() {
        time += 0.05;
        let d = `M 0 100`;
        
        for (let i = 0; i <= 800; i += 10) {
            let y = 100;
            const x = i;
            const centerFactor = Math.max(0, 1 - Math.abs(x - 400) / 300);

            if (currentState === 'idle') {
                y += Math.sin(time + x * 0.01) * 5 * centerFactor;
            } else if (currentState === 'cloud') {
                y += Math.sin(time * 5 + x * 0.05) * 40 * centerFactor;
                y += Math.cos(time * 3 + x * 0.1) * 20 * centerFactor;
            } else if (currentState === 'local') {
                const pulse = Math.sin(time * 2) > 0.8 ? 50 : 0;
                y += pulse * Math.sin(x * 0.02) * centerFactor;
                y += Math.sin(time * 4 + x * 0.01) * 10 * centerFactor;
            }

            d += ` L ${x} ${y}`;
        }
        
        pulsePath.setAttribute('d', d);
        animationFrame = requestAnimationFrame(drawPulse);
    }
    drawPulse();

    function setSystemState(state, label) {
        currentState = state;
        pulsePath.className.baseVal = `pulse-path ${state}`;
        statusLabel.className = `status-label ${state}`;
        if (label) statusLabel.innerText = label;
    }

    // ── CHAT & WEBSOCKET LOGIC ──
    function addMessage(role, text) {
        const div = document.createElement('div');
        div.className = `message ${role}-msg`;
        div.innerHTML = `<strong>${role === 'user' ? 'You' : agentName}:</strong><br><span class="message-text">${text}</span>`;
        chatHistory.appendChild(div);
        chatHistory.scrollTop = chatHistory.scrollHeight;
    }

    // ── CONVERSATION HISTORY ──
    let activeConvId = null;
    let chatMessages = [];

    function formatRelativeTime(isoStr) {
        const d = new Date(isoStr);
        const now = new Date();
        const diffMs = now - d;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);
        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        if (diffDays === 1) return 'Yesterday';
        return d.toLocaleDateString();
    }

    async function renderConvList() {
        try {
            const res = await fetch('/api/conversations');
            const convs = await res.json();
            const list = document.getElementById('conv-list');
            if (!list) return;
            list.innerHTML = '';

            if (convs.length === 0) {
                list.innerHTML = '<div class="conv-section-label">No past conversations</div>';
                return;
            }

            list.innerHTML = '<div class="conv-section-label">Recent</div>';
            convs.forEach(conv => {
                const item = document.createElement('div');
                item.className = 'conv-item' + (conv.id === activeConvId ? ' active' : '');
                item.dataset.id = conv.id;
                item.innerHTML = `
                    <div class="conv-item-text">
                        <div class="conv-item-title">${conv.title}</div>
                        <div class="conv-item-meta">${formatRelativeTime(conv.createdAt)} · ${conv.messageCount} msgs</div>
                    </div>
                    <button class="conv-delete-btn" data-id="${conv.id}" title="Delete">&#x2715;</button>
                `;
                item.querySelector('.conv-item-text').addEventListener('click', () => loadConversation(conv.id));
                item.querySelector('.conv-delete-btn').addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (!confirm(`Delete "${conv.title}"?`)) return;
                    await fetch(`/api/conversations/${conv.id}`, { method: 'DELETE' });
                    if (conv.id === activeConvId) startNewChat();
                    else renderConvList();
                });
                list.appendChild(item);
            });
        } catch (e) { console.error('Conv list error:', e); }
    }

    async function loadConversation(id) {
        try {
            const res = await fetch(`/api/conversations/${id}/load`, { method: 'POST' });
            const conv = await res.json();
            activeConvId = conv.id;
            chatMessages = conv.messages;
            const histEl = document.getElementById('chat-history');
            histEl.innerHTML = '';
            conv.messages.forEach(m => addMessage(m.role === 'assistant' ? 'agent' : 'user', m.content));
            renderConvList();
        } catch (e) { console.error('Load conv error:', e); }
    }

    async function startNewChat() {
        try {
            const res = await fetch('/api/conversations/new', { method: 'POST' });
            const conv = await res.json();
            activeConvId = conv.id;
            chatMessages = [];
            const histEl = document.getElementById('chat-history');
            histEl.innerHTML = `<div class="message system-msg">New conversation started. How can I help?</div>`;
            renderConvList();
        } catch (e) { console.error('New chat error:', e); }
    }

    async function initConversation() {
        try {
            const res = await fetch('/api/conversations/active');
            const conv = await res.json();
            activeConvId = conv.id;
            chatMessages = conv.messages;
            if (conv.messages.length > 0) {
                conv.messages.forEach(m => addMessage(m.role === 'assistant' ? 'agent' : 'user', m.content));
            }
            renderConvList();
        } catch (e) { console.error('Init conv error:', e); }
    }

    document.getElementById('new-chat-btn')?.addEventListener('click', startNewChat);

    sendBtn.addEventListener('click', async () => {
        const text = chatInput.value.trim();
        if (!text) return;
        
        addMessage('user', text);
        chatInput.value = '';
        chatInput.style.height = 'auto';
        chatMessages.push({ role: "user", content: text });

        setSystemState('cloud', 'ORCHESTRATOR PLANNING (GEMINI)');
        
        try {
            const res = await fetch('/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: chatMessages })
            });
            const data = await res.json();
            
            if (!res.ok) {
                throw new Error(data.error || 'Server returned an error');
            }
            
            const reply = data.choices[0].message.content;
            addMessage('agent', reply);
            chatMessages.push({ role: "assistant", content: reply });
        } catch (e) {
            addMessage('agent', `[Error] ${e.message}`);
        }
        
        setSystemState('idle', 'IDLE');
        fetchStats();
    });

    chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendBtn.click();
        }
    });

    chatInput.addEventListener('input', () => {
        chatInput.style.height = 'auto';
        chatInput.style.height = (chatInput.scrollHeight) + 'px';
    });

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}`);
    const terminalOutput = document.getElementById('terminal-output');

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'log') {
            const div = document.createElement('div');
            div.textContent = data.message;
            if (data.message.includes('[ERROR]')) div.className = 'log-error';
            else if (data.message.includes('▄') || data.message.includes('█')) div.className = 'log-success qr-code';
            else div.className = 'log-success';
            
            if (terminalOutput) {
                terminalOutput.appendChild(div);
                terminalOutput.scrollTop = terminalOutput.scrollHeight;
            }
        } else if (data.type === 'status') {
            if (data.stage === 'thinking') setSystemState('cloud', data.message.toUpperCase());
            else if (data.stage === 'routing') setSystemState('local', `JSON MAP RETURNED: ${data.message.toUpperCase()}`);
            else if (data.stage === 'executing' || data.stage === 'generating' || data.stage === 'synthesising') setSystemState('local', data.message.toUpperCase());
            else if (data.stage === 'done') setSystemState('idle', 'IDLE');
        } else if (data.type === 'conv_updated') {
            // Live-update sidebar when a conversation title is set
            renderConvList();
        }
    };

    if (document.getElementById('clear-logs-btn')) {
        document.getElementById('clear-logs-btn').addEventListener('click', () => {
            if (terminalOutput) terminalOutput.innerHTML = '';
        });
    }

    // ── POLLING: STATS, MODELS, SCRIPTS ──
    async function fetchStats() {
        if (!document.getElementById('system-view').classList.contains('active')) return;
        try {
            const res = await fetch('/api/stats');
            const stats = await res.json();
            
            document.getElementById('cpu-val').innerText = stats.cpu;
            document.getElementById('cpu-bar').style.width = `${stats.cpu}%`;
            document.getElementById('mem-val').innerText = stats.memory;
            document.getElementById('mem-bar').style.width = `${stats.memory}%`;
            document.getElementById('disk-val').innerText = stats.disk;
            document.getElementById('disk-bar').style.width = `${stats.disk}%`;
            document.getElementById('gpu-val').innerText = stats.gpu || '0';
            document.getElementById('gpu-bar').style.width = `${stats.gpu || 0}%`;
            document.getElementById('vram-val').innerText = stats.vram || '0';
            document.getElementById('vram-bar').style.width = `${stats.vram || 0}%`;

            if (stats.metrics) {
                if (document.getElementById('public-session-tokens-val')) {
                    document.getElementById('public-session-tokens-val').innerText = stats.metrics.sessionTokensPublic || 0;
                    document.getElementById('public-historic-tokens-val').innerText = stats.metrics.historicTokensPublic || 0;
                    document.getElementById('local-session-tokens-val').innerText = stats.metrics.sessionTokensLocal || 0;
                    document.getElementById('local-historic-tokens-val').innerText = stats.metrics.historicTokensLocal || 0;
                }
                
                // Update sidebar live tokens (we'll show session tokens here as it's the live session)
                if (document.getElementById('nav-cloud-tokens')) {
                    document.getElementById('nav-cloud-tokens').innerText = stats.metrics.sessionTokensPublic || 0;
                    document.getElementById('nav-local-tokens').innerText = stats.metrics.sessionTokensLocal || 0;
                }
            }
        } catch (e) { console.error('Stats error:', e); }
    }

    async function fetchModels() {
        if (!document.getElementById('models-view').classList.contains('active')) return;
        try {
            const res = await fetch('/api/warmth');
            const data = await res.json();
            const grid = document.getElementById('models-grid');
            grid.innerHTML = '';
            
            for (const [modelId, details] of Object.entries(data)) {
                const warmthClass = details.warm ? 'warm' : 'cold';
                const html = `
                    <div class="model-fleet-card ${warmthClass}">
                        <div class="model-fleet-header">
                            <span class="model-warmth-badge ${warmthClass}">${details.warm ? 'WARM' : 'COLD'}</span>
                        </div>
                        <div class="model-fleet-name">${modelId}</div>
                        <div class="model-fleet-role">${details.info?.role || 'Unknown'}</div>
                        <div class="model-fleet-meta">
                            <span>Last used: ${details.lastUsed ? new Date(details.lastUsed).toLocaleTimeString() : 'Never'}</span>
                        </div>
                    </div>
                `;
                grid.innerHTML += html;
            }
        } catch (e) { console.error('Models error:', e); }
    }

    async function fetchScripts() {
        if (!document.getElementById('vault-view').classList.contains('active')) return;
        try {
            const res = await fetch('/api/scripts');
            const data = await res.json();
            const grid = document.getElementById('vault-grid');
            grid.innerHTML = '';
            
            if (data.scripts.length === 0) {
                grid.innerHTML = '<div class="model-fleet-card"><div>No scripts found in Automation Vault.</div></div>';
                return;
            }
            
            data.scripts.forEach(script => {
                const html = `
                    <div class="model-fleet-card warm">
                        <div class="model-fleet-name">${script.name}</div>
                        <div class="model-fleet-role">${script.description || 'Automation Script'}</div>
                    </div>
                `;
                grid.innerHTML += html;
            });
        } catch (e) { console.error('Scripts error:', e); }
    }

    setInterval(fetchStats, 500);
    setInterval(fetchModels, 5000);
    setInterval(fetchScripts, 10000);
    
    // Initial fetches
    initConversation();
    fetchStats();
    fetchModels();
    fetchScripts();
});

