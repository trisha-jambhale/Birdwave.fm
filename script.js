/* script.js
   Full application JS with onboarding flow integrated and fixes applied.
*/

'use strict';

/* --- Configuration --- */
const MOBILE_BREAKPOINT = 900;
const ONBOARD_LOCAL_KEY = 'birdwave_onboard_v1';

// Video playlist
const videos = [
  'videos/1.mp4','videos/2.mp4','videos/3.mp4',
  'videos/4.mp4','videos/5.mp4','videos/6.mp4','videos/7.mp4'
];

let currentVideoIndex = 0;

/* --- App state --- */
let recordings = [];
let filteredRecordings = [];
let nowPlaying = null;
let isPlaying = false;
let activeTrack = null;

/* onboard state */
let onboardState = {
  active: false,
  step: 0,
  highlightBox: null
};

/* waveform RAF */
let _waveRaf = null;

/* --- Helpers --- */
function getVideoEl() { return document.getElementById('bgVideo'); }
function $id(id) { return document.getElementById(id); }
function escapeHtml(str) {
  if (!str && str !== 0) return '';
  return String(str).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* --- Error banner & fetch-with-timeout helper --- */
function showBanner(message, {type='error', timeout=6000} = {}) {
  const banner = $id('appBanner');
  if (!banner) {
    console[type === 'error' ? 'error' : 'log']('BANNER:', message);
    return;
  }
  banner.textContent = message;
  banner.classList.remove('hidden');
  banner.classList.toggle('error', type === 'error');
  clearTimeout(banner._timer);
  if (timeout > 0) banner._timer = setTimeout(()=> banner.classList.add('hidden'), timeout);
}

function handleError(err, context={}) {
  console.error('AppError', context, err);
  const msg = context.userMessage || (err && err.message) || 'An unexpected error occurred';
  showBanner(msg, {type:'error', timeout:8000});
}

async function fetchWithTimeout(url, {timeout=8000, retries=2, backoff=400} = {}) {
  let attempt = 0;
  while (true) {
    attempt++;
    const controller = new AbortController();
    const id = setTimeout(()=>controller.abort(), timeout);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(id);
      if (!res.ok) throw new Error(`HTTP status ${res.status}`);
      return res;
    } catch (err) {
      clearTimeout(id);
      if (attempt > retries) throw err;
      await new Promise(r=>setTimeout(r, backoff * attempt));
    }
  }
}

/* --- BPM estimation / musical helpers --- */
function estimateBPM(length) {
  if (!length) return 75;
  const parts = length.split(':');
  const minutes = parseInt(parts[0], 10) || 0;
  const seconds = parseInt(parts[1], 10) || 0;
  const totalSeconds = (minutes * 60) + seconds;
  if (totalSeconds < 30) return 95;
  if (totalSeconds < 60) return 85;
  if (totalSeconds < 120) return 75;
  return 65;
}
function semitoneToRate(semi) { return Math.pow(2, semi / 12); }
function snapToScale(semitone, rootMidi = 60, scale = [0,2,3,5,7,8,10]) {
  const midi = 60 + semitone;
  const octave = Math.floor((midi - rootMidi) / 12);
  const base = rootMidi + octave * 12;
  let best = base + scale[0];
  let bestDiff = Math.abs(midi - best);
  for (let deg of scale) {
    const note = base + deg;
    const d = Math.abs(midi - note);
    if (d < bestDiff) { bestDiff = d; best = note; }
  }
  return best - 60;
}

/* --- Peak detection helper --- */
async function findBestSliceTime(url, msWindow = 120) {
  try {
    const resp = await fetch(url);
    const arrayBuffer = await resp.arrayBuffer();
    // Use Tone's AudioContext rawContext
    const audioBuffer = await Tone.context.rawContext.decodeAudioData(arrayBuffer);
    const channel = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    const windowSamples = Math.floor((msWindow / 1000) * sampleRate);
    let bestPos = 0;
    let bestEnergy = 0;
    let running = 0;

    for (let i = 0; i < Math.min(windowSamples, channel.length); i++) {
      const s = channel[i];
      running += s * s;
    }
    bestEnergy = running;
    for (let i = windowSamples; i < channel.length; i++) {
      running += channel[i] * channel[i];
      running -= channel[i - windowSamples] * channel[i - windowSamples];
      if (running > bestEnergy) {
        bestEnergy = running;
        bestPos = i - windowSamples;
      }
    }
    return Math.max(0, bestPos / sampleRate);
  } catch (err) {
    console.warn('Peak detect failed:', err);
    return 0;
  }
}

