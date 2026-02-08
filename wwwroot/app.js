// ============================================================
// Dolly Guitar Tuner PWA - Main Application
// Uses Web Audio API + YIN pitch detection algorithm
// ============================================================

// --- Tunings Database (semitones from A4) ---
const TUNINGS = {
    standard:      { name: 'Standard',        strings: [{ note: 'E', octave: 2, semi: -29 }, { note: 'A', octave: 2, semi: -24 }, { note: 'D', octave: 3, semi: -19 }, { note: 'G', octave: 3, semi: -14 }, { note: 'B', octave: 3, semi: -10 }, { note: 'E', octave: 4, semi: -5 }] },
    dropD:         { name: 'Drop D',           strings: [{ note: 'D', octave: 2, semi: -31 }, { note: 'A', octave: 2, semi: -24 }, { note: 'D', octave: 3, semi: -19 }, { note: 'G', octave: 3, semi: -14 }, { note: 'B', octave: 3, semi: -10 }, { note: 'E', octave: 4, semi: -5 }] },
    openG:         { name: 'Open G',           strings: [{ note: 'D', octave: 2, semi: -31 }, { note: 'G', octave: 2, semi: -26 }, { note: 'D', octave: 3, semi: -19 }, { note: 'G', octave: 3, semi: -14 }, { note: 'B', octave: 3, semi: -10 }, { note: 'D', octave: 4, semi: -7 }] },
    dadgad:        { name: 'DADGAD',           strings: [{ note: 'D', octave: 2, semi: -31 }, { note: 'A', octave: 2, semi: -24 }, { note: 'D', octave: 3, semi: -19 }, { note: 'G', octave: 3, semi: -14 }, { note: 'A', octave: 3, semi: -12 }, { note: 'D', octave: 4, semi: -7 }] },
    halfStepDown:  { name: 'Half-Step Down',   strings: [{ note: 'D#', octave: 2, semi: -30 }, { note: 'G#', octave: 2, semi: -25 }, { note: 'C#', octave: 3, semi: -20 }, { note: 'F#', octave: 3, semi: -15 }, { note: 'A#', octave: 3, semi: -11 }, { note: 'D#', octave: 4, semi: -6 }] },
    openD:         { name: 'Open D',           strings: [{ note: 'D', octave: 2, semi: -31 }, { note: 'A', octave: 2, semi: -24 }, { note: 'D', octave: 3, semi: -19 }, { note: 'F#', octave: 3, semi: -15 }, { note: 'A', octave: 3, semi: -12 }, { note: 'D', octave: 4, semi: -7 }] }
};

// All 12 chromatic note names for auto-detect
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Confidence threshold
const MIN_CONFIDENCE = 0.85;

// --- State ---
let audioContext = null;
let analyserNode = null;
let micStream = null;
let isListening = false;
let animFrameId = null;
let lockedString = null;   // null = auto-detect, 0-5 = locked to specific string
let smoothedCents = 0;     // for visual smoothing
let wasInTune = false;     // for haptic feedback edge detection

// A4 calibration
let a4Reference = 440;

// Active tuning
let activeTuningKey = 'standard';

// Pre-allocated buffers (reuse Float32Array)
let timeDomainBuffer = null;
let yinBuffer = null;

// Cached active strings (dirty-flag)
let cachedStrings = null;
let cachedBounds = null;
let stringsDirty = true;

// Reference tone playback
let toneContext = null;
let toneOscillator = null;
let toneGain = null;
let toneTimeout = null;
let playingToneIndex = null;

// Pitch history ring buffer
const HISTORY_SIZE = 120;
let pitchHistory = new Float32Array(HISTORY_SIZE);
let historyIndex = 0;
let historyCount = 0;

// --- DOM References ---
const detectedNote = document.getElementById('detected-note');
const detectedOctave = document.getElementById('detected-octave');
const frequencyDisplay = document.getElementById('frequency-display');
const gaugeNeedle = document.getElementById('gauge-needle');
const gaugeContainer = document.getElementById('gauge-container');
const centsDisplay = document.getElementById('cents-display');
const statusMessage = document.getElementById('status-message');
const startBtn = document.getElementById('start-btn');
const btnIcon = document.getElementById('btn-icon');
const btnText = document.getElementById('btn-text');
const tuningSelect = document.getElementById('tuning-select');
const tuningLabel = document.getElementById('tuning-label');
const a4Display = document.getElementById('a4-display');
const a4DownBtn = document.getElementById('a4-down');
const a4UpBtn = document.getElementById('a4-up');
const themeToggle = document.getElementById('theme-toggle');
const themeIcon = document.getElementById('theme-icon');
const confidenceFill = document.getElementById('confidence-fill');
const confidenceLabel = document.getElementById('confidence-label');
const pitchCanvas = document.getElementById('pitch-history');
const pitchCtx = pitchCanvas.getContext('2d');

