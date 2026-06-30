/**
 * OpenClaw MCP Client
 * -------------------
 * Wraps the OpenClaw WhatsApp gateway as a local MCP-style capability provider.
 * Exposes the gateway's tools in a standard format so the ToolRegistry can merge
 * them alongside native tools and vault scripts.
 *
 * OpenClaw exposes:
 *  - whatsapp_send : Push a message to the admin's WhatsApp
 *  - whatsapp_status: Check if the OpenClaw gateway is connected
 *
 * Transport: HTTP at 127.0.0.1:3001 (local only — no cloud)
 */

const OPENCLAW_URL = 'http://127.0.0.1:3001';

/** Tool manifest for the OpenClaw gateway */
const OPENCLAW_TOOLS = [
    {
        name: 'whatsapp_send',
        description: 'Send a WhatsApp push message to the user via the OpenClaw gateway. Use for proactive notifications, alerts, or autonomous task summaries.',
        source: 'openclaw_gateway',
        icon: '📱',
        parameters: {
            type: 'object',
            properties: {
                message: {
                    type: 'string',
                    description: 'The message text to send. Will be prefixed with the agent name.'
                }
            },
            required: ['message']
        }
    },
    {
        name: 'whatsapp_status',
        description: 'Check whether the OpenClaw WhatsApp gateway is connected and ready to send messages.',
        source: 'openclaw_gateway',
        icon: '🔗',
        parameters: {
            type: 'object',
            properties: {}
        }
    }
];

export class OpenClawGateway {
    constructor(url = OPENCLAW_URL) {
        this.url = url;
        this.name = 'openclaw';
        this.connected = false;
    }

    /** Returns the static tool manifest for this gateway */
    getTools() {
        return OPENCLAW_TOOLS;
    }

    /** Checks gateway health and returns connection status */
    async checkStatus() {
        try {
            const res = await fetch(`${this.url}/api/status`, { signal: AbortSignal.timeout(2000) });
            this.connected = res.ok;
        } catch {
            this.connected = false;
        }
        return this.connected;
    }

    /**
     * Executes a gateway tool call.
     * @param {string} name  - Tool name (must match one from getTools())
     * @param {object} args  - Tool arguments
     * @returns {Promise<string>} Human-readable result string
     */
    async callTool(name, args) {
        if (name === 'whatsapp_status') {
            const ok = await this.checkStatus();
            return ok
                ? 'OpenClaw gateway is connected and ready to send WhatsApp messages.'
                : 'OpenClaw gateway is offline or not reachable at 127.0.0.1:3001.';
        }

        if (name === 'whatsapp_send') {
            if (!args.message) return 'Error: message argument is required.';
            try {
                const res = await fetch(`${this.url}/api/send`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: args.message }),
                    signal: AbortSignal.timeout(5000)
                });
                if (res.ok) return 'WhatsApp message sent successfully via OpenClaw.';
                const err = await res.text();
                return `WhatsApp send failed: ${err}`;
            } catch (e) {
                return `OpenClaw gateway error: ${e.message}. Ensure OpenClaw is running.`;
            }
        }

        return `Tool '${name}' not found in OpenClaw gateway.`;
    }
}

// Singleton instance
export const openClawGateway = new OpenClawGateway();
