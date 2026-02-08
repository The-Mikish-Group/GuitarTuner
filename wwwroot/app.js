// ============================================================
// Guitar Tuner PWA - Main Application
// Uses Web Audio API + YIN pitch detection algorithm
// ============================================================

// --- Standard Tuning Frequencies ---
const STRINGS = [
    { name: 'E',  octave: 2, freq: 82.41,  stringNum: 6 },
    { name: 'A',  octave: 2, freq: 110.00, stringNum: 5 },
    { name: 'D',  octave: 3, freq: 146.83, stringNum: 4 },
    { name: 'G',  octave: 3, freq: 196.00, stringNum: 3 },
    { name: 'B',  octave: 3, freq: 246.94, stringNum: 2 },
    { name: 'E',  octave: 4, freq: 329.63, stringNum: 1 }
];

// All 12 chromatic note names for auto-detect
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// --- State ---
let audioContext = null;
let analyserNode = null;
let micStream = null;
let isListening = false;
let animFrameId = null;
let lockedString = null;   // null = auto-detect, 0-5 = locked to specific string
let smoothedCents = 0;     // for visual smoothing

// --- DOM References ---
const detectedNote = document.getElementById('detected-note');
const detectedOctave = document.getElementById('detected-octave');
const frequencyDisplay = document.getElementById('frequency-display');
const gaugeNeedle = document.getElementById('gauge-needle');
const centsDisplay = document.getElementById('cents-display');
const statusMessage = document.getElementById('status-message');
const startBtn = document.getElementById('start-btn');
const btnIcon = document.getElementById('btn-icon');
const btnText = document.getElementById('btn-text');
const stringBtns = document.querySelectorAll('.string-btn');

// ============================================================
// TOGGLE TUNER ON/OFF
// ============================================================
async function toggleTuner() {
    if (isListening) {
        stopTuner();
    } else {
        await startTuner();
    }
}

async function startTuner() {
    try {
        // Request microphone access
        micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            }
        });

        // Create audio context (handle Safari prefix)
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        audioContext = new AudioCtx();

        // Create analyser with large FFT for low-frequency accuracy
        analyserNode = audioContext.createAnalyser();
        analyserNode.fftSize = 4096;
        analyserNode.smoothingTimeConstant = 0;

        // Connect mic -> analyser
        const source = audioContext.createMediaStreamSource(micStream);
        source.connect(analyserNode);

        isListening = true;
        startBtn.classList.add('listening');
        btnIcon.textContent = '⏹';
        btnText.textContent = 'Stop Tuning';
        statusMessage.textContent = 'Listening...';
        statusMessage.className = '';

        // Start the detection loop
        detectPitch();

    } catch (err) {
        console.error('Microphone access error:', err);
        statusMessage.textContent = 'Microphone access denied';
        statusMessage.className = 'flat';
    }
}

function stopTuner() {
    isListening = false;

    if (animFrameId) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
    }

    if (micStream) {
        micStream.getTracks().forEach(t => t.stop());
        micStream = null;
    }

    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }

    // Reset UI
    startBtn.classList.remove('listening');
    btnIcon.textContent = '🎤';
    btnText.textContent = 'Start Tuning';
    detectedNote.textContent = '--';
    detectedOctave.textContent = '';
    frequencyDisplay.textContent = '-- Hz';
    centsDisplay.textContent = '0 cents';
    statusMessage.textContent = 'Tap Start to begin';
    statusMessage.className = '';
    gaugeNeedle.style.left = '50%';
    smoothedCents = 0;

    // Clear string highlights
    stringBtns.forEach(btn => {
        btn.classList.remove('active', 'in-tune');
    });
}

// ============================================================
// STRING SELECTOR - Lock/Unlock
// ============================================================
stringBtns.forEach((btn, index) => {
    btn.addEventListener('click', () => {
        if (lockedString === index) {
            // Tap again to unlock -> auto-detect
            lockedString = null;
            btn.classList.remove('locked');
        } else {
            // Lock to this string
            lockedString = index;
            stringBtns.forEach(b => b.classList.remove('locked'));
            btn.classList.add('locked');
        }
    });
});

// ============================================================
// PITCH DETECTION LOOP
// ============================================================
function detectPitch() {
    if (!isListening) return;

    const bufferLength = analyserNode.fftSize;
    const buffer = new Float32Array(bufferLength);
    analyserNode.getFloatTimeDomainData(buffer);

    // Check if there's enough signal (RMS volume)
    const rms = Math.sqrt(buffer.reduce((sum, v) => sum + v * v, 0) / bufferLength);

    if (rms < 0.008) {
        // Too quiet — no string being played
        animFrameId = requestAnimationFrame(detectPitch);
        return;
    }

    // Run YIN pitch detection
    const frequency = yinDetect(buffer, audioContext.sampleRate);

    if (frequency !== -1 && frequency > 60 && frequency < 400) {
        updateUI(frequency);
    }

    animFrameId = requestAnimationFrame(detectPitch);
}

