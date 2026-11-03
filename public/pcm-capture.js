// Dictado local: toma el audio del micrófono y se lo pasa a la página en trozos de unos 100 ms.
// Corre en el hilo de audio del navegador (AudioWorklet), así la grabación no se corta si la página está ocupada.

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    // «sampleRate» es la frecuencia del contexto de audio (global del AudioWorklet).
    this.size = Math.max(128, Math.round(sampleRate / 10));
    this.buffer = new Float32Array(this.size);
    this.filled = 0;
    this.stopped = false;
    this.port.onmessage = (event) => {
      if (event.data === "stop") this.stopped = true;
    };
  }

  process(inputs) {
    if (this.stopped) return false;
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    let offset = 0;
    while (offset < channel.length) {
      const take = Math.min(channel.length - offset, this.size - this.filled);
      this.buffer.set(channel.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === this.size) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(this.size);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