// ============================================================
// ACTIVE STRINGS (computed from tuning + A4)
// ============================================================
function getActiveStrings() {
    if (!stringsDirty && cachedStrings) return cachedStrings;
    const tuning = TUNINGS[activeTuningKey];
    cachedStrings = tuning.strings.map((s, i) => ({
        name: s.note,
        octave: s.octave,
        freq: a4Reference * Math.pow(2, s.semi / 12),
        stringNum: 6 - i
    }));
    // Also recompute frequency bounds
    const freqs = cachedStrings.map(s => s.freq);
    cachedBounds = {
        low: Math.min(...freqs) * 0.5,
        high: Math.max(...freqs) * 2.0
    };
    stringsDirty = false;
    return cachedStrings;
}

function getFrequencyBounds() {
    if (!cachedBounds || stringsDirty) getActiveStrings();
    return cachedBounds;
}

function invalidateStrings() {
    stringsDirty = true;
    cachedStrings = null;
    cachedBounds = null;
}

// ============================================================
// THEME
// ============================================================
function initTheme() {
    const saved = localStorage.getItem('guitar-tuner-theme');
    const theme = saved || 'dark';
    applyTheme(theme);
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('guitar-tuner-theme', theme);
    // Update icon
    themeIcon.textContent = theme === 'dark' ? '\u2606' : '\u263E'; // ☆ sun / ☾ moon
    // Update meta theme-color
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
        meta.setAttribute('content', theme === 'dark' ? '#e94560' : '#d6304a');
    }
}

// ============================================================
// A4 CALIBRATION
// ============================================================
function setA4(value) {
    a4Reference = Math.max(432, Math.min(446, value));
    a4Display.textContent = 'A4 = ' + a4Reference + ' Hz';
    invalidateStrings();
    rebuildStringSelector();
    localStorage.setItem('guitar-tuner-a4', a4Reference);
}

// ============================================================
// TUNING SELECTOR
// ============================================================
function initTuningSelector() {
    tuningSelect.innerHTML = '';
    for (const key in TUNINGS) {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = TUNINGS[key].name;
        tuningSelect.appendChild(opt);
    }
    tuningSelect.value = activeTuningKey;
}

function selectTuning(key) {
    if (!TUNINGS[key]) return;
    activeTuningKey = key;
    invalidateStrings();
    tuningLabel.textContent = TUNINGS[key].name + ' Tuning';
    lockedString = null;
    rebuildStringSelector();
    localStorage.setItem('guitar-tuner-tuning', key);
}

// ============================================================
// STRING SELECTOR (dynamic rebuild)
// ============================================================
function rebuildStringSelector() {
    const strings = getActiveStrings();
    const rows = document.querySelectorAll('#string-selector .string-row');
    rows.forEach(r => { r.innerHTML = ''; });

    strings.forEach((s, i) => {
        const btn = document.createElement('button');
        btn.className = 'string-btn';
        btn.setAttribute('data-string', i);
        btn.setAttribute('aria-label', 'String ' + s.stringNum + ', ' + s.name + s.octave + ', ' + s.freq.toFixed(1) + ' hertz');
        if (lockedString === i) btn.classList.add('locked');
        btn.setAttribute('aria-pressed', lockedString === i ? 'true' : 'false');

        btn.innerHTML =
            '<span class="string-number">' + s.stringNum + '</span>' +
            '<span class="string-note">' + s.name + s.octave + '</span>' +
            '<span class="string-hz">' + s.freq.toFixed(2) + '</span>' +
            '<button class="tone-trigger" aria-label="Play reference tone for ' + s.name + s.octave + '" title="Play tone">\u266B</button>';

        // String lock click
        btn.addEventListener('click', function(e) {
            // Ignore if tone trigger was clicked
            if (e.target.classList.contains('tone-trigger')) return;
            if (lockedString === i) {
                lockedString = null;
                btn.classList.remove('locked');
                btn.setAttribute('aria-pressed', 'false');
            } else {
                lockedString = i;
                document.querySelectorAll('.string-btn').forEach(b => {
                    b.classList.remove('locked');
                    b.setAttribute('aria-pressed', 'false');
                });
                btn.classList.add('locked');
                btn.setAttribute('aria-pressed', 'true');
            }
        });

        // Tone trigger click
        const toneTrigger = btn.querySelector('.tone-trigger');
        toneTrigger.addEventListener('click', function(e) {
            e.stopPropagation();
            if (playingToneIndex === i) {
                stopReferenceTone();
            } else {
                playReferenceTone(i);
            }
        });

        // First 3 strings in row 0, last 3 in row 1
        const rowIndex = i < 3 ? 0 : 1;
        rows[rowIndex].appendChild(btn);
    });
}

