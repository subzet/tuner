const STRINGS = [
  { note: 'E2', freq: 82.41 },
  { note: 'A2', freq: 110.00 },
  { note: 'D3', freq: 146.83 },
  { note: 'G3', freq: 196.00 },
  { note: 'B3', freq: 246.94 },
  { note: 'E4', freq: 329.63 },
];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const A4 = 440;

let audioCtx = null;
let analyser = null;
let micStream = null;
let animationId = null;
let isListening = false;

let selectedString = 0;
let history = [];

const micBtn = document.getElementById('micBtn');
const micIcon = document.getElementById('micIcon');
const micText = document.getElementById('micText');
const needle = document.getElementById('needle');
const noteDisplay = document.getElementById('noteDisplay');
const freqDisplay = document.getElementById('freqDisplay');
const centsDisplay = document.getElementById('centsDisplay');

function freqToNote(freq) {
  const n = 12 * Math.log2(freq / A4) + 69;
  return Math.round(n);
}

function noteName(midi) {
  return NOTE_NAMES[midi % 12] + Math.floor(midi / 12 - 1);
}

function centsOff(freq, midi) {
  const expected = A4 * Math.pow(2, (midi - 69) / 12);
  return 1200 * Math.log2(freq / expected);
}

function autocorrelate(buf, sampleRate) {
  const SIZE = buf.length;
  const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / SIZE);
  if (rms < 0.01) return -1;

  const threshold = 0.2 * rms;
  let zeroCrossings = 0;
  for (let i = 1; i < SIZE; i++) {
    if (buf[i - 1] < 0 && buf[i] >= 0) zeroCrossings++;
  }
  if (zeroCrossings < 3) return -1;

  const maxOffset = Math.min(SIZE, Math.floor(sampleRate / 60));
  let bestOffset = -1;
  let bestCorrelation = 0;
  let found = false;

  for (let offset = Math.floor(sampleRate / 1200); offset < maxOffset; offset++) {
    let correlation = 0;
    for (let i = 0; i < SIZE - offset; i++) {
      correlation += buf[i] * buf[i + offset];
    }
    correlation /= (SIZE - offset);
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestOffset = offset;
      found = true;
    }
  }

  if (!found) return -1;

  const peakThreshold = 0.9 * bestCorrelation;
  let refinedOffset = bestOffset;
  let refined = false;
  for (let offset = Math.max(1, bestOffset - 10); offset < Math.min(maxOffset, bestOffset + 10); offset++) {
    if (offset >= maxOffset) continue;
    let correlation = 0;
    for (let i = 0; i < SIZE - offset; i++) {
      correlation += buf[i] * buf[i + offset];
    }
    correlation /= (SIZE - offset);
    if (correlation > peakThreshold) {
      refinedOffset = offset;
      refined = true;
    }
  }
  if (refined) bestOffset = refinedOffset;

  return sampleRate / bestOffset;
}

function parabolicInterpolation(buf, peakIndex) {
  const left = buf[peakIndex - 1] || 0;
  const center = buf[peakIndex];
  const right = buf[peakIndex + 1] || 0;
  const denom = left - 2 * center + right;
  if (denom === 0) return 0;
  return (left - right) / (2 * denom);
}

async function startMic() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0;
    const source = audioCtx.createMediaStreamSource(micStream);
    source.connect(analyser);
    isListening = true;
    updateMicUI();
    tick();
  } catch (err) {
    console.error(err);
    micIcon.textContent = '⚠️';
    micText.textContent = 'No mic access';
    micBtn.disabled = true;
  }
}

function stopMic() {
  isListening = false;
  if (animationId) cancelAnimationFrame(animationId);
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }
  if (audioCtx && audioCtx.state !== 'closed') {
    audioCtx.close();
    audioCtx = null;
  }
  analyser = null;
  updateMicUI();
  needle.style.left = '50%';
  noteDisplay.textContent = '—';
  freqDisplay.textContent = '';
  centsDisplay.textContent = '';
}

function updateMicUI() {
  if (isListening) {
    micBtn.classList.add('listening');
    micIcon.textContent = '⏹';
    micText.textContent = 'Stop';
  } else {
    micBtn.classList.remove('listening');
    micIcon.textContent = '🎤';
    micText.textContent = 'Start';
  }
}

function tick() {
  if (!isListening) return;

  const buffer = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buffer);

  const freq = autocorrelate(buffer, audioCtx.sampleRate);

  if (freq > 0) {
    history.push(freq);
    if (history.length > 3) history.shift();
    const smoothedFreq = history.reduce((a, b) => a + b, 0) / history.length;

    const midi = freqToNote(smoothedFreq);
    const name = noteName(midi);
    const cents = centsOff(smoothedFreq, midi);

    noteDisplay.textContent = name;
    freqDisplay.textContent = smoothedFreq.toFixed(1) + ' Hz';
    const absCents = Math.abs(cents);

    if (absCents < 5) {
      centsDisplay.textContent = 'In tune ✓';
      centsDisplay.style.color = 'var(--green)';
      noteDisplay.style.color = 'var(--green)';
    } else if (absCents < 15) {
      centsDisplay.textContent = (cents > 0 ? '+' : '') + cents.toFixed(0) + ' cents';
      centsDisplay.style.color = 'var(--orange)';
      noteDisplay.style.color = 'var(--orange)';
    } else {
      centsDisplay.textContent = (cents > 0 ? '+' : '') + cents.toFixed(0) + ' cents';
      centsDisplay.style.color = 'var(--orange)';
      noteDisplay.style.color = 'var(--orange)';
    }

    const clamped = Math.max(-50, Math.min(50, cents));
    const pct = 50 + clamped;
    needle.style.left = pct + '%';

    updateStringHighlight(name);
  } else {
    noteDisplay.textContent = '…';
    freqDisplay.textContent = '';
    centsDisplay.textContent = '';
    noteDisplay.style.color = 'var(--text)';
  }

  animationId = requestAnimationFrame(tick);
}

function updateStringHighlight(detectedNote) {
  const target = STRINGS[selectedString];
  const match = detectedNote === target.note || detectedNote === noteName(freqToNote(target.freq));

  document.querySelectorAll('.string-btn').forEach(btn => {
    const idx = parseInt(btn.dataset.string);
    if (idx === selectedString) {
      btn.classList.add('active');
      if (match && noteDisplay.style.color === 'var(--green)') {
        btn.classList.add('tuned');
      } else {
        btn.classList.remove('tuned');
      }
    } else {
      btn.classList.remove('active');
    }
  });
}

micBtn.addEventListener('click', () => {
  if (isListening) {
    stopMic();
  } else {
    history = [];
    startMic();
  }
});

function selectString(index) {
  selectedString = index;
  history = [];
  document.querySelectorAll('.string-btn').forEach(btn => {
    const idx = parseInt(btn.dataset.string);
    btn.classList.toggle('active', idx === index);
    btn.classList.remove('tuned');
  });
}

document.getElementById('stringButtons').addEventListener('click', (e) => {
  const btn = e.target.closest('.string-btn');
  if (!btn) return;
  selectString(parseInt(btn.dataset.string));
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js');
  });
}