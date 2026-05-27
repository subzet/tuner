const STRINGS = [
  { note: 'E2', freq: 82.41, label: '6 E' },
  { note: 'A2', freq: 110.00, label: '5 A' },
  { note: 'D3', freq: 146.83, label: '4 D' },
  { note: 'G3', freq: 196.00, label: '3 G' },
  { note: 'B3', freq: 246.94, label: '2 B' },
  { note: 'E4', freq: 329.63, label: '1 e' },
];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const A4 = 440;

let audioCtx = null;
let analyser = null;
let micStream = null;
let animationId = null;
let isListening = false;

let freqHistory = [];
const MAX_HISTORY = 8;
let silenceFrames = 0;
const SILENCE_TIMEOUT = 15;

const micBtn = document.getElementById('micBtn');
const micIcon = document.getElementById('micIcon');
const micText = document.getElementById('micText');
const needle = document.getElementById('needle');
const needleTrack = document.querySelector('.needle-track');
const noteDisplay = document.getElementById('noteDisplay');
const freqDisplay = document.getElementById('freqDisplay');
const centsDisplay = document.getElementById('centsDisplay');
const stringButtons = document.getElementById('stringButtons');

function buildStringButtons() {
  stringButtons.innerHTML = '';
  STRINGS.forEach((s, i) => {
    const btn = document.createElement('button');
    btn.className = 'string-btn';
    btn.dataset.index = i;
    btn.dataset.note = s.note;
    btn.dataset.freq = s.freq;
    btn.textContent = s.label;
    stringButtons.appendChild(btn);
  });
}
buildStringButtons();

function freqToNote(freq) {
  return Math.round(12 * Math.log2(freq / A4) + 69);
}

function noteName(midi) {
  return NOTE_NAMES[midi % 12] + Math.floor(midi / 12 - 1);
}

function findClosestString(freq) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < STRINGS.length; i++) {
    const dist = Math.abs(freq - STRINGS[i].freq);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

function fftPeak(fftData, sampleRate, fftSize) {
  const binWidth = sampleRate / fftSize;
  let bestBin = -1;
  let bestMag = -Infinity;

  const loBin = Math.floor(60 / binWidth);
  const hiBin = Math.floor(450 / binWidth);

  for (let i = loBin; i <= hiBin; i++) {
    if (fftData[i] > bestMag) {
      bestMag = fftData[i];
      bestBin = i;
    }
  }

  if (bestBin < 0) return -1;

  const left = fftData[bestBin - 1] || fftData[bestBin];
  const center = fftData[bestBin];
  const right = fftData[bestBin + 1] || fftData[bestBin];
  const delta = (left - right) / (2 * (left - 2 * center + right) + 1e-10);
  return (bestBin + delta) * binWidth;
}

function autocorrelate(buf, sampleRate) {
  const SIZE = buf.length;

  let sumSq = 0;
  for (let i = 0; i < SIZE; i++) sumSq += buf[i] * buf[i];
  const rms = Math.sqrt(sumSq / SIZE);
  if (rms < 0.0025) return -1;

  const minLag = Math.floor(sampleRate / 500);
  const maxLag = Math.floor(sampleRate / 70);

  let bestOffset = -1;
  let bestCorrelation = 0;

  for (let offset = minLag; offset < maxLag; offset++) {
    let correlation = 0;
    for (let i = 0; i < SIZE - offset; i++) {
      correlation += buf[i] * buf[i + offset];
    }
    correlation /= (SIZE - offset);

    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestOffset = offset;
    }
  }

  if (bestOffset < 0) return -1;

  const signalRatio = bestCorrelation / (sumSq / SIZE + 1e-10);
  if (signalRatio < 0.15) return -1;

  const freq = sampleRate / bestOffset;

  if (freq >= 80) {
    const halfLag = Math.round(bestOffset / 2);
    if (halfLag >= minLag && halfLag < maxLag) {
      let halfCorr = 0;
      for (let i = 0; i < SIZE - halfLag; i++) {
        halfCorr += buf[i] * buf[i + halfLag];
      }
      halfCorr /= (SIZE - halfLag);

      if (halfCorr > bestCorrelation * 0.55) {
        return freq * 2;
      }
    }
  }

  return freq;
}