/* --- Tone instruments & sample hook --- */
async function createSampleHook(url, {
  sliceTime = 0,
  sliceDur = 0.14,
  semitone = 0,
  loopRate = '8n',
  vol = -12
} = {}) {
  const player = new Tone.Player({ url, loop: false, autostart: false, volume: vol });
  try { await player.load(); } catch (e) { console.warn('Player load failed', e); }
  const ampEnv = new Tone.AmplitudeEnvelope({ attack: 0.005, decay: 0.06, sustain: 0.0, release: 0.05 });
  player.connect(ampEnv);
  const gain = new Tone.Gain(1);
  ampEnv.connect(gain);

  let hookLoop = null;
  const startHook = () => {
    if (hookLoop) return;
    hookLoop = new Tone.Loop((time) => {
      try {
        try { player.stop(time - 0.002); } catch(e){}
        player.playbackRate = semitoneToRate(semitone);
        player.start(time, sliceTime, sliceDur);
        ampEnv.triggerAttackRelease('8n', time + 0.001);
        try { player.stop(time + sliceDur + 0.02); } catch(e){}
      } catch (e) { console.warn('hook trigger error', e); }
    }, loopRate).start(0);
  };
  const stopHook = () => {
    try {
      if (hookLoop) { hookLoop.stop(); hookLoop.dispose(); hookLoop = null; }
      try { player.stop(); } catch(e) {}
    } catch (e) {}
  };
  const dispose = () => { stopHook(); try { player.dispose(); } catch (e) {} try { ampEnv.dispose(); } catch (e) {} try { gain.dispose(); } catch (e) {} };

  return { player, gain, startHook, stopHook, dispose };
}

function createMasterBus() {
  const comp = new Tone.Compressor({ threshold: -18, ratio: 3, attack: 0.003, release: 0.22 });
  const low = new Tone.Filter(9000, 'lowpass');
  const sat = new Tone.Distortion(( /Chrome/.test(navigator.userAgent) && !/OPR|Edg/.test(navigator.userAgent) ) ? 0.03 : 0.06);
  const reverb = new Tone.Reverb({ decay: 1.8, wet: 0.14 });
  const limiter = new Tone.Limiter(-0.1).toDestination();

  low.connect(sat);
  sat.connect(reverb);
  reverb.connect(comp);
  comp.connect(limiter);

  const wobble = new Tone.LFO(0.11, 7000, 9000).start();
  wobble.connect(low.frequency);

  const vinyl = new Tone.Noise('pink');
  const vFilt = new Tone.Filter(300, 'highpass');
  const vGain = new Tone.Gain(0.015);
  vinyl.connect(vFilt);
  vFilt.connect(vGain);
  vGain.connect(low);
  vinyl.start();

  return { low, sat, reverb, comp, limiter, vinylSource: vinyl, vinylGain: vGain, wobble };
}

function simplePad() {
  return new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'sine' },
    envelope: { attack: 1.0, decay: 0.8, sustain: 0.7, release: 2.0 },
    volume: -20
  });
}
function simpleLead() {
  const lead = new Tone.Synth({
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.015, decay: 0.15, sustain: 0.45, release: 0.5 },
    volume: -12
  });
  return { synth: lead, chorus: null };
}
function simpleBass() {
  return new Tone.MonoSynth({
    oscillator: { type: 'sine' },
    envelope: { attack: 0.01, decay: 0.12, sustain: 0.6, release: 0.5 },
    volume: -14
  });
}
function drumsKit(masterConnect) {
  const kick = new Tone.MembraneSynth({ volume: -8 }).connect(masterConnect);
  const snare = new Tone.NoiseSynth({ volume: -13 }).connect(masterConnect);
  const hat = new Tone.MetalSynth({ volume: -18 }).connect(masterConnect);
  return { kick, snare, hat };
}

/* --- Composition builder --- */
async function createAttentionLike({ audioUrl, sliceTime, semitone, bpm, master, melodyNotes = ['E5','G5','A5','G5','E5','D5','C5','D5'], chords = [['C4','E4','G4','B3'], ['A3','C4','E4','A4'], ['F3','A3','C4','F4'], ['G3','B3','D4','G4']] }) {
  const pad = simplePad();
  const padGain = new Tone.Gain(1);
  pad.connect(padGain);
  padGain.connect(master.reverb);

  const leadObj = simpleLead();
  const lead = leadObj.synth;
  lead.connect(master.reverb);

  const bass = simpleBass();
  bass.connect(master.low);

  const hook = await createSampleHook(audioUrl, { sliceTime, semitone, loopRate: '8n' });
  hook.gain.connect(master.low);

  const kit = drumsKit(master.sat);

  let drumStep = 0;
  const drumLoop = new Tone.Loop((time) => {
    const pos = drumStep % 16;
    if (pos === 0 || pos === 8) kit.kick.triggerAttackRelease('C1', '8n', time);
    if (pos === 4 || pos === 12) kit.snare.triggerAttackRelease('16n', time + 0.003);
    if (pos % 2 === 0) kit.hat.triggerAttackRelease('16n', time + (pos % 4 === 2 ? 0.01 : 0));
    drumStep++;
  }, '16n').start(0);

  let bassStep = 0;
  const bassPattern = ['C2','C2','A1','A1','F1','F1','G1','G1'];
  const bassLoop = new Tone.Loop((time) => {
    bass.triggerAttackRelease(bassPattern[bassStep % bassPattern.length], '8n', time);
    bassStep++;
  }, '2n').start(0);

  let chordStep = 0;
  const chordLoop = new Tone.Loop((time) => {
    pad.triggerAttackRelease(chords[chordStep % chords.length], '1n', time);
    chordStep++;
  }, '2n').start(0);

  let mStep = 0;
  const melodyLoop = new Tone.Loop((time) => {
    lead.triggerAttackRelease(melodyNotes[mStep % melodyNotes.length], '8n', time);
    mStep++;
  }, '8n').start(0);

  hook.startHook();

  melodyLoop.callback = (time) => {
    try {
      padGain.gain.cancelScheduledValues(time);
      padGain.gain.setValueAtTime(0.7, time);
      padGain.gain.linearRampToValueAtTime(1.0, time + (60 / bpm) * 0.6);
    } catch (e) {}
  };

  return {
    stop() {
      [drumLoop, bassLoop, chordLoop, melodyLoop].forEach(l => { try { l.stop(); l.dispose(); } catch (e) {} });
      hook.stopHook();
    },
    dispose() {
      try { hook.dispose(); } catch (e) {}
      try { pad.dispose(); lead.dispose(); bass.dispose(); padGain.dispose(); } catch (e) {}
    }
  };
}

