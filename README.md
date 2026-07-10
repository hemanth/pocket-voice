# pocket-voice

Clone any voice and synthesize speech directly in your browser with ONNX Runtime Web. Zero servers, pure client-side execution.

## Run

Serve locally over localhost or HTTPS (required for AudioWorklet and microphone access):

```bash
npx serve .
# or
python3 -m http.server 8080
```

Open `http://localhost:8080` in your browser.

## How it works

The entire pipeline runs in-browser using WebAssembly and Web Workers:

1. **Voice conditioning**: A short reference audio sample (recorded via mic or uploaded) is passed through Kyutai's Mimi encoder to extract voice embedding latents.
2. **Flow matching**: Text is tokenized via SentencePiece and conditioned with the voice embeddings. The Flow LM predicts audio latent frames.
3. **Streaming playback**: Mimi decodes the latent frames into Float32 PCM audio, streamed directly into an `AudioWorklet` ring buffer for low-latency playback.

Models load on first use from Hugging Face CDN and are cached locally by the browser.

## Features

- **Zero server inference** — Everything runs in-browser via ONNX Runtime Web. No audio or text ever leaves your machine.
- **Voice cloning** — Record 5-10 seconds of audio or upload a WAV/MP3 clip to extract voice latents.
- **Streaming audio** — AudioWorklet ring buffer plays chunks as they generate, keeping TTFB low.
- **Saved voices** — Cloned voices persist in IndexedDB for reuse across sessions.
- **Predefined voices** — 20+ built-in voices available out of the box.
- **Multilingual** — Supports English, German, Italian, Portuguese, and Spanish bundles.
- **iOS Safari compatible** — Adapts memory usage and execution paths to run smoothly within Mobile Safari limits.

## Deployment

Fully static with zero build step. Deploy directly to GitHub Pages, Netlify, Vercel, or Hugging Face Spaces (static SDK).

## Credits

Massive credit to [KevinAHM](https://huggingface.co/KevinAHM) for [pocket-tts-onnx](https://huggingface.co/KevinAHM/pocket-tts-onnx) — the ONNX export, INT8 quantization, Flow LM split, and web inference pipeline that made in-browser execution possible.

Original Pocket TTS architecture and models by [Kyutai](https://kyutai.org) ([pocket-tts](https://github.com/kyutai-labs/pocket-tts)).

## License

MIT © [Hemanth.HM](https://h3manth.com)