function resolveOctave(acFreq, fftFreq) {
  if (fftFreq <= 0 || acFreq < 130) return acFreq;

  let best = acFreq;
  let bestDist = Math.abs(acFreq - fftFreq);

  const candidates = [acFreq * 0.5, acFreq, acFreq * 2];
  for (const c of candidates) {
    if (c < 70 || c > 400) continue;
    const d = Math.abs(c - fftFreq);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

async function startMic() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
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
    micText.textContent = 'No mic';
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
  resetUI();
}

function resetUI() {
  needle.style.left = '50%';
  needle.style.opacity = '1';
  needleTrack.classList.remove('tuned');
  noteDisplay.textContent = '—';
  noteDisplay.className = 'note-display';
  freqDisplay.textContent = '';
  centsDisplay.textContent = '';
  centsDisplay.className = 'cents-display';
  document.querySelectorAll('.string-btn').forEach(b => {
    b.classList.remove('active', 'tuned');
  });
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

  const timeData = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(timeData);

  const freqData = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(freqData);

  const linearMag = new Float32Array(freqData.length);
  let maxMag = -Infinity;
  for (let i = 0; i < freqData.length; i++) {
    linearMag[i] = Math.pow(10, freqData[i] / 20);
    if (linearMag[i] > maxMag) maxMag = linearMag[i];
  }

  const noiseFloor = maxMag * 0.08;

  const acFreq = autocorrelate(timeData, audioCtx.sampleRate);

  const fftFreq = maxMag > 0.0002 ? fftPeak(linearMag, audioCtx.sampleRate, analyser.fftSize) : -1;

  let rawFreq = acFreq;
  if (acFreq > 0) {
    rawFreq = resolveOctave(acFreq, fftFreq);
  }

  if (rawFreq > 0 && rawFreq >= 60 && rawFreq <= 400) {
    freqHistory.push(rawFreq);
    if (freqHistory.length > MAX_HISTORY) freqHistory.shift();
    silenceFrames = 0;

    const sorted = [...freqHistory].sort((a, b) => a - b);
    const trimmed = sorted.slice(1, -1);
    const smoothedFreq = trimmed.length > 0
      ? trimmed.reduce((a, b) => a + b, 0) / trimmed.length
      : rawFreq;

    const closestIdx = findClosestString(smoothedFreq);
    const targetFreq = STRINGS[closestIdx].freq;
    const targetCents = 1200 * Math.log2(smoothedFreq / targetFreq);

    const midi = freqToNote(smoothedFreq);
    const name = noteName(midi);

    noteDisplay.textContent = name;
    freqDisplay.textContent = smoothedFreq.toFixed(1) + ' Hz';

    const absCents = Math.abs(targetCents);

    if (absCents < 3) {
      centsDisplay.textContent = '✓ In tune';
      centsDisplay.className = 'cents-display in-tune';
      noteDisplay.className = 'note-display in-tune';
      needleTrack.classList.add('tuned');
      needle.style.opacity = '1';
    } else {
      const dir = targetCents > 0 ? '▲ Tune down' : '▼ Tune up';
      centsDisplay.textContent = dir + ' · ' + absCents.toFixed(0) + '¢';
      centsDisplay.className = 'cents-display';
      noteDisplay.className = 'note-display';
      needleTrack.classList.remove('tuned');
      needle.style.opacity = '1';
    }

    const clamped = Math.max(-50, Math.min(50, targetCents));
    const pct = 50 + clamped;
    needle.style.left = pct + '%';

    highlightString(closestIdx, absCents < 3);
  } else {
    silenceFrames++;
    if (silenceFrames > SILENCE_TIMEOUT) {
      freqHistory = [];
      needle.style.left = '50%';
      needle.style.opacity = '0.3';
      needleTrack.classList.remove('tuned');
      noteDisplay.textContent = '—';
      noteDisplay.className = 'note-display';
      freqDisplay.textContent = '';
      centsDisplay.textContent = '';
      centsDisplay.className = 'cents-display';
      document.querySelectorAll('.string-btn').forEach(b => {
        b.classList.remove('active', 'tuned');
      });
    }
  }

  animationId = requestAnimationFrame(tick);
}

function highlightString(index, tuned) {
  document.querySelectorAll('.string-btn').forEach(btn => {
    const i = parseInt(btn.dataset.index);
    btn.classList.toggle('active', i === index);
    btn.classList.toggle('tuned', i === index && tuned);
  });
}

micBtn.addEventListener('click', () => {
  if (isListening) {
    stopMic();
  } else {
    freqHistory = [];
    silenceFrames = 0;
    startMic();
  }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js');
  });
}