// ============================================================
// YIN PITCH DETECTION ALGORITHM
// ============================================================
function yinDetect(buffer, sampleRate) {
    const halfLen = Math.floor(buffer.length / 2);
    const yinBuffer = new Float32Array(halfLen);

    // Step 1 & 2: Squared difference function
    let runningSum = 0;
    yinBuffer[0] = 1;

    for (let tau = 1; tau < halfLen; tau++) {
        let diff = 0;
        for (let i = 0; i < halfLen; i++) {
            const delta = buffer[i] - buffer[i + tau];
            diff += delta * delta;
        }
        yinBuffer[tau] = diff;

        // Step 3: Cumulative mean normalized difference
        runningSum += yinBuffer[tau];
        yinBuffer[tau] *= tau / runningSum;
    }

    // Step 4: Absolute threshold - find first dip below threshold
    const threshold = 0.15;
    let tauEstimate = -1;

    for (let tau = 2; tau < halfLen; tau++) {
        if (yinBuffer[tau] < threshold) {
            // Find the local minimum
            while (tau + 1 < halfLen && yinBuffer[tau + 1] < yinBuffer[tau]) {
                tau++;
            }
            tauEstimate = tau;
            break;
        }
    }

    if (tauEstimate === -1) return -1;

    // Step 5: Parabolic interpolation for sub-sample accuracy
    let betterTau;
    const x0 = tauEstimate < 1 ? tauEstimate : tauEstimate - 1;
    const x2 = tauEstimate + 1 < halfLen ? tauEstimate + 1 : tauEstimate;

    if (x0 === tauEstimate) {
        betterTau = yinBuffer[tauEstimate] <= yinBuffer[x2] ? tauEstimate : x2;
    } else if (x2 === tauEstimate) {
        betterTau = yinBuffer[tauEstimate] <= yinBuffer[x0] ? tauEstimate : x0;
    } else {
        const s0 = yinBuffer[x0];
        const s1 = yinBuffer[tauEstimate];
        const s2 = yinBuffer[x2];
        betterTau = tauEstimate + (s2 - s0) / (2 * (2 * s1 - s2 - s0));
    }

    return sampleRate / betterTau;
}

// ============================================================
// UPDATE UI
// ============================================================
function updateUI(frequency) {
    // Find the closest note (general chromatic)
    const noteInfo = frequencyToNote(frequency);

    // Determine which guitar string this matches
    let targetString = null;

    if (lockedString !== null) {
        // Locked mode: always compare to locked string
        targetString = STRINGS[lockedString];
    } else {
        // Auto-detect: find closest guitar string
        targetString = findClosestString(frequency);
    }

    // Calculate cents offset from the target string
    const cents = 1200 * Math.log2(frequency / targetString.freq);

    // Smooth the cents for display (prevents jittery needle)
    smoothedCents = smoothedCents * 0.6 + cents * 0.4;

    // Clamp to ±50 for gauge display
    const displayCents = Math.max(-50, Math.min(50, smoothedCents));
    const needlePercent = 50 + (displayCents / 50) * 50;

    // Update DOM
    detectedNote.textContent = targetString.name;
    detectedOctave.textContent = targetString.octave;
    frequencyDisplay.textContent = frequency.toFixed(1) + ' Hz';
    gaugeNeedle.style.left = needlePercent + '%';
    centsDisplay.textContent = (smoothedCents >= 0 ? '+' : '') + smoothedCents.toFixed(1) + ' cents';

    // Highlight the matching string button
    stringBtns.forEach((btn, i) => {
        const isTarget = (STRINGS[i] === targetString);
        btn.classList.toggle('active', isTarget && Math.abs(smoothedCents) > 5);
        btn.classList.toggle('in-tune', isTarget && Math.abs(smoothedCents) <= 5);
    });

    // Update status & note color
    const absCents = Math.abs(smoothedCents);

    if (absCents <= 5) {
        statusMessage.textContent = '✓ In Tune!';
        statusMessage.className = 'in-tune';
        detectedNote.style.color = 'var(--green)';
    } else if (absCents <= 15) {
        statusMessage.textContent = smoothedCents < 0 ? '↑ Almost — tune up slightly' : '↓ Almost — tune down slightly';
        statusMessage.className = 'close';
        detectedNote.style.color = 'var(--yellow)';
    } else if (smoothedCents < 0) {
        statusMessage.textContent = '↑ Tune Up';
        statusMessage.className = 'flat';
        detectedNote.style.color = 'var(--accent)';
    } else {
        statusMessage.textContent = '↓ Tune Down';
        statusMessage.className = 'sharp';
        detectedNote.style.color = 'var(--accent)';
    }
}

// ============================================================
// HELPER: Frequency -> Note (chromatic)
// ============================================================
function frequencyToNote(freq) {
    const noteNum = 12 * (Math.log2(freq / 440));
    const noteIndex = Math.round(noteNum) + 69; // MIDI note number
    const name = NOTE_NAMES[((noteIndex % 12) + 12) % 12];
    const octave = Math.floor(noteIndex / 12) - 1;
    const exactFreq = 440 * Math.pow(2, (noteIndex - 69) / 12);
    const cents = 1200 * Math.log2(freq / exactFreq);
    return { name, octave, cents, midiNote: noteIndex };
}

// ============================================================
// HELPER: Find closest guitar string to a frequency
// ============================================================
function findClosestString(freq) {
    let closest = STRINGS[0];
    let minCentsDiff = Infinity;

    for (const s of STRINGS) {
        const centsDiff = Math.abs(1200 * Math.log2(freq / s.freq));
        if (centsDiff < minCentsDiff) {
            minCentsDiff = centsDiff;
            closest = s;
        }
    }
    return closest;
}

// ============================================================
// SERVICE WORKER REGISTRATION
// ============================================================
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
            .then(reg => console.log('SW registered:', reg.scope))
            .catch(err => console.log('SW registration failed:', err));
    });
}
