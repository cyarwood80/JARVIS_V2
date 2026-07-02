import { KokoroTTS } from "kokoro-js";
import wavefilePkg from "wavefile";
const { WaveFile } = wavefilePkg;

let ttsInstance = null;

export async function initTTS() {
    if (!ttsInstance) {
        console.log('[TTS] Initializing Kokoro-82M ONNX model...');
        ttsInstance = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
            dtype: "q8",
            device: "cpu",
        });
        console.log('[TTS] Kokoro-82M initialized.');
    }
    return ttsInstance;
}

export async function generateSpeechBuffer(text, voice = "af_heart") {
    const engine = await initTTS();
    console.log(`[TTS] Generating speech for text: "${text.substring(0, 30)}..." with voice ${voice}`);
    const audio = await engine.generate(text, { voice });
    
    let wav = new WaveFile();
    // 1 channel, 24000 sample rate, 32-bit float
    wav.fromScratch(1, 24000, '32f', audio.audio); 
    
    return Buffer.from(wav.toBuffer());
}