async function style_Attention(params) { return await createAttentionLike({ ...params }); }
async function style_LeftRight(params) {
  const chords = [['F4','A4','C5'], ['D4','F4','A4'], ['Bb3','D4','F4'], ['C4','E4','G4']];
  const melody = ['G5','A5','B5','A5','G5','E5','D5','C5'];
  return await createAttentionLike({ ...params, melodyNotes: melody, chords });
}
async function style_LightSwitch(params) {
  const chords = [['C4','E4','G4'], ['G3','B3','D4'], ['F3','A3','C4'], ['E3','G3','B3']];
  const melody = ['C6','B5','A5','G5','E5','D5','C5','B4'];
  return await createAttentionLike({ ...params, melodyNotes: melody, chords });
}
async function style_WeDontTalkAnymore(params) {
  const chords = [['A3','C4','E4'], ['F3','A3','C4'], ['D3','F3','A3'], ['E3','G3','B3']];
  const melody = ['A5','G5','E5','D5','C5','B4','A4','G4'];
  return await createAttentionLike({ ...params, melodyNotes: melody, chords });
}
async function style_HowLong(params) {
  const chords = [['E4','G#4','B4'], ['C#4','E4','G#4'], ['A3','C#4','E4'], ['B3','D#4','F#4']];
  const melody = ['E5','F#5','G#5','B5','G#5','F#5','E5','B4'];
  return await createAttentionLike({ ...params, melodyNotes: melody, chords });
}

/* --- Playback --- */
async function playProduction() {
  if (!nowPlaying) return;
  try {
    await Tone.start();
    try { Tone.Transport.stop(); Tone.Transport.cancel(); } catch (e) {}

    const master = createMasterBus();
    const audioUrl = `./audio/${nowPlaying.fileName}`;
    const birdIndex = Math.max(0, recordings.findIndex(b => String(b.id) === String(nowPlaying.id)));
    const bpm = nowPlaying.bpmEstimate || 72;
    Tone.Transport.bpm.value = bpm;

    let sliceTime = 0.3;
    try { sliceTime = await findBestSliceTime(audioUrl, 120).catch(() => 0.3); } catch (e) { sliceTime = 0.3; }

    const roots = [60,62,64,65,67];
    const rootMidi = roots[birdIndex % roots.length];
    const targetMidi = rootMidi + 12;
    const sampleBaseMidi = 60;
    let semitoneShift = targetMidi - sampleBaseMidi;
    const snapped = snapToScale(semitoneShift, rootMidi, [0,2,3,5,7,8,10]);
    semitoneShift = snapped;

    const styleIndex = birdIndex % 5;
    let styleInstance = null;
    if (styleIndex === 0) styleInstance = await style_Attention({ audioUrl, sliceTime, semitone: semitoneShift, bpm, master });
    else if (styleIndex === 1) styleInstance = await style_LeftRight({ audioUrl, sliceTime, semitone: semitoneShift, bpm, master });
    else if (styleIndex === 2) styleInstance = await style_LightSwitch({ audioUrl, sliceTime, semitone: semitoneShift, bpm, master });
    else if (styleIndex === 3) styleInstance = await style_WeDontTalkAnymore({ audioUrl, sliceTime, semitone: semitoneShift, bpm, master });
    else styleInstance = await style_HowLong({ audioUrl, sliceTime, semitone: semitoneShift, bpm, master });

    activeTrack = { styleInstance, master };

    if (Tone.Transport.state !== 'started') Tone.Transport.start();

    isPlaying = true;
    const playBtn = $id('playBtn');
    if (playBtn) {
      playBtn.textContent = '⏸ Pause';
      playBtn.setAttribute('aria-pressed', 'true');
    }

    const srStatus = $id('srStatus');
    if (srStatus && nowPlaying) srStatus.textContent = `Playing ${nowPlaying.species}, duration ${nowPlaying.length}`;

    startWaveformAnimation();
  } catch (err) {
    console.error('playProduction error', err);
    handleError(err, { userMessage: 'Failed to play production. Check console.' });
    stopPlay();
  }
}