// ============================================================
// TOGGLE TUNER ON/OFF
// ============================================================
function toggleTuner() {
    if (isListening) {
        stopTuner();
    } else {
        startTuner();
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

        // Allocate reusable buffers
        timeDomainBuffer = new Float32Array(analyserNode.fftSize);
        yinBuffer = new Float32Array(Math.floor(analyserNode.fftSize / 2));

        isListening = true;
        wasInTune = false;
        startBtn.classList.add('listening');
        btnIcon.textContent = '\u23F9'; // ⏹
        btnText.textContent = 'Stop Tuning';
        startBtn.setAttribute('aria-label', 'Stop tuning');
        statusMessage.textContent = 'Listening...';
        statusMessage.className = '';

        // Clear pitch history
        pitchHistory.fill(0);
        historyIndex = 0;
        historyCount = 0;

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
        micStream.getTracks().forEach(function(t) { t.stop(); });
        micStream = null;
    }

    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }

    // Release buffers
    timeDomainBuffer = null;
    yinBuffer = null;

    // Reset UI
    startBtn.classList.remove('listening');
    btnIcon.textContent = '\uD83C\uDFA4'; // 🎤
    btnText.textContent = 'Start Tuning';
    startBtn.setAttribute('aria-label', 'Start tuning');
    detectedNote.textContent = '--';
    detectedOctave.textContent = '';
    frequencyDisplay.textContent = '-- Hz';
    centsDisplay.textContent = '0 cents';
    statusMessage.textContent = 'Tap Start to begin';
    statusMessage.className = '';
    gaugeNeedle.style.left = '50%';
    smoothedCents = 0;
    wasInTune = false;

    // Reset gauge ARIA
    gaugeContainer.setAttribute('aria-valuenow', '0');
    gaugeContainer.setAttribute('aria-valuetext', '0 cents');

    // Reset confidence
    confidenceFill.style.width = '0%';
    confidenceFill.style.backgroundColor = 'var(--text-dim)';
    confidenceLabel.textContent = '--';

    // Clear string highlights
    document.querySelectorAll('.string-btn').forEach(function(btn) {
        btn.classList.remove('active', 'in-tune');
    });

    // Clear pitch history
    pitchHistory.fill(0);
    historyIndex = 0;
    historyCount = 0;
    clearPitchHistory();

    // Stop reference tone if playing
    stopReferenceTone();
}

// ============================================================
// REFERENCE TONE PLAYBACK
// ============================================================
function playReferenceTone(index) {
    stopReferenceTone();

    const strings = getActiveStrings();
    if (index < 0 || index >= strings.length) return;

    const freq = strings[index].freq;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    toneContext = new AudioCtx();

    toneGain = toneContext.createGain();
    toneGain.gain.setValueAtTime(0, toneContext.currentTime);
    toneGain.gain.linearRampToValueAtTime(0.25, toneContext.currentTime + 0.05);
    toneGain.connect(toneContext.destination);

    toneOscillator = toneContext.createOscillator();
    toneOscillator.type = 'sine';
    toneOscillator.frequency.setValueAtTime(freq, toneContext.currentTime);
    toneOscillator.connect(toneGain);
    toneOscillator.start();

    playingToneIndex = index;

    // Update visual
    document.querySelectorAll('.tone-trigger').forEach(function(t, i) {
        t.classList.toggle('playing', i === index);
    });

    // Auto-stop after 3 seconds
    toneTimeout = setTimeout(function() { stopReferenceTone(); }, 3000);
}

