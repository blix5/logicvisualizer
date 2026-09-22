import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isFailure } from '../shared/ipc';
import type { ProjectModel } from '../shared/model';
import { bpmAtBeat, buildBarGrid, buildTempoMap, secondsToBeats } from '../shared/timebase';
import { PeakStore } from './audio/PeakStore';
import {
  ArrangeIcon,
  AudioToMidiIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  MusicUploadIcon,
  PauseIcon,
  PianoRollIcon,
  PlayIcon,
  ReloadIcon,
  SparklesIcon,
  ToStartIcon,
} from './components/icons';
import { TranscriptionStore } from './audio/TranscriptionStore';
import { reduceBufferPeaks } from './audio/reducePeaks';
import { ArrangeRenderer, type RenderMode, type StereoSpectrum } from './render/ArrangeRenderer';
import { PianoRollRenderer } from './render/PianoRollRenderer';
import type { PeakPyramid } from './render/peaks';
import { buildRollScene } from './render/rollScene';
import { buildScene } from './render/scene';
import { SPECTRUM_MODES, type SpectrumMode } from './render/spectrum';
import { AudioClock } from './transport/AudioClock';

const LANE_CONFIG = { laneHeight: 44, laneGap: 4 };
const MIN_PPS = 8;
const MAX_PPS = 800;