function stopPlay() {
  if (activeTrack) {
    try {
      if (activeTrack.styleInstance && activeTrack.styleInstance.stop) activeTrack.styleInstance.stop();
      if (activeTrack.styleInstance && activeTrack.styleInstance.dispose) activeTrack.styleInstance.dispose();

      if (activeTrack.master) {
        try { if (activeTrack.master.low && activeTrack.master.low.dispose) activeTrack.master.low.dispose(); } catch(e) {}
        try { if (activeTrack.master.sat && activeTrack.master.sat.dispose) activeTrack.master.sat.dispose(); } catch(e) {}
        try { if (activeTrack.master.reverb && activeTrack.master.reverb.dispose) activeTrack.master.reverb.dispose(); } catch(e) {}
        try { if (activeTrack.master.vinylSource && activeTrack.master.vinylSource.stop) activeTrack.master.vinylSource.stop(); } catch(e) {}
        try { if (activeTrack.master.wobble && activeTrack.master.wobble.stop) activeTrack.master.wobble.stop(); } catch(e) {}
        try { if (activeTrack.master.limiter && activeTrack.master.limiter.dispose) activeTrack.master.limiter.dispose(); } catch(e) {}
        try { if (activeTrack.master.comp && activeTrack.master.comp.dispose) activeTrack.master.comp.dispose(); } catch(e) {}
      }
    } catch (e) { console.warn('Error stopping active track', e); }
    activeTrack = null;
  }

  try { Tone.Transport.stop(); Tone.Transport.cancel(0); } catch (e) {}
  isPlaying = false;
  const playBtn = $id('playBtn');
  if (playBtn) {
    playBtn.textContent = '▶ Play';
    playBtn.setAttribute('aria-pressed', 'false');
  }

  const srStatus = $id('srStatus');
  if (srStatus) srStatus.textContent = 'Playback stopped';

  stopWaveformAnimation();
}

/* --- Waveform animation (optional) --- */
function startWaveformAnimation() {
  const canvas = $id('waveformCanvas');
  if (!canvas) return;
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
  const ctx = canvas.getContext('2d');

  function draw() {
    if (!isPlaying) { _waveRaf = null; return; }
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0,0,w,h);
    ctx.lineWidth = 2 * devicePixelRatio;
    ctx.strokeStyle = 'rgba(255, 0, 153, 0.85)';
    const amp = 0.6 + Math.random() * 0.3;
    ctx.beginPath();
    const steps = 100;
    for (let i = 0; i < steps; i++) {
      const px = (i / (steps - 1)) * w;
      const rnd = Math.sin((i + Date.now() / 80) / 4) * amp * (0.5 + Math.random() * 0.5);
      const py = (0.5 + rnd) * h;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.lineWidth = 6 * devicePixelRatio;
    ctx.strokeStyle = 'rgba(255, 0, 153, 0.08)';
    ctx.stroke();
    _waveRaf = requestAnimationFrame(draw);
  }
  if (!_waveRaf) draw();
}
function stopWaveformAnimation() { if (_waveRaf) cancelAnimationFrame(_waveRaf); _waveRaf = null; }

/* --- Video playlist setup --- */
function setVideo(index) {
  index = (index + videos.length) % videos.length;
  currentVideoIndex = index;
  const videoEl = getVideoEl();
  if (!videoEl) return;
  videoEl.style.transition = 'opacity 0.5s ease';
  videoEl.style.opacity = '0.3';
  const srcEl = videoEl.querySelector('source');
  setTimeout(() => {
    if (srcEl) {
      srcEl.src = videos[currentVideoIndex];
      videoEl.load();
      videoEl.oncanplay = () => {
        videoEl.play().then(() => { videoEl.style.opacity = '0.7'; }).catch(err => { console.warn('Autoplay prevented:', err); videoEl.style.opacity = '0.7'; });
      };
    }
  }, 300);
}
function playNextVideo() { setVideo(currentVideoIndex + 1); }

/* --- Render bird list --- */
function renderBirdList() {
  const birdList = $id('birdList');
  if (!birdList) return;
  if (filteredRecordings.length === 0) {
    birdList.innerHTML = '<div class="loading">No recordings found</div>';
    return;
  }

  birdList.innerHTML = filteredRecordings.map(bird => {
    const active = nowPlaying && nowPlaying.id === bird.id ? 'active' : '';
    return `
      <div class="bird-card ${active}" data-id="${bird.id}" role="listitem">
        <div class="bird-row" role="button" tabindex="0" aria-controls="details-${bird.id}" aria-expanded="${active ? 'true' : 'false'}">
          <div class="bird-name">${escapeHtml(bird.species)}</div>
        </div>
        <div class="bird-details" id="details-${bird.id}" aria-hidden="${active ? 'false' : 'true'}">
          <div class="details-inner"></div>
        </div>
      </div>
    `;
  }).join('');

  Array.from(birdList.querySelectorAll('.bird-row')).forEach(row => {
    const card = row.closest('.bird-card');
    const id = card.getAttribute('data-id');
    row.addEventListener('click', () => handleBirdRowSelect(id));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleBirdRowSelect(id);
      }
    });
  });
}

