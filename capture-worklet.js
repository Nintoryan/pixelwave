class PixelWaveCapture extends AudioWorkletProcessor{process(inputs){const a=inputs[0]?.[0];if(a)this.port.postMessage(new Float32Array(a));return true}}
registerProcessor('pixelwave-capture',PixelWaveCapture);
