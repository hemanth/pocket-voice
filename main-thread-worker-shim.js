/**
 * MainThreadWorkerShim — Drop-in Worker replacement for iOS/Safari
 *
 * iOS Safari limits Web Worker memory to ~256MB, which is insufficient for
 * compiling onnxruntime-web's 10MB WASM binary. The main thread gets ~1GB+.
 *
 * This shim mimics the Worker API (postMessage/onmessage) but loads and runs
 * the inference-worker.js script on the main thread instead of in a Worker.
 */
(function () {
  "use strict";

  class MainThreadWorkerShim {
    constructor(scriptUrl) {
      this.onmessage = null;
      this.onerror = null;
      this._ready = false;
      this._pendingOutbound = []; // queued messages from worker code before onmessage is set
      this._workerMessageHandler = null; // captured self.onmessage set by worker code

      console.log(
        "%c[MainThreadWorkerShim] iOS mode: running inference on main thread (bypassing Worker memory limits)",
        "color: #f0a; font-weight: bold"
      );

      // Save original globals
      this._origPostMessage = window.postMessage.bind(window);
      this._origOnMessage = window.onmessage;

      // Install polyfills BEFORE loading the worker script
      this._installPolyfills();

      // Load the worker script (strip cache-buster query string)
      const cleanUrl = scriptUrl.split("?")[0];
      this._loadScript(cleanUrl);
    }

    _installPolyfills() {
      const shim = this;

      // Override postMessage so worker code's calls route back to app.js
      // Worker code calls: postMessage({type:'status', ...}) or self.postMessage(...)
      // CRITICAL: Deliver synchronously (not via setTimeout) so audio chunks reach
      // the AudioWorklet buffer immediately during the synchronous inference loop.
      // If we used setTimeout, callbacks would be blocked until inference finishes.
      window.postMessage = function (msg, transferOrOrigin) {
        // Ignore standard cross-origin postMessage calls (string origin as 2nd arg)
        if (typeof transferOrOrigin === "string") {
          return shim._origPostMessage(msg, transferOrOrigin);
        }
        // When worker code passes transferables like [audioFloat32.buffer],
        // we ignore them — on main thread there's no transfer, just shared memory.
        // Deliver synchronously to app.js handler
        if (shim.onmessage) {
          try {
            shim.onmessage({ data: msg });
          } catch (e) {
            console.error("[MainThreadWorkerShim] Handler error:", e);
          }
        } else {
          shim._pendingOutbound.push(msg);
        }
      };

      // Polyfill importScripts (synchronous script loading, just like in Workers)
      if (typeof window.importScripts === "undefined") {
        window.importScripts = function (...urls) {
          for (const url of urls) {
            console.log("[MainThreadWorkerShim] importScripts:", url);
            const xhr = new XMLHttpRequest();
            xhr.open("GET", url, false); // synchronous
            xhr.send();
            if (xhr.status >= 200 && xhr.status < 300) {
              // Indirect eval executes in global scope
              (0, eval)(xhr.responseText);
            } else {
              throw new Error(
                `importScripts failed for ${url}: HTTP ${xhr.status}`
              );
            }
          }
        };
      }
    }

    _loadScript(url) {
      const shim = this;
      const script = document.createElement("script");
      script.src = url;
      script.onload = () => {
        console.log("[MainThreadWorkerShim] Worker script loaded on main thread");
        // The worker script sets self.onmessage — capture it
        shim._workerMessageHandler = window.onmessage;
        shim._ready = true;
      };
      script.onerror = (e) => {
        console.error("[MainThreadWorkerShim] Failed to load worker script:", e);
        if (shim.onerror) shim.onerror(e);
      };
      document.head.appendChild(script);
    }

    /**
     * Called by app.js to send messages TO the worker code.
     * Routes to the handler that inference-worker.js installed via self.onmessage.
     */
    postMessage(msg, transfers) {
      const shim = this;
      // Use setTimeout to mimic async Worker delivery
      setTimeout(() => {
        // The worker script assigns self.onmessage = async (e) => { ... }
        // On main thread, self === window, so window.onmessage has the handler
        const handler = shim._workerMessageHandler || window.onmessage;
        if (handler) {
          try {
            handler({ data: msg });
          } catch (e) {
            console.error("[MainThreadWorkerShim] Handler error:", e);
            if (shim.onerror) shim.onerror(e);
          }
        } else {
          console.warn(
            "[MainThreadWorkerShim] No message handler registered yet, retrying in 200ms"
          );
          setTimeout(() => shim.postMessage(msg, transfers), 200);
        }
      }, 0);
    }

    /**
     * Flush any messages that were posted by the worker code before
     * app.js had a chance to set this.onmessage.
     */
    _flushPendingOutbound() {
      if (this._pendingOutbound.length > 0 && this.onmessage) {
        const handler = this.onmessage;
        const pending = this._pendingOutbound.splice(0);
        for (const msg of pending) {
          setTimeout(() => handler({ data: msg }), 0);
        }
      }
    }

    terminate() {
      // Restore originals
      window.postMessage = this._origPostMessage;
      if (this._origOnMessage !== undefined) {
        window.onmessage = this._origOnMessage;
      }
    }
  }

  // Expose globally
  window.MainThreadWorkerShim = MainThreadWorkerShim;
})();
