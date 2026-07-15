/**
 * Pocket Voice v2 — App Controller
 *
 * Features:
 * - MediaRecorder for mic-based voice cloning
 * - File upload for voice cloning
 * - IndexedDB for saving/loading cloned voices
 * - Voice gallery with persona descriptions
 * - Waveform visualization
 * - Web Worker inference delegation
 */

import { PCMPlayerWorklet as PCMPlayer } from "./PCMPlayerWorklet.js";

const SAMPLE_RATE = 24000;
const DB_NAME = "pocket-voice-db";
const DB_VERSION = 1;
const STORE_NAME = "voices";

// Built-in voice personas — rendered immediately, no need to wait for worker
const VOICE_PERSONAS = {
  alba:    { label: "Alba",    desc: "Attenborough-esque · warm British narrator" },
  charles: { label: "Charles", desc: "Morgan Freeman vibes · deep & commanding" },
  anna:    { label: "Anna",    desc: "Scarlett Johansson calm · clear American" },
  eve:     { label: "Eve",     desc: "Friendly AI assistant · crisp & precise" },
  liam:    { label: "Liam",    desc: "Neeson-style gravitas · easygoing storyteller" },
  olivia:  { label: "Olivia",  desc: "Cate Blanchett poise · expressive performer" },
  noah:    { label: "Noah",    desc: "Thoughtful professor · measured cadence" },
  maya:    { label: "Maya",    desc: "Energetic & bright · upbeat delivery" },
  jean:    { label: "Jean",    desc: "Deep French baritone · continental flair" },
  sam:     { label: "Sam",     desc: "Casual podcast host · relaxed & natural" },
};

class PocketVoice {
  constructor() {
    this.worker = null;
    this.player = null;
    this.audioContext = null;
    this.isGenerating = false;
    this.isWorkerReady = false;

    // Voice cloning
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.recordingTimer = null;
    this.recordingSeconds = 0;
    this.customVoiceLoaded = false;
    this.lastClonedPCM = null; // For saving
    this.isLoadingSavedVoice = false; // Suppress save-modal when re-encoding a saved voice
    this.activeSavedVoiceId = null; // Track which saved voice is selected

    // Audio collection
    this.generationStartTime = 0;
    this.currentChunks = [];
    this.lastAudioUrl = null;
    this.deferStreamEnd = false;

    // Metrics
    this.rtfMovingAvg = 0;

    // Built-in voices list
    this.builtinVoices = [];
    this.activeVoice = null;

    this.el = {
      btnRecord: document.getElementById("btn-record"),
      recordLabel: document.getElementById("record-label"),
      recTimer: document.getElementById("rec-timer"),
      btnUpload: document.getElementById("btn-upload"),
      fileUpload: document.getElementById("file-upload"),
      cloneStatus: document.getElementById("clone-status"),
      savedVoicesList: document.getElementById("saved-voices-list"),
      savedEmpty: document.getElementById("saved-empty"),
      voiceGallery: document.getElementById("voice-gallery"),
      langSelect: document.getElementById("language-select"),
      voiceSelect: document.getElementById("voice-select"),
      textInput: document.getElementById("text-input"),
      charCount: document.getElementById("char-count"),
      btnGenerate: document.getElementById("btn-generate"),
      btnStop: document.getElementById("btn-stop"),
      statusDot: document.getElementById("status-dot"),
      statusText: document.getElementById("status-text"),
      waveform: document.getElementById("waveform"),
      statTTFB: document.getElementById("stat-ttfb"),
      statRTFx: document.getElementById("stat-rtfx"),
      btnDownload: document.getElementById("btn-download"),
      saveModal: document.getElementById("save-modal"),
      saveInput: document.getElementById("save-voice-name"),
      saveCancel: document.getElementById("save-cancel"),
      saveConfirm: document.getElementById("save-confirm"),
    };

    this.setupOnScreenConsole();
    this.bindEvents();
    this.buildGallery(); // Render gallery immediately — no waiting for worker
    this.init();
    this.setupWaveform();
    this.loadSavedVoices();
  }