/* --- Inline details helpers --- */
function clearAllInlineDetails(returnFocusToRow = false) {
  const list = $id('birdList');
  if (!list) return;
  Array.from(list.querySelectorAll('.bird-details')).forEach(d => {
    d.classList.remove('open');
    d.setAttribute('aria-hidden', 'true');
    const inner = d.querySelector('.details-inner');
    if (inner) inner.innerHTML = '';
    const row = d.previousElementSibling;
    if (row && row.classList.contains('bird-row')) {
      row.setAttribute('aria-expanded', 'false');
      if (returnFocusToRow) row.focus();
    }
  });
  Array.from(list.querySelectorAll('.bird-card')).forEach(c => c.classList.remove('active'));
}

function openInlineDetailsFor(id, bird) {
  clearAllInlineDetails();
  const details = $id(`details-${id}`);
  if (!details) return;
  const inner = details.querySelector('.details-inner');
  if (!inner) return;

  inner.innerHTML = `
    <div class="details-title">${escapeHtml(bird.species)}</div>
    <div class="details-row"><strong>Type:</strong>&nbsp;<span>${escapeHtml(bird.soundType || '—')}</span></div>
    <div class="details-row"><strong>Location:</strong>&nbsp;<span>${escapeHtml(bird.region || '')} · ${escapeHtml(bird.loc || '')}</span></div>
    <div class="details-row"><strong>Duration:</strong>&nbsp;<span>${escapeHtml(bird.length || '—')}</span></div>
    <div class="details-row"><strong>Recordist:</strong>&nbsp;<span>${escapeHtml(bird.recordist || '—')}</span></div>
  `;

  details.classList.add('open');
  details.setAttribute('aria-hidden', 'false');
  const row = details.previousElementSibling;
  if (row && row.classList.contains('bird-row')) {
    row.setAttribute('aria-expanded', 'true');
    const card = row.closest('.bird-card');
    if (card) card.classList.add('active');
    setTimeout(() => { card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 80);
    // focus the details for screen readers
    details.setAttribute('tabindex', '-1');
    details.focus();
  }
}

/* --- Targeted UI update --- */
function markCardActive(id) {
  const list = $id('birdList');
  if (!list) return;
  Array.from(list.querySelectorAll('.bird-card')).forEach(c => {
    const isActive = c.dataset.id === String(id);
    c.classList.toggle('active', isActive);
    const row = c.querySelector('.bird-row');
    const details = c.querySelector('.bird-details');
    if (row) row.setAttribute('aria-expanded', isActive ? 'true' : 'false');
    if (details) details.setAttribute('aria-hidden', isActive ? 'false' : 'true');
    if (!isActive && details) {
      const inner = details.querySelector('.details-inner');
      if (inner) inner.innerHTML = '';
      details.classList.remove('open');
    }
  });
}

/* --- Determine mobile view --- */
function isMobileView() { return (window.innerWidth || document.documentElement.clientWidth) <= MOBILE_BREAKPOINT; }

/* --- Onboarding functions (corrected & robust) --- */
function removeOnboardHighlight() {
  if (onboardState.highlightBox) {
    try { onboardState.highlightBox.remove(); } catch(e) {}
    onboardState.highlightBox = null;
  }
}
function showOnboardHighlight(target) {
  removeOnboardHighlight();
  if (!target) return;
  const r = target.getBoundingClientRect();
  const box = document.createElement('div');
  box.className = 'onboard-highlight';
  box.style.top = `${r.top + window.scrollY - 8}px`;
  box.style.left = `${r.left + window.scrollX - 8}px`;
  box.style.width = `${r.width + 16}px`;
  box.style.height = `${r.height + 16}px`;
  document.body.appendChild(box);
  onboardState.highlightBox = box;
}
function positionTooltipNear(target, prefer='right') {
  const tip = $id('onboardTooltip');
  if (!target || !tip) return;
  const rect = target.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  const padding = 12;

  // compute preferred placement then adjust for viewport
  let top = rect.top + window.scrollY;
  let left = rect.right + window.scrollX + padding;

  // if off-screen to right -> place left
  if (left + tipRect.width > window.innerWidth - 8) {
    left = rect.left + window.scrollX - tipRect.width - padding;
  }
  // if still off-screen horizontally -> center above/below
  if (left < 8) left = Math.max(8, (window.innerWidth - tipRect.width)/2);

  // prefer vertical centering relative to target
  top = rect.top + window.scrollY + (rect.height - tipRect.height)/2;
  if (top < 8) top = rect.bottom + window.scrollY + padding; // put below
  if (top + tipRect.height > window.innerHeight - 8) top = Math.max(8, rect.top + window.scrollY - tipRect.height - padding); // above

  tip.style.top = `${Math.max(8, Math.round(top))}px`;
  tip.style.left = `${Math.max(8, Math.round(left))}px`;

  // arrow positioning (if present)
  const arrow = tip.querySelector('.onboard-arrow');
  if (arrow) {
    arrow.style.left = `${Math.max(8, Math.round((tipRect.width/2) - 9))}px`;
    arrow.style.top = '';
  }
}

function renderOnboardStep() {
  const overlay = $id('onboardOverlay');
  const tip = $id('onboardTooltip');
  const titleEl = $id('onboardTitle');
  const descEl = $id('onboardDesc');

  if (!overlay || !tip || !titleEl || !descEl) return;

  overlay.classList.remove('hidden');
  tip.classList.remove('hidden');
  tip.setAttribute('aria-hidden','false');

  removeOnboardHighlight();

    if (onboardState.step === 1) {
    titleEl.textContent = 'Choose a channel';
    descEl.textContent = 'Select a bird from the left-hand list to view its details and remix the recording.';
    const target = document.querySelector('.channel-selector') || $id('birdList');
    if (target) { showOnboardHighlight(target); positionTooltipNear(target, 'right'); }
  } else if (onboardState.step === 2) {
    titleEl.textContent = 'Species info';
    descEl.textContent = 'This panel shows metadata like type, location, duration, and who recorded it.';
    const isMobile = isMobileView();
    let target = null;
    if (isMobile) {
      target = document.querySelector('.bird-details.open') || $id('speciesInfo');
    } else {
      target = $id('speciesInfo');
    }
    if (target) { showOnboardHighlight(target); positionTooltipNear(target, isMobile ? 'bottom' : 'right'); }
  } else if (onboardState.step === 3) {
    titleEl.textContent = 'Playback controls';
    descEl.textContent = 'Control playback, skip tracks, stop or enable fullscreen on desktop.';
    const fs = $id('fullscreenBtn');
    const controls = $id('controlsSection');
    const preferFs = !isMobileView() && fs && fs.offsetParent !== null;
    const target = preferFs ? fs : controls || $id('controlsSection');
    if (target) { showOnboardHighlight(target); positionTooltipNear(target, preferFs ? 'left' : 'top'); }
  } else {
    // finish
    closeOnboard(true);
  }

}

function showOnboard(force = false) {
  try {
    const urlParams = new URLSearchParams(window.location.search);
    if (!force && !urlParams.has('onboard') && localStorage.getItem(ONBOARD_LOCAL_KEY)) return;
  } catch (e) {}
  if (onboardState.active) return;
  onboardState.active = true;
  onboardState.step = 1;

  $id('onboardOk').addEventListener('click', onOnboardOk);
  $id('onboardSkip').addEventListener('click', onOnboardSkip);
  document.addEventListener('keydown', onOnboardKeydown);

  renderOnboardStep();
}
function closeOnboard(markComplete = true) {
  onboardState.active = false;
  onboardState.step = 0;
  const overlay = $id('onboardOverlay');
  const tip = $id('onboardTooltip');
  if (overlay) overlay.classList.add('hidden');
  if (tip) { tip.classList.add('hidden'); tip.setAttribute('aria-hidden','true'); }
  removeOnboardHighlight();
  try { $id('onboardOk').removeEventListener('click', onOnboardOk); } catch(e){}
  try { $id('onboardSkip').removeEventListener('click', onOnboardSkip); } catch(e){}
  try { document.removeEventListener('keydown', onOnboardKeydown); } catch(e){}
  if (markComplete) { try { localStorage.setItem(ONBOARD_LOCAL_KEY, '1'); } catch(e){} }
}
function onOnboardOk() {
  if (!onboardState.active) return;
  if (onboardState.step === 1) {
    // if no selection yet we still move to step 2, but ideally user selected -> we handle that case automatically too
    onboardState.step = 2;
    renderOnboardStep();
  } else if (onboardState.step === 2) {
    onboardState.step = 3;
    renderOnboardStep();
  } else {
    closeOnboard(true);
  }
}
function onOnboardSkip() { closeOnboard(true); }
function onOnboardKeydown(e) {
  if (!onboardState.active) return;
  if (e.key === 'Escape') closeOnboard(true);
  if (e.key === 'Enter') onOnboardOk();
}
// Called from selection flow when user picks a bird
function onboardAdvanceOnSelection() {
  if (!onboardState.active) return;
  if (onboardState.step === 1) {
    onboardState.step = 2;
    renderOnboardStep();
  }
}

/* reposition on resize/scroll */
window.addEventListener('resize', () => { if (onboardState.active) renderOnboardStep(); });
window.addEventListener('scroll', () => { if (onboardState.active) renderOnboardStep(); }, true);

/* --- Load recordings & render --- */
async function loadRecordings() {
  try {
    const response = await fetchWithTimeout('bird-recordings.json', { timeout:8000, retries:2, backoff:400 });
    const data = await response.json();

    recordings = data.recordings.map(bird => ({
      id: String(bird.id),
      species: bird.en,
      en: bird.en,
      region: bird.cnt,
      loc: bird.loc,
      bpmEstimate: estimateBPM(bird.length),
      recordist: bird.rec,
      tags: [bird.type, bird.q].filter(Boolean),
      soundType: bird.type || 'song',
      fileName: `XC${bird.id}.mp3`,
      length: bird.length || '0:45'
    }));

    filteredRecordings = [...recordings].sort((a,b) => a.species.localeCompare(b.species));
    renderBirdList();
  } catch (error) {
    console.error('Error loading recordings:', error);
    handleError(error, { userMessage: 'Failed to load recordings — check your network or server.' });
    const birdListEl = $id('birdList');
    if (birdListEl) {
      birdListEl.innerHTML = `
        <div class="loading">
          Error loading recordings: ${escapeHtml(error.message)}<br><br>
          Make sure:<br>
          1. bird-recordings.json is in the same folder<br>
          2. You're running a local server (python -m http.server 8000)
        </div>`;
    }
  }
}

/* --- Selection & UI wiring --- */
async function handleBirdRowSelect(id) {
  const bird = recordings.find(b => b.id === id);
  if (!bird) return;

  const controls = $id('controlsSection');
  if (controls) controls.classList.remove('hidden');

  if (isMobileView()) {
    openInlineDetailsFor(id, bird);
    const speciesInfo = $id('speciesInfo');
    if (speciesInfo) speciesInfo.classList.add('hidden');

    if (isPlaying) stopPlay();
    nowPlaying = bird;

    // advance onboarding if needed
    try { onboardAdvanceOnSelection(); } catch(e) {}

    const vidIndex = getBirdVideoIndex(bird.id);
    setVideo(vidIndex);

    try { await playProduction(); } catch (e) { console.warn('Auto-play after selection failed:', e); }

    // update active state only (avoid full re-render)
    markCardActive(id);
    // reopen details after small delay to ensure DOM stable
    setTimeout(() => openInlineDetailsFor(id, bird), 40);
  } else {
    // desktop: fixed panel
    selectBird(id);
  }
}

/* --- Desktop select (fixed panel) --- */
async function selectBird(id) {
  const bird = recordings.find(b => b.id === id);
  if (!bird) return;

  clearAllInlineDetails();

  if (isPlaying) stopPlay();

  nowPlaying = bird;

  // update species panel
  const speciesInfo = $id('speciesInfo');
  if (speciesInfo) {
    speciesInfo.classList.remove('hidden');
    speciesInfo.classList.add('fixed-bottom');
  }

  const speciesName = $id('speciesName'); if (speciesName) speciesName.textContent = bird.species;
  const soundType = $id('soundType'); if (soundType) soundType.textContent = bird.soundType;
  const location = $id('location'); if (location) location.textContent = `${bird.region} • ${bird.loc}`;
  const duration = $id('duration'); if (duration) duration.textContent = bird.length;
  const recordist = $id('recordist'); if (recordist) recordist.textContent = bird.recordist;

  markCardActive(id);

  // advance onboarding if applicable
  try { onboardAdvanceOnSelection(); } catch(e) {}

  const vidIndex = getBirdVideoIndex(bird.id);
  setVideo(vidIndex);

  const controls = $id('controlsSection');
  if (controls) controls.classList.remove('hidden');

  try { await playProduction(); } catch (e) { console.warn('Auto-play after selection failed:', e); }
}

/* navigation helpers */
function nextTrack() {
  if (!nowPlaying || filteredRecordings.length === 0) return;
  const currentIndex = filteredRecordings.findIndex(b => b.id === nowPlaying.id);
  const nextIndex = (currentIndex + 1) % filteredRecordings.length;
  selectBird(filteredRecordings[nextIndex].id);
}
function previousTrack() {
  if (!nowPlaying || filteredRecordings.length === 0) return;
  const currentIndex = filteredRecordings.findIndex(b => b.id === nowPlaying.id);
  const prevIndex = currentIndex === 0 ? filteredRecordings.length - 1 : currentIndex - 1;
  selectBird(filteredRecordings[prevIndex].id);
}

/* fullscreen label */
function toggleFullscreenLabel() {
  const btn = $id('fullscreenBtn');
  if (!btn) return;
  if (document.fullscreenElement) btn.textContent = '🗗 Min';
  else btn.textContent = '⛶ Full';
}

/* get video index */
function getBirdVideoIndex(birdId) {
  const birdIndex = recordings.findIndex(b => b.id === birdId);
  return (birdIndex === -1) ? 0 : (birdIndex % videos.length);
}

/* responsive re-parenting */
(function() {
  const speciesInfo = $id('speciesInfo');
  const controlsSection = $id('controlsSection');
  const channelSelector = document.querySelector('.channel-selector');
  const mainArea = $id('mainArea');
  const footer = document.querySelector('.footer');

  const originalSpeciesParent = speciesInfo ? speciesInfo.parentElement : null;
  const originalControlsParent = controlsSection ? controlsSection.parentElement : null;

  function moveToMobileFlow() {
    if (!speciesInfo || !channelSelector || !controlsSection || !footer) return;
    if (channelSelector.nextElementSibling !== speciesInfo) {
      channelSelector.parentNode.insertBefore(speciesInfo, channelSelector.nextElementSibling);
    }
    if (speciesInfo.nextElementSibling !== controlsSection) {
      speciesInfo.parentNode.insertBefore(controlsSection, speciesInfo.nextElementSibling);
    }
    footer.classList.add('mobile-footer');
    speciesInfo.classList.add('fixed-bottom');
  }

  function restoreDesktopFlow() {
    if (!speciesInfo || !mainArea || !controlsSection || !footer) return;
    if (originalSpeciesParent && speciesInfo.parentElement !== originalSpeciesParent) {
      originalSpeciesParent.appendChild(speciesInfo);
    }
    if (originalControlsParent && controlsSection.parentElement !== originalControlsParent) {
      originalControlsParent.appendChild(controlsSection);
    }
    footer.classList.remove('mobile-footer');
    speciesInfo.classList.remove('fixed-bottom');
  }

  function debounce(fn, wait=120) { let t; return (...a) => { clearTimeout(t); t=setTimeout(()=>fn(...a), wait); }; }

  function handleResponsiveLayout() {
    const w = window.innerWidth || document.documentElement.clientWidth;
    if (w <= MOBILE_BREAKPOINT) moveToMobileFlow();
    else restoreDesktopFlow();
  }

  window.addEventListener('resize', debounce(handleResponsiveLayout));
  window.addEventListener('orientationchange', debounce(handleResponsiveLayout));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', handleResponsiveLayout);
  else handleResponsiveLayout();
})();

/* --- DOM ready wiring (async so we can await loadRecordings) --- */
document.addEventListener('DOMContentLoaded', async () => {
  const videoEl = getVideoEl();
  if (videoEl) {
    setVideo(0);
    videoEl.addEventListener('ended', playNextVideo);
    videoEl.addEventListener('error', (e) => { console.error('Video error:', e, 'source:', videoEl.currentSrc); playNextVideo(); });
  }

  const tryPlayOnGesture = () => { Tone.start().catch(()=>{}); if (videoEl) videoEl.play().catch(()=>{}); document.removeEventListener('click', tryPlayOnGesture); document.removeEventListener('keydown', tryPlayOnGesture); };
  document.addEventListener('click', tryPlayOnGesture);
  document.addEventListener('keydown', tryPlayOnGesture);

  const playBtn = $id('playBtn');
  const nextBtn = $id('nextBtn');
  const prevBtn = $id('prevBtn');
  const stopBtn = $id('stopBtn');
  const fullscreenBtn = $id('fullscreenBtn');

  if (playBtn) {
    playBtn.addEventListener('click', async () => {
      if (!nowPlaying) return;
      if (isPlaying) { stopPlay(); }
      else { await playProduction(); }
    });
  }
  if (nextBtn) nextBtn.addEventListener('click', nextTrack);
  if (prevBtn) prevBtn.addEventListener('click', previousTrack);
  if (stopBtn) stopBtn.addEventListener('click', () => { stopPlay(); });

  if (fullscreenBtn) {
    fullscreenBtn.addEventListener('click', () => {
      const doc = document;
      const el = document.documentElement;
      if (!doc.fullscreenElement) {
        if (el.requestFullscreen) el.requestFullscreen();
        else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      } else {
        if (doc.exitFullscreen) doc.exitFullscreen();
        else if (doc.webkitExitFullscreen) doc.webkitExitFullscreen();
      }
    });
  }

  document.addEventListener('fullscreenchange', toggleFullscreenLabel);
  toggleFullscreenLabel();

  await loadRecordings();

  // --- Autoload first track, timed autoplay, then onboarding ---
// Behavior:
// 1) Wait 2s after recordings load, then select the first track (UI shows it loaded).
// 2) After 5s more (i.e. 7s after load) attempt to autoplay playback.
// 3) When playback starts (or after the autoplay attempt), show the onboarding.
//    If you already completed onboarding it won't show; append ?onboard=1 to force it.

try {
  const urlParams = new URLSearchParams(window.location.search);
  const forceOnboard = urlParams.has('onboard');

  // only do autoload if recordings are present
  if (filteredRecordings && filteredRecordings.length > 0) {
    // choose first recording
    const first = filteredRecordings[0];

    // after 2s, select the first bird so UI renders species info and controls
    setTimeout(async () => {
      try {
        // Use your existing selection method to keep behavior consistent
        // For desktop this will populate speciesInfo; for mobile it will open inline details.
        selectBird(first.id);
      } catch (e) {
        console.warn('Autoload select failed:', e);
      }
    }, 2000);

    // after 7s from load (2s + 5s), attempt to play
    setTimeout(async () => {
      try {
        // if nothing selected for some reason, set nowPlaying explicitly
        if (!nowPlaying) nowPlaying = first;

        // Try starting playback; this may fail due to autoplay policies but we catch it
        await playProduction().catch(err => { console.warn('Autoplay attempt failed:', err); });

        // After the autoplay attempt (whether it succeeded or not), show onboarding.
        // showOnboard will respect localStorage; forceOnboard lets you override with ?onboard=1
        showOnboard(forceOnboard);
      } catch (err) {
        console.warn('Timed autoplay/onboard error:', err);
        // fallback: still try to show onboarding (won't show if already completed)
        showOnboard(forceOnboard);
      }
    }, 7000);
  } else {
    // no recordings; still try to show onboarding (it will gracefully no-op)
    showOnboard(forceOnboard);
  }
} catch (e) {
  console.warn('Autoload/onboard bootstrap failed:', e);
  showOnboard(false);
}

});
