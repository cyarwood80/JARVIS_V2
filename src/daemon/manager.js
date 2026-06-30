import { spawn } from 'child_process';
import path from 'path';
import { ROOT_DIR } from '../../config/index.js';

// Registry of active daemon processes
// Map<string, { id: string, name: string, pid: number, startTime: number, process: ChildProcess }>
const daemons = new Map();

// Global reference to the websocket broadcaster
let wsBroadcast = null;

export function setDaemonBroadcaster(broadcaster) {
    wsBroadcast = broadcaster;
}

export function startDaemon(scriptName, argsStr = '') {
    const isNode = scriptName.endsWith('.js');
    const scriptPath = path.join(ROOT_DIR, 'scripts', scriptName);
    
    // Parse args if any
    const argsArray = argsStr.split(' ').filter(a => a.trim().length > 0);
    
    let command, spawnArgs;
    if (isNode) {
        command = 'node';
        spawnArgs = [scriptPath, ...argsArray];
    } else {
        command = 'powershell.exe';
        spawnArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...argsArray];
    }

    const id = `daemon_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const startTime = Date.now();
    
    const child = spawn(command, spawnArgs, {
        cwd: path.dirname(scriptPath)
    });
    
    daemons.set(id, {
        id,
        name: scriptName,
        pid: child.pid,
        startTime,
        process: child
    });
    
    const sendLog = (message, isError = false) => {
        if (wsBroadcast) {
            wsBroadcast({ type: 'daemon_log', id, name: scriptName, message, isError });
        }
    };
    
    sendLog(`[DAEMON STARTED] PID: ${child.pid}`);

    child.stdout.on('data', (data) => {
        sendLog(data.toString().trim());
    });

    child.stderr.on('data', (data) => {
        sendLog(data.toString().trim(), true);
    });

    child.on('close', (code) => {
        sendLog(`[DAEMON EXITED] Code: ${code}`);
        daemons.delete(id);
        if (wsBroadcast) wsBroadcast({ type: 'daemon_status_update' });
    });
    
    child.on('error', (err) => {
        sendLog(`[DAEMON ERROR] ${err.message}`, true);
        daemons.delete(id);
        if (wsBroadcast) wsBroadcast({ type: 'daemon_status_update' });
    });
    
    if (wsBroadcast) wsBroadcast({ type: 'daemon_status_update' });

    return { id, pid: child.pid, name: scriptName };
}

export function killDaemon(id) {
    const daemon = daemons.get(id);
    if (!daemon) return false;
    
    try {
        // Kill the process tree (Powershell often spawns children)
        if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', daemon.pid, '/f', '/t']);
        } else {
            daemon.process.kill('SIGKILL');
        }
        daemons.delete(id);
        if (wsBroadcast) wsBroadcast({ type: 'daemon_status_update' });
        return true;
    } catch (e) {
        console.error("Failed to kill daemon", e);
        return false;
    }
}

export function listDaemons() {
    return Array.from(daemons.values()).map(d => ({
        id: d.id,
        name: d.name,
        pid: d.pid,
        startTime: d.startTime
    }));
}