function stopReferenceTone() {
    if (toneTimeout) {
        clearTimeout(toneTimeout);
        toneTimeout = null;
    }

    if (toneGain && toneContext) {
        try {
            toneGain.gain.linearRampToValueAtTime(0, toneContext.currentTime + 0.05);
        } catch (e) { /* context may be closed */ }
    }

    if (toneOscillator) {
        try {
            toneOscillator.stop(toneContext ? toneContext.currentTime + 0.06 : 0);
        } catch (e) { /* already stopped */ }
        toneOscillator = null;
    }

    if (toneContext) {
        const ctx = toneContext;
        setTimeout(function() { ctx.close().catch(function() {}); }, 100);
        toneContext = null;
    }

    toneGain = null;
    playingToneIndex = null;

    // Remove visual
    document.querySelectorAll('.tone-trigger').forEach(function(t) {
        t.classList.remove('playing');
    });
}

// ============================================================
// PITCH DETECTION LOOP
// ============================================================
function detectPitch() {
    if (!isListening) return;

    analyserNode.getFloatTimeDomainData(timeDomainBuffer);

    // Check if there's enough signal (RMS volume)
    let sumSq = 0;
    for (let i = 0; i < timeDomainBuffer.length; i++) {
        sumSq += timeDomainBuffer[i] * timeDomainBuffer[i];
    }
    const rms = Math.sqrt(sumSq / timeDomainBuffer.length);

    if (rms < 0.008) {
        // Too quiet — no string being played
        animFrameId = requestAnimationFrame(detectPitch);
        return;
    }

    // Run YIN pitch detection
    const result = yinDetect(timeDomainBuffer, audioContext.sampleRate);

    // Update confidence display regardless
    updateConfidence(result.confidence);

    const bounds = getFrequencyBounds();

    if (result.frequency !== -1 && result.frequency > bounds.low && result.frequency < bounds.high) {
        if (result.confidence >= MIN_CONFIDENCE) {
            updateUI(result.frequency);
        }
    }

    animFrameId = requestAnimationFrame(detectPitch);
}

// ============================================================
// YIN PITCH DETECTION ALGORITHM (returns { frequency, confidence })
// ============================================================
function yinDetect(buffer, sampleRate) {
    const halfLen = Math.floor(buffer.length / 2);

    // Zero the reusable buffer
    yinBuffer.fill(0);

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

    if (tauEstimate === -1) return { frequency: -1, confidence: 0 };

    // Confidence = 1 - aperiodicity at the detected tau
    const confidence = 1 - yinBuffer[tauEstimate];

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

    return { frequency: sampleRate / betterTau, confidence: Math.max(0, Math.min(1, confidence)) };
}

// ============================================================
// UPDATE CONFIDENCE DISPLAY
// ============================================================
function updateConfidence(confidence) {
    const pct = Math.round(confidence * 100);
    confidenceFill.style.width = pct + '%';
    confidenceLabel.textContent = pct + '%';

    if (pct < 70) {
        confidenceFill.style.backgroundColor = 'var(--accent)';
    } else if (pct < 85) {
        confidenceFill.style.backgroundColor = 'var(--yellow)';
    } else {
        confidenceFill.style.backgroundColor = 'var(--green)';
    }
}