/** "Ab" + "major" -> "A♭ major". A flat or sharp only follows a note letter. */
function formatKey(key: string | null, scale: 'major' | 'minor' | null): string {
  if (!key) return 'key —';
  const note = /^[A-G][b#]$/.test(key)
    ? `${key[0]}${key[1] === 'b' ? '\u266d' : '\u266f'}`
    : key;
  return scale ? `${note} ${scale}` : note;
}

/**
 * The project's time signature. Only the first is shown: meter CHANGES are read
 * but their positions are not decoded yet (see buildProject), so a live readout
 * would claim more than is known.
 */
function formatMeter(project: ProjectModel): string {
  const sig = project.timeSignatures[0];
  return sig ? `${sig.numerator}/${sig.denominator}` : '4/4';
}

const HEADER_HIDDEN_KEY = 'lv.headerHidden';
/** Height of the floating toolbar; keep in step with .toolbar in app.css. */
const HEADER_HEIGHT = 44;

/** Whether the toolbar was hidden last session. Storage can throw; default to shown. */
function readHeaderHidden(): boolean {
  try { return window.localStorage.getItem(HEADER_HIDDEN_KEY) === '1'; } catch { return false; }
}

function formatTime(seconds: number): string {
  const sign = seconds < 0 ? '-' : '';
  const abs = Math.abs(seconds);
  const m = Math.floor(abs / 60);
  const s = abs - m * 60;
  return `${sign}${m}:${s.toFixed(2).padStart(5, '0')}`;
}

export function App(): JSX.Element {
  const [project, setProject] = useState<ProjectModel | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<RenderMode>('arrange');
  const [pixelsPerSecond, setPixelsPerSecond] = useState(90);
  const [bounceOffset, setBounceOffset] = useState(0);
  const [bounceName, setBounceName] = useState<string | null>(null);
  const [rate, setRate] = useState(1);
  const [playing, setPlaying] = useState(false);
  /** Bumped as peaks land, so the status bar re-renders. Not read per frame. */
  const [peaksVersion, setPeaksVersion] = useState(0);
  /** Piano-roll display options. */
  const [convertAudio, setConvertAudio] = useState(false);
  const [spectrumMode, setSpectrumMode] = useState<SpectrumMode>('none');
  const [headerHidden, setHeaderHidden] = useState(readHeaderHidden);
  const [particles, setParticles] = useState(false);
  /** Bumped as transcriptions land, which rebuilds the roll scene. */
  const [transcriptVersion, setTranscriptVersion] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  // Transport readouts are written straight to the DOM. Routing them through
  // state would re-render the whole app at frame rate, which on its own was a
  // meaningful share of the frame budget.
  const positionRef = useRef<HTMLSpanElement | null>(null);
  const tempoRef = useRef<HTMLSpanElement | null>(null);
  const rendererRef = useRef<ArrangeRenderer | null>(null);
  const rollRendererRef = useRef<PianoRollRenderer | null>(null);
  /** The bounce's peaks, read by the frame loop; only the piano roll draws them. */
  const bouncePeaksRef = useRef<PeakPyramid | null>(null);
  /** Bumped per bounce import, so a slow reduction cannot land on a newer bounce. */
  const bounceGenerationRef = useRef(0);
  const clockRef = useRef<AudioClock | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const peakStoreRef = useRef<PeakStore | null>(null);
  const transcriptStoreRef = useRef<TranscriptionStore | null>(null);
  /** Reused analyser read-outs for the stereo spectrum, left then right. */
  const spectrumRef = useRef<{ left: Float32Array<ArrayBuffer>; right: Float32Array<ArrayBuffer> } | null>(null);
  const scrollTopRef = useRef(0);
  /** Bumped whenever something outside the frame key invalidates the canvas. */
  const dirtyRef = useRef(0);
  // The render loop reads these refs directly so it never depends on React
  // re-rendering at frame rate.
  // Room is kept for the header whether or not it is showing: the title stays
  // up either way, and hiding the toolbar should not reflow the canvas.
  const topInset = HEADER_HEIGHT;
  const viewRef = useRef({ pixelsPerSecond, mode, bounceOffset, spectrumMode, topInset, particles });
  viewRef.current = { pixelsPerSecond, mode, bounceOffset, spectrumMode, topInset, particles };

  const scene = useMemo(
    () => (project ? buildScene(project, LANE_CONFIG) : null),
    [project],
  );

  const rollScene = useMemo(() => {
    if (!project) return null;
    void transcriptVersion;
    const store = transcriptStoreRef.current;
    return buildRollScene(
      project,
      convertAudio && store ? (audioFileId) => store.get(audioFileId) : undefined,
    );
  }, [project, convertAudio, transcriptVersion]);

  const tempoMap = useMemo(
    () => (project ? buildTempoMap(project.tempoEvents, project.baseBpm) : null),
    [project],
  );

  const barGrid = useMemo(() => {
    if (!project || !tempoMap) return [];
    return buildBarGrid(tempoMap, project.timeSignatures, project.endSeconds + 30);
  }, [project, tempoMap]);

  const ensureClock = useCallback((): AudioClock => {
    if (!clockRef.current) {
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      clockRef.current = new AudioClock(ctx);
      peakStoreRef.current = new PeakStore(ctx, () => {
        // The frame loop skips draws unless its key changes, and peaks arriving
        // does not change it — so mark the canvas dirty explicitly. Without this
        // waveforms never appear on a paused view.
        dirtyRef.current += 1;
        setPeaksVersion((version) => version + 1);
      });
      transcriptStoreRef.current = new TranscriptionStore(ctx, () => {
        setTranscriptVersion((version) => version + 1);
      });
    }
    return clockRef.current;
  }, []);

  const peaksLookup = useCallback((audioFileId: string): PeakPyramid | null => {
    const entry = peakStoreRef.current?.get(audioFileId);
    return entry && entry.state === 'ready' ? entry.pyramid : null;
  }, []);

  useEffect(() => {
    try { window.localStorage.setItem(HEADER_HIDDEN_KEY, headerHidden ? '1' : '0'); } catch { /* per-session only */ }
  }, [headerHidden]);

  // The title bar is gone, so the project name lives in the window title.
  useEffect(() => {
    document.title = project ? `${project.projectName} — Logic Visualizer` : 'Logic Visualizer';
  }, [project]);

  useEffect(() => () => {
    peakStoreRef.current?.dispose();
    transcriptStoreRef.current?.dispose();
  }, []);

  /** Hands the transcriber the files audible audio regions actually play. */
  const queueTranscripts = useCallback((model: ProjectModel) => {
    const store = transcriptStoreRef.current;
    if (!store) return;
    const audible = new Set(model.tracks.filter((track) => !track.muted).map((track) => track.id));
    const used = new Set<string>();
    for (const region of model.regions) {
      if (region.kind === 'audio' && region.audioFileId && !region.muted && audible.has(region.trackId)) {
        used.add(region.audioFileId);
      }
    }
    store.setFiles(model.audioFiles.filter((file) => used.has(file.id)));
  }, []);

  // Transcription is expensive, so it only starts once the option is used.
  useEffect(() => {
    if (!convertAudio || !project) return;
    ensureClock();
    transcriptStoreRef.current?.start();
  }, [convertAudio, project, ensureClock]);

  const openProject = useCallback(async () => {
    const picked = await window.lv.project.pick();
    if (!picked) return;
    setBusy(true);
    setError(null);
    const result = await window.lv.project.load(picked);
    setBusy(false);
    if (isFailure(result)) { setError(result.error); return; }
    setProject(result);
    scrollTopRef.current = 0;
    ensureClock().seek(0);
    peakStoreRef.current?.load(result.audioFiles);
    queueTranscripts(result);
    setStatus(`Loaded ${result.projectName}`);
  }, [ensureClock, queueTranscripts]);

  const reloadProject = useCallback(async () => {
    if (!project) return;
    setBusy(true);
    const result = await window.lv.project.load(project.projectPath);
    setBusy(false);
    if (isFailure(result)) { setError(result.error); return; }
    setProject(result);
    ensureClock();
    peakStoreRef.current?.load(result.audioFiles);
    queueTranscripts(result);
    setStatus(`Reloaded at ${new Date().toLocaleTimeString()}`);
  }, [project, ensureClock, queueTranscripts]);

  const openBounce = useCallback(async () => {
    const picked = await window.lv.bounce.pick();
    if (!picked) return;
    setBusy(true);
    const result = await window.lv.bounce.read(picked);
    if (isFailure(result)) { setBusy(false); setError(result.error); return; }
    const clock = ensureClock();
    const ctx = audioCtxRef.current;
    if (!ctx) { setBusy(false); return; }
    try {
      const buffer = await ctx.decodeAudioData(result.bytes);
      clock.setBuffer(buffer);
      bouncePeaksRef.current = null;
      bounceGenerationRef.current += 1;
      const generation = bounceGenerationRef.current;
      dirtyRef.current += 1;
      setBounceName(result.name);
      // Reduced off the main thread; the strip fills in when it lands. A later
      // import may have replaced this bounce by then.
      void reduceBufferPeaks(buffer).then((pyramid) => {
        if (generation !== bounceGenerationRef.current) return;
        bouncePeaksRef.current = pyramid;
        dirtyRef.current += 1;
      }).catch(() => { /* the roll just shows no bounce waveform */ });
      setStatus(`Bounce: ${result.name} (${buffer.duration.toFixed(1)}s)`);
    } catch (decodeError) {
      setError(`Could not decode ${result.name}: ${(decodeError as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [ensureClock]);

  // Renderer setup + resize.
  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    rendererRef.current = new ArrangeRenderer(canvas);
    rollRendererRef.current = new PianoRollRenderer(canvas);
    const resize = () => {
      const rect = stage.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      rendererRef.current?.resize(rect.width, rect.height, dpr);
      rollRendererRef.current?.resize(rect.width, rect.height, dpr);
      dirtyRef.current += 1;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  // The frame loop. Lives outside React entirely.
  useEffect(() => {
    let frame = 0;
    let lastKey = '';
    let lastSounding = 0;
    let spectrumFrame = 0;
    let particleFrame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const renderer = rendererRef.current;
      if (!renderer) return;
      const view = viewRef.current;
      if (!scene) { renderer.clear(); return; }
      const clock = clockRef.current;
      const media = clock ? clock.now() : 0;
      const projectSeconds = media - view.bounceOffset;

      // The spectrum moves with the audio, not the playhead, so while it is on
      // every frame draws — during playback and for a moment after, while the
      // analyser's smoothing decays to silence.
      let spectrum: StereoSpectrum | null = null;
      if (view.spectrumMode !== 'none' && view.mode === 'roll' && clock) {
        const now = performance.now();
        if (clock.isPlaying) lastSounding = now;
        if (now - lastSounding < 1500) {
          const bins = clock.analyserLeft.frequencyBinCount;
          let buffers = spectrumRef.current;
          if (!buffers || buffers.left.length !== bins) {
            buffers = { left: new Float32Array(bins), right: new Float32Array(bins) };
            spectrumRef.current = buffers;
          }
          clock.analyserLeft.getFloatFrequencyData(buffers.left);
          clock.analyserRight.getFloatFrequencyData(buffers.right);
          spectrum = { ...buffers, sampleRate: clock.analyserLeft.context.sampleRate };
          spectrumFrame += 1;
        }
      }

      // Particles keep moving after a pause; draw every frame until they settle.
      const roll = rollRendererRef.current;
      const animating = view.mode === 'roll' && view.particles && (roll?.animating ?? false);
      if (animating) particleFrame += 1;

      // Nothing on screen depends on time beyond where it puts the content, so
      // a paused, untouched view costs nothing. Quarter-pixel granularity is
      // below what the canvas can show.
      const key = `${Math.round(projectSeconds * view.pixelsPerSecond * 4)}|`
        + `${Math.round(scrollTopRef.current)}|${view.pixelsPerSecond}|${view.mode}|`
        + `${view.bounceOffset}|${view.spectrumMode}|${spectrum ? spectrumFrame : 0}|${view.topInset}|${view.particles}|${animating ? particleFrame : 0}|${dirtyRef.current}`;
      if (key !== lastKey) {
        lastKey = key;
        const state = {
          pixelsPerSecond: view.pixelsPerSecond,
          playheadSeconds: projectSeconds,
          scrollTop: scrollTopRef.current,
          mode: view.mode,
          barGrid,
          peaks: peaksLookup,
          bouncePeaks: bouncePeaksRef.current,
          bounceOffset: view.bounceOffset,
          spectrum,
          spectrumMode: view.spectrumMode,
          spectrumLive: clock?.isPlaying ?? false,
          topInset: view.topInset,
          particles: view.particles,
        };
        if (view.mode === 'roll' && roll && rollScene) roll.draw(rollScene, state);
        else renderer.draw(scene, state);
      }

      // Compared against the element's own text, not a cached last value: the
      // position readout is recreated each time the toolbar is shown again.
      const label = formatTime(projectSeconds);
      const position = positionRef.current;
      if (position && position.textContent !== label) position.textContent = label;
      if (tempoMap) {
        const bpm = bpmAtBeat(tempoMap, secondsToBeats(tempoMap, Math.max(0, projectSeconds)));
        const tempo = `${Math.round(bpm * 10) / 10} BPM`;
        const readout = tempoRef.current;
        if (readout && readout.textContent !== tempo) readout.textContent = tempo;
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [scene, rollScene, barGrid, tempoMap, peaksLookup]);

  const togglePlay = useCallback(() => {
    const clock = ensureClock();
    void audioCtxRef.current?.resume();
    clock.toggle();
    setPlaying(clock.isPlaying);
  }, [ensureClock]);

  // Keyboard + wheel.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
      // Matched on the character too, so it follows the keyboard layout.
      if ((event.key === 'h' || event.key === 'H' || event.code === 'KeyH') && !event.metaKey && !event.ctrlKey && !event.altKey) {
        setHeaderHidden((hidden) => !hidden);
      }
      if (event.code === 'Home') { clockRef.current?.seek(0); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) {
        setPixelsPerSecond((current) => {
          const next = current * (event.deltaY < 0 ? 1.12 : 1 / 1.12);
          return Math.min(MAX_PPS, Math.max(MIN_PPS, next));
        });
        return;
      }
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        const clock = clockRef.current;
        if (clock) clock.seek(clock.now() + event.deltaX / viewRef.current.pixelsPerSecond);
        return;
      }
      // The piano roll is locked vertically.
      if (viewRef.current.mode === 'roll') return;
      const height = scene?.contentHeight ?? 0;
      scrollTopRef.current = Math.max(0, Math.min(height, scrollTopRef.current + event.deltaY));
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [scene]);

  // Waveform loading progress, and regions whose source file could not be read.
  const audioStatus = useMemo(() => {
    void peaksVersion;
    const store = peakStoreRef.current;
    if (!project || !store) return null;
    const { done, total } = store.progress;
    let unresolved = 0;
    for (const region of project.regions) {
      if (region.kind !== 'audio') continue;
      if (!region.audioFileId) { unresolved += 1; continue; }
      const entry = store.get(region.audioFileId);
      if (!entry || entry.state === 'pending') continue;
      if (entry.state === 'failed') unresolved += 1;
    }
    return { done, total, unresolved };
  }, [project, peaksVersion]);

  const transcriptStatus = useMemo(() => {
    void transcriptVersion;
    return transcriptStoreRef.current?.progress ?? null;
  }, [transcriptVersion]);

  const stats = useMemo(() => {
    if (!project) return null;
    const midi = project.regions.filter((r) => r.kind === 'midi');
    const audio = project.regions.filter((r) => r.kind === 'audio');
    const notes = midi.reduce((n, r) => n + (r.kind === 'midi' ? r.noteCount : 0), 0);
    return { midi: midi.length, audio: audio.length, notes };
  }, [project]);

  return (
    <div className="app">
      <div className="stage" ref={stageRef}>
        <canvas ref={canvasRef} />
        {!project && (
          <div className="empty">
            <h1>No project open</h1>
            <button className="primary open" onClick={() => void openProject()} disabled={busy}>
              Open project…
            </button>
            <p>
              Open a <code>.logicx</code> project, then import a bounced mixdown of it.
              The arrangement scrolls past a fixed centre playhead in time with the bounce.
            </p>
            <p>Space plays · ⌘-scroll zooms · scroll moves vertically · shift-scroll scrubs · H hides the toolbar</p>
          </div>
        )}

        {headerHidden ? (
          // Still a drag handle for the window, with a quiet way back.
          <div className="dragstrip">
            <button className="icon ghost" onClick={() => setHeaderHidden(false)} title="Show toolbar (H)" aria-label="Show toolbar">
              <ChevronDownIcon />
            </button>
          </div>
        ) : (
          <header className="toolbar">
            <button className="primary" onClick={() => void openProject()} disabled={busy}>Open…</button>
            <button className="icon" onClick={() => void reloadProject()} disabled={!project || busy} title="Reload project" aria-label="Reload project">
              <ReloadIcon />
            </button>
            <button
              className={`icon${bounceName ? ' active' : ''}`}
              onClick={() => void openBounce()}
              disabled={busy}
              title={bounceName ? `Change bounce (${bounceName})` : 'Import bounce'}
              aria-label={bounceName ? 'Change bounce' : 'Import bounce'}
            >
              <MusicUploadIcon />
            </button>

            <button className="icon" onClick={togglePlay} disabled={!project} title={playing ? 'Pause (Space)' : 'Play (Space)'} aria-label={playing ? 'Pause' : 'Play'}>
              {playing ? <PauseIcon /> : <PlayIcon />}
            </button>
            <button className="icon" onClick={() => clockRef.current?.seek(0)} disabled={!project} title="Back to start (Home)" aria-label="Back to start">
              <ToStartIcon />
            </button>
            <span className="readout" ref={positionRef}>0:00.00</span>
            {project && (
              <span className="readout key" title="Key and time signature">
                {formatKey(project.songKey, project.songScale)}
                {' · '}
                {formatMeter(project)}
              </span>
            )}

            {/* The centre is taken by the title, which lives outside the toolbar. */}
            <span className="spacer" />

            <label className="field" title="Bounce offset, in seconds">
              offset
              <input
                type="number"
                step="0.01"
                value={bounceOffset}
                onChange={(e) => setBounceOffset(Number(e.target.value) || 0)}
              />
            </label>
            <label className="field speed" title="Playback speed">
              speed
              <input
                type="number"
                step="0.05"
                min="0.1"
                max="4"
                value={rate}
                onChange={(e) => {
                  const next = Number(e.target.value) || 1;
                  setRate(next);
                  clockRef.current?.setRate(next);
                }}
              />
            </label>

            <div className="segmented" role="group" aria-label="View">
              <button
                className={`icon${mode === 'arrange' ? ' active' : ''}`}
                onClick={() => setMode('arrange')}
                title="Arrange"
                aria-label="Arrange"
                aria-pressed={mode === 'arrange'}
              >
                <ArrangeIcon />
              </button>
              <span className="divider" />
              <button
                className={`icon${mode === 'roll' ? ' active' : ''}`}
                onClick={() => setMode('roll')}
                title="Piano roll"
                aria-label="Piano roll"
                aria-pressed={mode === 'roll'}
              >
                <PianoRollIcon />
              </button>
            </div>
            {mode === 'roll' && (
              <>
                <button
                  className={`icon${convertAudio ? ' active' : ''}`}
                  onClick={() => setConvertAudio((on) => !on)}
                  disabled={!project}
                  title="Audio→MIDI: show audio as its waveform, shifted to its detected pitch (display only)"
                  aria-label="Audio to MIDI"
                  aria-pressed={convertAudio}
                >
                  <AudioToMidiIcon />
                </button>
                <button
                  className={`icon${particles ? ' active' : ''}`}
                  onClick={() => setParticles((on) => !on)}
                  title="Particles where the playhead meets each note"
                  aria-label="Particles"
                  aria-pressed={particles}
                >
                  <SparklesIcon />
                </button>
                <select
                  className="spectrum"
                  value={spectrumMode}
                  onChange={(e) => setSpectrumMode(e.target.value as SpectrumMode)}
                  title="A faint live view of the bounce's spectrum, over everything"
                  aria-label="Spectrum view"
                >
                  {SPECTRUM_MODES.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </>
            )}

            <button className="icon ghost" onClick={() => setHeaderHidden(true)} title="Hide toolbar (H)" aria-label="Hide toolbar">
              <ChevronUpIcon />
            </button>
          </header>
        )}

        {/*
          Title and tempo, centred over the canvas. Outside the toolbar so they
          stay put, and stay visible, when it is hidden.
        */}
        <div className="header-title">
          <span className="title">{project ? project.projectName : 'Logic Visualizer'}</span>
          <span className="readout tempo" ref={tempoRef}>
            {project ? `${project.baseBpm} BPM` : '— BPM'}
          </span>
        </div>
      </div>

      <div className="statusbar">
        {error && <span className="error">{error}</span>}
        {!error && status && <span>{status}</span>}
        {project && stats && (
          <>
            <span>base {project.baseBpm} BPM</span>
            {project.tempoEvents.length > 1 && <span>{project.tempoEvents.length} tempo changes</span>}
            <span>{project.tracks.length} tracks</span>
            <span>{stats.midi} MIDI regions · {stats.notes} notes</span>
            <span>{stats.audio} audio regions</span>
            <span>{pixelsPerSecond.toFixed(0)} px/s</span>
            {!project.capabilities.audioRegionTracks && project.capabilities.audioRegions && (
              <span className="warn">audio track assignment not yet decoded — audio is on one lane</span>
            )}
            {convertAudio && transcriptStatus && transcriptStatus.done < transcriptStatus.total && (
              <span>transcribing audio… {transcriptStatus.done}/{transcriptStatus.total}</span>
            )}
            {audioStatus && audioStatus.done < audioStatus.total && (
              <span>reading waveforms… {audioStatus.done}/{audioStatus.total}</span>
            )}
            {audioStatus && audioStatus.unresolved > 0 && (
              <span className="warn">
                {audioStatus.unresolved} audio {audioStatus.unresolved === 1 ? 'region has' : 'regions have'} no readable source file
              </span>
            )}
            {project.warnings.map((warning) => (
              <span className="warn" key={warning}>{warning}</span>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
