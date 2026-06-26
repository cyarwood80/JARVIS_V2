import { app, BrowserWindow } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;

async function getAgentName() {
    try {
        const configPath = path.join(__dirname, '..', '..', 'vault', 'agent_config.json');
        const raw = await fs.readFile(configPath, 'utf8');
        const config = JSON.parse(raw);
        return config.agentName || 'Agent';
    } catch {
        return 'Agent';
    }
}

function createWindow(agentName) {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        title: `${agentName} -- Hybrid AI Hub`,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        },
        autoHideMenuBar: true,
        backgroundColor: '#0f172a'
    });

    // Boot the Express server, then load its URL
    import('../api/server.js').then(() => {
        setTimeout(() => {
            mainWindow.loadURL('http://localhost:3000');
        }, 1000);
    }).catch(err => {
        console.error(`[Boot Error] Failed to start server:`, err.message);
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
        app.quit();
    });
}

app.whenReady().then(async () => {
    // Setup wizard already ran in bootstrap.js (plain Node process).
    // Here we just read the saved config and open the window.
    const agentName = await getAgentName();
    console.log(`[Electron] Starting UI for ${agentName}...`);
    createWindow(agentName);
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (mainWindow === null) createWindow('Agent');
});

