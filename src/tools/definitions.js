export const toolDefinitions = [
    {
        name: "get_pc_diagnostics",
        description: "Get current CPU, RAM, and Disk usage percentages of the local system.",
        parameters: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "execute_command",
        description: "Run any PowerShell command on the user's Windows PC.",
        parameters: {
            type: "object",
            properties: {
                command: {
                    type: "string",
                    description: "The PowerShell command to execute."
                }
            },
            required: ["command"]
        }
    },
    {
        name: "open_application",
        description: "Launch a Windows application by name.",
        parameters: {
            type: "object",
            properties: {
                appName: {
                    type: "string",
                    description: "The name or executable of the application (e.g. notepad)."
                }
            },
            required: ["appName"]
        }
    },
    {
        name: "save_script",
        description: "Save a reusable script to the automation vault.",
        parameters: {
            type: "object",
            properties: {
                scriptName: {
                    type: "string",
                    description: "Name of the script (e.g., myscript.ps1 or myscript.js)."
                },
                description: {
                    type: "string",
                    description: "A short description of what the script does."
                },
                code: {
                    type: "string",
                    description: "The code content of the script."
                }
            },
            required: ["scriptName", "description", "code"]
        }
    },
    {
        name: "run_saved_script",
        description: "Run a saved script from the automation vault.",
        parameters: {
            type: "object",
            properties: {
                scriptName: {
                    type: "string",
                    description: "Name of the script to run."
                },
                args: {
                    type: "string",
                    description: "Any arguments to pass to the script."
                }
            },
            required: ["scriptName"]
        }
    },
    {
        name: "list_scripts",
        description: "List all saved scripts in the automation vault.",
        parameters: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "search_web",
        description: "Search the live internet for information.",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "The search query."
                }
            },
            required: ["query"]
        }
    },
    {
        name: "whatsapp_push",
        description: "Send a WhatsApp message to the user.",
        parameters: {
            type: "object",
            properties: {
                message: {
                    type: "string",
                    description: "The text message to send."
                }
            },
            required: ["message"]
        }
    },
    {
        name: "desktop_notify",
        description: "Pop up a Windows desktop notification.",
        parameters: {
            type: "object",
            properties: {
                title: {
                    type: "string",
                    description: "The notification title."
                },
                message: {
                    type: "string",
                    description: "The notification body."
                }
            },
            required: ["message"]
        }
    },
    {
        name: "browser_open",
        description: "Launch the interactive browser and navigate to a URL.",
        parameters: {
            type: "object",
            properties: {
                url: { type: "string", description: "The full URL to browse." }
            },
            required: ["url"]
        }
    },
    {
        name: "browser_click",
        description: "Click an element in the active interactive browser.",
        parameters: {
            type: "object",
            properties: {
                selector: { type: "string", description: "CSS selector of the element to click." }
            },
            required: ["selector"]
        }
    },
    {
        name: "browser_type",
        description: "Type text into an element in the active interactive browser.",
        parameters: {
            type: "object",
            properties: {
                selector: { type: "string", description: "CSS selector of the input element." },
                text: { type: "string", description: "The text to type." }
            },
            required: ["selector", "text"]
        }
    },
    {
        name: "browser_extract",
        description: "Extract all text from the current page in the active interactive browser.",
        parameters: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "browser_close",
        description: "Close the active interactive browser session.",
        parameters: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "manage_memory",
        description: "Add or remove facts from the RAG memory core.",
        parameters: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    description: "Either 'add' or 'remove'."
                },
                fact: {
                    type: "string",
                    description: "The fact to remember or forget."
                }
            },
            required: ["action", "fact"]
        }
    }
];
