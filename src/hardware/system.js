import activeWin from 'active-win';
import clipboardy from 'clipboardy';
import si from 'systeminformation';
import { exec } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GEMINI_API_KEY, PORT, ROOT_DIR } from '../../config/index.js';
import cron from 'node-cron';
import chokidar from 'chokidar';
import fsPromises from 'fs/promises';

export let activeWindowContext = "Unknown";
export let clipboardContext = "Empty";

export function startContextMonitors() {
    setInterval(async () => {
        try {
            const win = await activeWin();
            activeWindowContext = win ? `[${win.owner?.name || win.title}] ${win.title}` : "Unknown";
        } catch(e) {}
        try {
            const text = await clipboardy.read();
            clipboardContext = text ? text.substring(0, 500) : "Empty";
        } catch(e) {}
    }, 2000);
}

export function startProactiveAgency(broadcastMsg) {
    // Run all user-created scripts in the autonomous folder every 5 minutes natively
    cron.schedule('*/5 * * * *', async () => {
        const autoDir = path.join(ROOT_DIR, 'scripts', 'autonomous');
        try {
            await fsPromises.access(autoDir);
            const files = await fsPromises.readdir(autoDir);
            for (const file of files) {
                if (file.endsWith('.ps1')) {
                    exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(autoDir, file)}"`);
                } else if (file.endsWith('.js')) {
                    exec(`node "${path.join(autoDir, file)}"`);
                }
            }
        } catch (e) {
            // Folder doesn't exist yet, which is fine
        }
    });
}

export function setupAutonomousSensors() {
    // LLM Autonomous heartbeat removed in favor of script-based monitoring

    const downloadsFolder = path.join(process.env.USERPROFILE || process.env.HOME, 'Downloads');
    fsPromises.access(downloadsFolder).then(() => {
        console.log(`   [SENSOR] Watching ${downloadsFolder} for new files...`);
        chokidar.watch(downloadsFolder, { ignoreInitial: true, depth: 1 }).on('add', async (filePath) => {
            console.log(`[SENSOR] New file detected: ${filePath}`);
            const prompt = `[FILE SENSOR ALERT] A new file was just downloaded to the Downloads folder: ${filePath}. Analyze this event. Does it look like a normal download, or suspicious? Use execute_command to get file details if necessary. You MUST proactively notify the user about this file using the whatsapp_push tool. Do not use desktop_notify for file downloads.`;
            
            try {
                await fetch(`http://localhost:${PORT}/v1/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] })
                });
            } catch (e) {
                console.error('[SENSOR] Failed to trigger file alert:', e.message);
            }
        });
    }).catch(() => {});
}

export async function getPcDiagnostics() {
    const [cpu, mem, disk, graphics] = await Promise.all([si.currentLoad(), si.mem(), si.fsSize(), si.graphics()]);
    const mainDisk = disk.find(d => d.mount === 'C:') || disk[0];
    
    let gpuLoad = 0;
    let vramUsage = 0;
    if (graphics && graphics.controllers && graphics.controllers.length > 0) {
        const gpu = graphics.controllers[0];
        gpuLoad = gpu.utilizationGpu || 0;
        if (gpu.memoryTotal && gpu.memoryUsed) {
            vramUsage = Math.round((gpu.memoryUsed / gpu.memoryTotal) * 100);
        }
    }

    return {
        cpu: Math.round(cpu.currentLoad),
        memory: Math.round((mem.active / mem.total) * 100),
        disk: mainDisk ? Math.round(mainDisk.use) : 0,
        gpu: gpuLoad,
        vram: vramUsage
    };
}