// ============================================================
// UPDATE UI
// ============================================================
function updateUI(frequency) {
    const strings = getActiveStrings();

    // Determine which guitar string this matches
    let targetString = null;

    if (lockedString !== null) {
        targetString = strings[lockedString];
    } else {
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

    // Update gauge ARIA
    gaugeContainer.setAttribute('aria-valuenow', Math.round(smoothedCents));
    gaugeContainer.setAttribute('aria-valuetext', smoothedCents.toFixed(1) + ' cents, ' + targetString.name + targetString.octave);

    // Highlight the matching string button
    document.querySelectorAll('.string-btn').forEach(function(btn, i) {
        const isTarget = (strings[i] === targetString);
        btn.classList.toggle('active', isTarget && Math.abs(smoothedCents) > 5);
        btn.classList.toggle('in-tune', isTarget && Math.abs(smoothedCents) <= 5);
    });

    // Update status & note color
    const absCents = Math.abs(smoothedCents);
    const isInTune = absCents <= 5;

    if (isInTune) {
        statusMessage.textContent = '\u2713 In Tune!';
        statusMessage.className = 'in-tune';
        detectedNote.style.color = 'var(--green)';
    } else if (absCents <= 15) {
        statusMessage.textContent = smoothedCents < 0 ? '\u2191 Almost \u2014 tune up slightly' : '\u2193 Almost \u2014 tune down slightly';
        statusMessage.className = 'close';
        detectedNote.style.color = 'var(--yellow)';
    } else if (smoothedCents < 0) {
        statusMessage.textContent = '\u2191 Tune Up';
        statusMessage.className = 'flat';
        detectedNote.style.color = 'var(--accent)';
    } else {
        statusMessage.textContent = '\u2193 Tune Down';
        statusMessage.className = 'sharp';
        detectedNote.style.color = 'var(--accent)';
    }

    // Haptic feedback on transition to in-tune
    if (isInTune && !wasInTune) {
        if (navigator.vibrate) {
            navigator.vibrate(50);
        }
    }
    wasInTune = isInTune;

    // Record pitch history (cents)
    pitchHistory[historyIndex] = smoothedCents;
    historyIndex = (historyIndex + 1) % HISTORY_SIZE;
    if (historyCount < HISTORY_SIZE) historyCount++;

    // Draw pitch history
    drawPitchHistory();
}

// ============================================================
// PITCH HISTORY CHART
// ============================================================
function resizePitchCanvas() {
    const rect = pitchCanvas.getBoundingClientRect();
    pitchCanvas.width = rect.width * (window.devicePixelRatio || 1);
    pitchCanvas.height = rect.height * (window.devicePixelRatio || 1);
}

function drawPitchHistory() {
    const w = pitchCanvas.width;
    const h = pitchCanvas.height;
    if (w === 0 || h === 0) return;

    const styles = getComputedStyle(document.documentElement);
    const bgColor = styles.getPropertyValue('--chart-bg').trim();
    const lineColor = styles.getPropertyValue('--chart-line').trim();
    const traceColor = styles.getPropertyValue('--chart-trace').trim();
    const zoneColor = styles.getPropertyValue('--chart-zone').trim();
    const greenColor = styles.getPropertyValue('--green').trim();

    pitchCtx.clearRect(0, 0, w, h);

    // Background
    pitchCtx.fillStyle = bgColor;
    pitchCtx.fillRect(0, 0, w, h);

    // Center line
    const centerY = h / 2;
    pitchCtx.strokeStyle = lineColor;
    pitchCtx.lineWidth = 1;
    pitchCtx.beginPath();
    pitchCtx.moveTo(0, centerY);
    pitchCtx.lineTo(w, centerY);
    pitchCtx.stroke();

    // ±5 cent green zone
    const centsToY = function(c) {
        return centerY - (c / 50) * (h / 2);
    };
    const zoneTop = centsToY(5);
    const zoneBottom = centsToY(-5);
    pitchCtx.fillStyle = zoneColor;
    pitchCtx.fillRect(0, zoneTop, w, zoneBottom - zoneTop);

    if (historyCount < 2) return;

    // Draw trace
    pitchCtx.beginPath();
    pitchCtx.strokeStyle = traceColor;
    pitchCtx.lineWidth = 2 * (window.devicePixelRatio || 1);
    pitchCtx.lineJoin = 'round';

    const count = Math.min(historyCount, HISTORY_SIZE);
    for (let i = 0; i < count; i++) {
        const bufIdx = (historyIndex - count + i + HISTORY_SIZE) % HISTORY_SIZE;
        const cents = Math.max(-50, Math.min(50, pitchHistory[bufIdx]));
        const x = (i / (HISTORY_SIZE - 1)) * w;
        const y = centsToY(cents);
        if (i === 0) {
            pitchCtx.moveTo(x, y);
        } else {
            pitchCtx.lineTo(x, y);
        }
    }
    pitchCtx.stroke();

    // Color the most recent point green if in tune
    if (count > 0) {
        const lastIdx = (historyIndex - 1 + HISTORY_SIZE) % HISTORY_SIZE;
        const lastCents = pitchHistory[lastIdx];
        if (Math.abs(lastCents) <= 5) {
            const x = ((count - 1) / (HISTORY_SIZE - 1)) * w;
            const y = centsToY(Math.max(-50, Math.min(50, lastCents)));
            pitchCtx.beginPath();
            pitchCtx.arc(x, y, 3 * (window.devicePixelRatio || 1), 0, Math.PI * 2);
            pitchCtx.fillStyle = greenColor;
            pitchCtx.fill();
        }
    }
}

function clearPitchHistory() {
    const w = pitchCanvas.width;
    const h = pitchCanvas.height;
    pitchCtx.clearRect(0, 0, w, h);
}

// ============================================================
// HELPER: Frequency -> Note (chromatic)
// ============================================================
function frequencyToNote(freq) {
    const noteNum = 12 * (Math.log2(freq / a4Reference));
    const noteIndex = Math.round(noteNum) + 69; // MIDI note number
    const name = NOTE_NAMES[((noteIndex % 12) + 12) % 12];
    const octave = Math.floor(noteIndex / 12) - 1;
    const exactFreq = a4Reference * Math.pow(2, (noteIndex - 69) / 12);
    const cents = 1200 * Math.log2(freq / exactFreq);
    return { name: name, octave: octave, cents: cents, midiNote: noteIndex };
}

// ============================================================
// HELPER: Find closest guitar string to a frequency
// ============================================================
function findClosestString(freq) {
    const strings = getActiveStrings();
    let closest = strings[0];
    let minCentsDiff = Infinity;

    for (let i = 0; i < strings.length; i++) {
        var centsDiff = Math.abs(1200 * Math.log2(freq / strings[i].freq));
        if (centsDiff < minCentsDiff) {
            minCentsDiff = centsDiff;
            closest = strings[i];
        }
    }
    return closest;
}

// ============================================================
// KEYBOARD NAVIGATION
// ============================================================
function handleKeyboard(e) {
    // Number keys 1-6 select strings
    if (e.key >= '1' && e.key <= '6') {
        const index = parseInt(e.key) - 1;
        const strings = getActiveStrings();
        if (index < strings.length) {
            // Map key 1 = string index 5 (high E), key 6 = string index 0 (low E)
            // Actually key 1 = thinnest string (index 5), key 6 = thickest (index 0)
            const mappedIndex = strings.length - 1 - index;
            if (lockedString === mappedIndex) {
                lockedString = null;
            } else {
                lockedString = mappedIndex;
            }
            rebuildStringSelector();
        }
    }

    // Escape to stop tuner
    if (e.key === 'Escape' && isListening) {
        stopTuner();
    }

    // Space to toggle tuner
    if (e.key === ' ' && e.target === document.body) {
        e.preventDefault();
        toggleTuner();
    }
}

// ============================================================
// INITIALIZATION
// ============================================================
function init() {
    // Restore persisted state
    const savedTheme = localStorage.getItem('guitar-tuner-theme');
    if (savedTheme) applyTheme(savedTheme);
    else initTheme();

    const savedA4 = localStorage.getItem('guitar-tuner-a4');
    if (savedA4) {
        a4Reference = parseInt(savedA4) || 440;
        a4Display.textContent = 'A4 = ' + a4Reference + ' Hz';
    }

    const savedTuning = localStorage.getItem('guitar-tuner-tuning');
    if (savedTuning && TUNINGS[savedTuning]) {
        activeTuningKey = savedTuning;
    }

    // Setup tuning selector
    initTuningSelector();
    tuningLabel.textContent = TUNINGS[activeTuningKey].name + ' Tuning';
    tuningSelect.value = activeTuningKey;

    // Build string buttons
    rebuildStringSelector();

    // Event listeners
    startBtn.addEventListener('click', toggleTuner);

    tuningSelect.addEventListener('change', function() {
        selectTuning(tuningSelect.value);
    });

    a4DownBtn.addEventListener('click', function() { setA4(a4Reference - 1); });
    a4UpBtn.addEventListener('click', function() { setA4(a4Reference + 1); });

    themeToggle.addEventListener('click', function() {
        const current = document.documentElement.getAttribute('data-theme');
        applyTheme(current === 'dark' ? 'light' : 'dark');
    });

    document.addEventListener('keydown', handleKeyboard);

    // Canvas resize
    resizePitchCanvas();
    window.addEventListener('resize', resizePitchCanvas);
}

// ============================================================
// SERVICE WORKER REGISTRATION
// ============================================================
if ('serviceWorker' in navigator) {
    window.addEventListener('load', function() {
        navigator.serviceWorker.register('sw.js')
            .then(function(reg) { console.log('SW registered:', reg.scope); })
            .catch(function(err) { console.log('SW registration failed:', err); });
    });
}

// Start
init();