  setupOnScreenConsole() {
    if (!window.location.search.includes("debug=1")) return;

    const container = document.createElement("div");
    container.id = "debug-console";
    container.style.cssText = `
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      height: 180px;
      overflow-y: auto;
      background: #0f141c;
      color: #38bdf8;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11px;
      line-height: 1.4;
      z-index: 99999;
      border-top: 1px solid #1e293b;
      padding: 10px;
      box-sizing: border-box;
      opacity: 0.95;
      user-select: text;
      -webkit-user-select: text;
    `;
    
    const header = document.createElement("div");
    header.style.cssText = "display: flex; justify-content: space-between; border-bottom: 1px solid #1e293b; padding-bottom: 4px; margin-bottom: 6px; font-weight: bold; color: #94a3b8;";
    header.innerHTML = `<span>📱 Debug Logs (?debug=1)</span><button id="debug-clear" style="background: none; border: none; color: #f43f5e; cursor: pointer; font-size: 10px; font-family: inherit; padding: 0 4px;">Clear</button>`;
    container.appendChild(header);

    const logList = document.createElement("div");
    logList.id = "debug-log-list";
    container.appendChild(logList);
    document.body.appendChild(container);

    document.getElementById("debug-clear").addEventListener("click", () => {
      logList.innerHTML = "";
    });

    const addLog = (msg, type = "info") => {
      const item = document.createElement("div");
      item.style.padding = "2px 0";
      if (type === "error") {
        item.style.color = "#f43f5e";
        item.style.borderLeft = "2px solid #f43f5e";
        item.style.paddingLeft = "4px";
      } else if (type === "warn") {
        item.style.color = "#f59e0b";
      }
      
      const time = new Date().toLocaleTimeString([], { hour12: false, fractionSecondDigits: 3 });
      item.textContent = `[${time}] ${msg}`;
      logList.appendChild(item);
      container.scrollTop = container.scrollHeight;
    };

    // Intercept console functions
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;

    console.log = (...args) => {
      origLog.apply(console, args);
      addLog(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(" "), "info");
    };
    console.warn = (...args) => {
      origWarn.apply(console, args);
      addLog(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(" "), "warn");
    };
    console.error = (...args) => {
      origError.apply(console, args);
      addLog(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(" "), "error");
    };

    // Global script errors
    window.addEventListener("error", (e) => {
      addLog(`Uncaught Error: ${e.message} at ${e.filename}:${e.lineno}:${e.colno}`, "error");
    });

    // Unhandled promise rejections
    window.addEventListener("unhandledrejection", (e) => {
      addLog(`Unhandled Rejection: ${e.reason}`, "error");
    });

    addLog("Debug logger initialized successfully.");
  }

