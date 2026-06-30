import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();

async function checkModels() {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
        console.log("No key found in .env");
        return;
    }
    
    try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
        const data = await res.json();
        console.log("Models found:", data.models ? data.models.length : 0);
        if (data.models) {
            const useful = data.models
                .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
                .map(m => m.name.replace('models/', ''));
            console.log(useful);
        } else {
            console.log(data);
        }
    } catch (e) {
        console.error(e);
    }
}

checkModels();