  bindEvents() {
    this.el.btnRecord.addEventListener("click", () => this.toggleRecording());
    this.el.btnUpload.addEventListener("click", () => this.el.fileUpload.click());
    this.el.fileUpload.addEventListener("change", (e) => this.handleFileUpload(e));

    this.el.textInput.addEventListener("input", () => {
      this.el.charCount.textContent = this.el.textInput.value.length;
    });

    document.querySelectorAll(".sample-pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.el.textInput.value = btn.dataset.text;
        this.el.charCount.textContent = btn.dataset.text.length;
      });
    });

    this.el.btnGenerate.addEventListener("click", () => this.generate());
    this.el.btnStop.addEventListener("click", () => this.stop());

    this.el.langSelect.addEventListener("change", () => {
      if (this.isGenerating) return;
      this.worker.postMessage({ type: "set_language", data: { language: this.el.langSelect.value } });
      this.setLoading(true);
    });

    this.el.voiceSelect.addEventListener("change", () => {
      if (this.isGenerating) return;
      const voice = this.el.voiceSelect.value;
      if (voice === "custom" && !this.customVoiceLoaded) return;
      this.worker.postMessage({ type: "set_voice", data: { voiceName: voice } });
      this.activeVoice = voice;
      this.updateGalleryActive();
    });

    this.el.btnDownload.addEventListener("click", () => this.downloadAudio());

    // Save modal
    this.el.saveCancel.addEventListener("click", () => this.closeSaveModal());
    this.el.saveConfirm.addEventListener("click", () => this.confirmSaveVoice());
    this.el.saveInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.confirmSaveVoice();
      if (e.key === "Escape") this.closeSaveModal();
    });
  }

  async init() {
    this.updateStatus("Initializing…", "loading");
    this.el.btnGenerate.disabled = true;
    this.el.btnRecord.disabled = true;
    this.el.btnUpload.disabled = true;
    this.setCloneStatus("Loading model… please wait", "");

    this.worker = new Worker("./inference-worker.js?v=2.0.5");
    this.worker.onmessage = (e) => this.handleWorkerMessage(e.data);
    this.worker.onerror = (e) => {
      console.error("Worker crashed:", e);
      this.updateStatus("Worker failed to load. Try refreshing.", "error");
      this.setCloneStatus("Model failed to load", "error");
    };
    this.worker.postMessage({ type: "load" });
  }

  async ensureAudioContext() {
    if (this.audioContext) return;
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: SAMPLE_RATE,
      latencyHint: "interactive",
    });
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
    this.player = new PCMPlayer(this.audioContext);
    this.player.addEventListener("audioEnded", () => {
      if (this.deferStreamEnd) {
        this.deferStreamEnd = false;
        this.finalizePlayback();
      }
    });
  }

  handleWorkerMessage(msg) {
    console.log("[Worker Event] " + JSON.stringify(msg));
    switch (msg.type) {
      case "status":
        this.updateStatus(msg.status, msg.state);
        break;

      case "voices_loaded":
        this.builtinVoices = msg.voices || [];
        this.populateVoices(this.builtinVoices, msg.defaultVoice);
        this.updateGalleryActive();
        break;

      case "voice_encoded":
        this.customVoiceLoaded = true;
        if (this.isLoadingSavedVoice) {
          this.setCloneStatus("Voice loaded ✓", "ready");
        } else {
          this.setCloneStatus("Voice cloned ✓", "ready");
        }
        this.addCustomToDropdown();
        this.el.voiceSelect.value = "custom";
        this.activeVoice = "custom";
        this.updateGalleryActive();
        this.updateSavedVoicesActive();
        this.resetUI();
        // Only prompt to save for fresh clones, not re-loaded saved voices
        if (!this.isLoadingSavedVoice) {
          this.activeSavedVoiceId = null;
          this.updateSavedVoicesActive();
          this.openSaveModal();
        }
        this.isLoadingSavedVoice = false;
        break;

      case "voice_set":
        this.activeVoice = msg.voiceName;
        this.updateGalleryActive();
        this.resetUI();
        break;

      case "bundle_loaded":
        this.resetUI();
        break;

      case "loaded":
        this.isWorkerReady = true;
        this.el.btnRecord.disabled = false;
        this.el.btnUpload.disabled = false;
        this.setCloneStatus("", "");
        this.resetUI();
        break;

      case "audio_chunk":
        this.handleAudioChunk(msg.data, msg.metrics);
        break;

      case "stream_ended":
        this.handleStreamEnd();
        break;

      case "error":
        console.error("Worker:", msg.error);
        this.updateStatus(`Error: ${msg.error}`, "error");
        this.setCloneStatus(msg.error, "error");
        this.resetUI();
        break;
    }
  }

  // ── Voice Cloning ──

  async toggleRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
      this.stopRecording();
      return;
    }

    if (!this.isWorkerReady) {
      this.setCloneStatus("Model still loading… please wait", "");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: SAMPLE_RATE, channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });

      this.recordedChunks = [];
      this.recordingSeconds = 0;
      this.mediaRecorder = new MediaRecorder(stream, { mimeType: this.getSupportedMime() });

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.recordedChunks.push(e.data);
      };

      this.mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        clearInterval(this.recordingTimer);
        this.el.recTimer.hidden = true;
        this.el.recordLabel.textContent = "Record";
        this.el.btnRecord.classList.remove("is-recording");

        const blob = new Blob(this.recordedChunks, { type: this.mediaRecorder.mimeType });
        await this.processVoiceClip(blob);
      };

      this.mediaRecorder.start(100);
      this.el.btnRecord.classList.add("is-recording");
      this.el.recordLabel.textContent = "Stop";
      this.el.recTimer.hidden = false;
      this.setCloneStatus("Recording…", "");

      this.recordingTimer = setInterval(() => {
        this.recordingSeconds++;
        const min = Math.floor(this.recordingSeconds / 60);
        const sec = (this.recordingSeconds % 60).toString().padStart(2, "0");
        this.el.recTimer.textContent = `${min}:${sec}`;
        if (this.recordingSeconds >= 10) this.stopRecording();
      }, 1000);

    } catch (err) {
      this.setCloneStatus(`Mic denied: ${err.message}`, "error");
    }
  }

  stopRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
      this.mediaRecorder.stop();
    }
  }

  getSupportedMime() {
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent) || 
                     /iPad|iPhone|iPod/.test(navigator.userAgent);
    const mimes = isSafari
      ? ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]
      : ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
    for (const m of mimes) {
      if (MediaRecorder.isTypeSupported(m)) return m;
    }
    return "";
  }

  async handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (!this.isWorkerReady) {
      this.setCloneStatus("Model still loading… please wait", "");
      e.target.value = "";
      return;
    }
    this.setCloneStatus(`Processing ${file.name}…`, "");
    await this.processVoiceClip(file);
    e.target.value = "";
  }

  async processVoiceClip(blob) {
    try {
      await this.ensureAudioContext();
      this.setCloneStatus("Encoding voice…", "");
      const arrayBuffer = await blob.arrayBuffer();
      const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);

      let pcmData;
      if (audioBuffer.sampleRate !== SAMPLE_RATE) {
        const offlineCtx = new OfflineAudioContext(1, Math.ceil(audioBuffer.duration * SAMPLE_RATE), SAMPLE_RATE);
        const source = offlineCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(offlineCtx.destination);
        source.start();
        const resampled = await offlineCtx.startRendering();
        pcmData = resampled.getChannelData(0);
      } else {
        pcmData = audioBuffer.getChannelData(0);
      }

      const maxSamples = SAMPLE_RATE * 10;
      const clipped = pcmData.length > maxSamples ? pcmData.slice(0, maxSamples) : new Float32Array(pcmData);

      // Save for potential IndexedDB storage
      this.lastClonedPCM = new Float32Array(clipped);

      this.worker.postMessage({ type: "encode_voice", data: { audio: clipped } }, [clipped.buffer]);
      this.setCloneStatus("Preparing cloned voice…", "");
    } catch (err) {
      this.setCloneStatus(`Failed: ${err.message}`, "error");
    }
  }

  // ── IndexedDB Voice Storage ──

  openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async saveVoice(name) {
    if (!this.lastClonedPCM) return;
    const db = await this.openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.add({
      name,
      pcm: this.lastClonedPCM,
      duration: (this.lastClonedPCM.length / SAMPLE_RATE).toFixed(1),
      date: new Date().toISOString(),
    });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = reject;
    });
    db.close();
    this.loadSavedVoices();
  }

  async deleteSavedVoice(id) {
    const db = await this.openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = reject;
    });
    db.close();
    this.loadSavedVoices();
  }

  async loadSavedVoices() {
    try {
      const db = await this.openDB();
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();

      req.onsuccess = () => {
        const voices = req.result;
        db.close();
        this.renderSavedVoices(voices);
      };
    } catch {
      // IndexedDB not available
    }
  }

  renderSavedVoices(voices) {
    if (!voices.length) {
      this.el.savedEmpty.style.display = "block";
      this.el.savedVoicesList.innerHTML = "";
      this.el.savedVoicesList.appendChild(this.el.savedEmpty);
      return;
    }

    this.el.savedEmpty.style.display = "none";
    const list = document.createElement("div");
    list.className = "saved-list";

    for (const v of voices) {
      const item = document.createElement("div");
      item.className = "saved-item";
      item.dataset.id = v.id;

      item.innerHTML = `
        <div class="saved-item__dot"></div>
        <div class="saved-item__info">
          <div class="saved-item__name">${this.escapeHtml(v.name)}</div>
          <div class="saved-item__meta">${v.duration}s · ${new Date(v.date).toLocaleDateString()}</div>
        </div>
        <button class="saved-item__delete" title="Delete voice">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      `;

      // Click to load
      item.addEventListener("click", (e) => {
        if (e.target.closest(".saved-item__delete")) return;
        this.loadSavedVoice(v);
      });

      // Delete
      item.querySelector(".saved-item__delete").addEventListener("click", (e) => {
        e.stopPropagation();
        this.deleteSavedVoice(v.id);
      });

      list.appendChild(item);
    }

    this.el.savedVoicesList.innerHTML = "";
    this.el.savedVoicesList.appendChild(list);
  }

  async loadSavedVoice(voice) {
    this.setCloneStatus(`Loading "${voice.name}"…`, "");
    this.isLoadingSavedVoice = true; // Suppress save-modal
    this.activeSavedVoiceId = voice.id; // Highlight this item
    this.updateSavedVoicesActive();
    this.lastClonedPCM = new Float32Array(voice.pcm);
    const pcmCopy = new Float32Array(voice.pcm);
    this.worker.postMessage({ type: "encode_voice", data: { audio: pcmCopy } }, [pcmCopy.buffer]);
  }

  updateSavedVoicesActive() {
    this.el.savedVoicesList.querySelectorAll(".saved-item").forEach((item) => {
      item.classList.toggle("is-active", Number(item.dataset.id) === this.activeSavedVoiceId);
    });
  }

  // Save modal
  openSaveModal() {
    this.el.saveModal.classList.add("is-open");
    this.el.saveInput.value = "";
    setTimeout(() => this.el.saveInput.focus(), 100);
  }

  closeSaveModal() {
    this.el.saveModal.classList.remove("is-open");
  }

  async confirmSaveVoice() {
    const name = this.el.saveInput.value.trim() || "Untitled Voice";
    await this.saveVoice(name);
    this.closeSaveModal();
  }

  // ── Voice Gallery ──

  buildGallery() {
    this.el.voiceGallery.innerHTML = "";

    for (const [v, persona] of Object.entries(VOICE_PERSONAS)) {
      const card = document.createElement("div");
      card.className = "voice-card";
      card.dataset.voice = v;

      const initials = v.slice(0, 2).toUpperCase();
      card.innerHTML = `
        <div class="voice-card__avatar">${initials}</div>
        <div class="voice-card__name">${persona.label}</div>
        <div class="voice-card__desc">${persona.desc}</div>
      `;

      card.addEventListener("click", () => {
        if (this.isGenerating) return;
        this.el.voiceSelect.value = v;
        this.activeVoice = v;
        this.worker.postMessage({ type: "set_voice", data: { voiceName: v } });
        this.updateGalleryActive();
      });

      this.el.voiceGallery.appendChild(card);
    }

    this.updateGalleryActive();
  }

  updateGalleryActive() {
    this.el.voiceGallery.querySelectorAll(".voice-card").forEach((card) => {
      card.classList.toggle("is-active", card.dataset.voice === this.activeVoice);
    });
  }

  // ── Generation ──

  async generate() {
    if (!this.isWorkerReady || this.isGenerating) return;
    const text = this.el.textInput.value.trim();
    if (!text) return;

    await this.ensureAudioContext();
    if (this.audioContext.state === "suspended") await this.audioContext.resume();

    this.isGenerating = true;
    this.generationStartTime = performance.now();
    this.currentChunks = [];
    this.rtfMovingAvg = 0;
    this.deferStreamEnd = false;

    if (this.lastAudioUrl) { URL.revokeObjectURL(this.lastAudioUrl); this.lastAudioUrl = null; }

    this.player.reset();
    this.el.btnGenerate.classList.add("is-loading");
    this.el.btnGenerate.disabled = true;
    this.el.btnStop.style.display = "flex";
    this.el.btnDownload.disabled = true;
    this.el.statTTFB.textContent = "—";
    this.el.statRTFx.textContent = "—";

    const voice = this.el.voiceSelect.value || undefined;
    this.worker.postMessage({ type: "generate", data: { text, voice } });
  }

  stop() {
    this.isGenerating = false;
    this.worker.postMessage({ type: "stop" });
    this.player.reset();
    this.resetUI();
  }

  handleAudioChunk(data, metrics) {
    if (!this.isGenerating) return;
    const pcm = new Float32Array(data);
    this.currentChunks.push(pcm);
    this.player.playAudio(pcm);

    if (metrics?.isFirst) {
      this.el.statTTFB.textContent = Math.round(performance.now() - this.generationStartTime);
    }

    if (metrics?.genTimeSec > 0 && metrics?.chunkDuration > 0 && !metrics?.isSilence) {
      const rtf = metrics.chunkDuration / metrics.genTimeSec;
      this.rtfMovingAvg = this.rtfMovingAvg === 0 ? rtf : this.rtfMovingAvg * 0.7 + rtf * 0.3;
      this.el.statRTFx.textContent = this.rtfMovingAvg.toFixed(1) + "x";
    }
  }

  handleStreamEnd() {
    this.isGenerating = false;
    this.player.notifyStreamEnded();
    const status = this.player.getPlaybackStatus();
    if (status.worklet.bufferLevelSamples > 0) {
      this.deferStreamEnd = true;
    } else {
      this.finalizePlayback();
    }
  }

  finalizePlayback() {
    this.buildDownloadBlob();
    this.resetUI();
  }

  buildDownloadBlob() {
    if (this.currentChunks.length === 0) return;
    const totalSamples = this.currentChunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Float32Array(totalSamples);
    let offset = 0;
    for (const chunk of this.currentChunks) { merged.set(chunk, offset); offset += chunk.length; }

    const wavBuffer = this.float32ToWav(merged, SAMPLE_RATE);
    if (this.lastAudioUrl) URL.revokeObjectURL(this.lastAudioUrl);
    this.lastAudioUrl = URL.createObjectURL(new Blob([wavBuffer], { type: "audio/wav" }));
    this.el.btnDownload.disabled = false;
  }

  downloadAudio() {
    if (!this.lastAudioUrl) return;
    const a = document.createElement("a");
    a.href = this.lastAudioUrl;
    a.download = "pocket-voice-output.wav";
    a.click();
  }

  float32ToWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    w(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); w(36, "data");
    view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return buffer;
  }

  // ── UI ──

  populateVoices(voices, defaultVoice) {
    this.el.voiceSelect.innerHTML = "";
    if (this.customVoiceLoaded) {
      const opt = document.createElement("option");
      opt.value = "custom";
      opt.textContent = "★ Cloned Voice";
      this.el.voiceSelect.appendChild(opt);
    }
    for (const v of voices) {
      const opt = document.createElement("option");
      opt.value = v;
      const persona = VOICE_PERSONAS[v];
      opt.textContent = persona ? persona.label : v.charAt(0).toUpperCase() + v.slice(1);
      this.el.voiceSelect.appendChild(opt);
    }
    this.activeVoice = this.customVoiceLoaded ? "custom" : (defaultVoice || voices[0]);
    this.el.voiceSelect.value = this.activeVoice;
  }

  addCustomToDropdown() {
    if (![...this.el.voiceSelect.options].some(o => o.value === "custom")) {
      const opt = document.createElement("option");
      opt.value = "custom";
      opt.textContent = "★ Cloned Voice";
      this.el.voiceSelect.prepend(opt);
    }
  }

  setLoading(loading) {
    this.el.btnGenerate.disabled = loading;
    this.el.btnGenerate.classList.toggle("is-loading", loading);
  }

  resetUI() {
    this.el.btnGenerate.disabled = !this.isWorkerReady;
    this.el.btnGenerate.classList.remove("is-loading");
    this.el.btnStop.style.display = "none";
    this.el.btnRecord.disabled = !this.isWorkerReady;
    this.el.btnUpload.disabled = !this.isWorkerReady;
  }

  updateStatus(text, state) {
    this.el.statusText.textContent = text;
    this.el.statusDot.className = "status-indicator__dot";
    if (state === "idle") this.el.statusDot.classList.add("is-ready");
    else if (state === "running" || state === "loading") this.el.statusDot.classList.add("is-running");
    else if (state === "error") this.el.statusDot.classList.add("is-error");

    if (state === "loading") {
      this.el.btnGenerate.disabled = true;
      this.el.btnGenerate.querySelector(".btn-text").textContent = text;
      this.el.btnGenerate.classList.add("is-loading");
    } else if (state === "idle" && this.isWorkerReady) {
      this.el.btnGenerate.querySelector(".btn-text").textContent = "Generate Audio";
      this.el.btnGenerate.classList.remove("is-loading");
      this.el.btnGenerate.disabled = false;
    }
  }

  setCloneStatus(text, state) {
    this.el.cloneStatus.textContent = text;
    this.el.cloneStatus.className = "clone__status";
    if (state === "ready") this.el.cloneStatus.classList.add("is-ready");
    else if (state === "error") this.el.cloneStatus.classList.add("is-error");
  }

  escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Waveform ──

  setupWaveform() {
    const canvas = this.el.waveform;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const draw = () => {
      requestAnimationFrame(draw);
      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      ctx.clearRect(0, 0, w, h);

      if (!this.player?.analyser || !this.audioContext) return;

      const dataArray = this.player.getTimeDomainData();
      const len = dataArray.length;

      // Gradient stroke
      const gradient = ctx.createLinearGradient(0, 0, w, 0);
      gradient.addColorStop(0, "rgba(245, 197, 66, 0.2)");
      gradient.addColorStop(0.5, "rgba(245, 197, 66, 0.6)");
      gradient.addColorStop(1, "rgba(245, 197, 66, 0.2)");

      ctx.lineWidth = 1.5;
      ctx.strokeStyle = gradient;
      ctx.beginPath();

      const sliceWidth = w / len;
      let x = 0;

      for (let i = 0; i < len; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * h) / 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += sliceWidth;
      }

      ctx.lineTo(w, h / 2);
      ctx.stroke();
    };

    draw();
  }
}

// Boot
new PocketVoice();
