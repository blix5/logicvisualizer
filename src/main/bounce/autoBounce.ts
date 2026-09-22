// Orchestrates a full automatic bounce: open the .logicx in Logic Pro, drive
// Logic's Bounce command to a known output directory via AppleScript, then wait
// for the rendered audio file to appear. Best-effort and Logic-version-sensitive
// (it UI-scripts two dialogs); every failure returns a user-facing message.
//
// Lives outside src/main/logic/ because that vendored parser may not shell out
// to osascript (see src/main/logic/VENDORED.md). The pure builders/predicates
// and the injectable-deps orchestrator are unit-tested off-macOS.
import path from 'node:path';
import { resolveLogicPaths } from '../logic/logicPaths';
import {
  escapeAppleScriptString,
  getRunningLogicVariant,
  openLogicProject,
  runAppleScript,
  type AppleScriptResult,
  type LogicProVariant,
} from './logicControl';

// Any of these appearing in the (empty) output dir counts as the bounce result,
// so whichever destination format Logic has enabled is picked up. Shared with
// the manual-import picker in ipc.ts to keep the two lists from drifting.
export const BOUNCE_AUDIO_EXTENSIONS = ['wav', 'aif', 'aiff', 'mp3', 'm4a', 'caf', 'flac'];

const POLL_INTERVAL_MS = 1_000;
const DOCUMENT_OPEN_TIMEOUT_MS = 60_000;
const DOCUMENT_CHECK_TIMEOUT_MS = 10_000;
const BOUNCE_SCRIPT_TIMEOUT_MS = 60_000;
// The driving script returns right after clicking Bounce, so this only covers
// the render, which can run long for big projects.
const OUTPUT_TIMEOUT_MS = 20 * 60_000;
const OUTPUT_POLL_INTERVAL_MS = 1_500;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** AppleScript that succeeds once a document at `logicxPath` is open. App-level
 * Apple events only (needs Automation permission, not Accessibility). */
export function buildDocumentOpenScript(variant: LogicProVariant, logicxPath: string): string {
  const appName = escapeAppleScriptString(variant.appName);
  const target = escapeAppleScriptString(logicxPath);
  return `
tell application "${appName}"
  if (count of documents) < 1 then error "No Logic document is open"
  set found to false
  repeat with d in documents
    try
      set dp to path of d
      if dp is "${target}" or dp is "${target}/" then set found to true
    end try
  end repeat
  if not found then error "No matching Logic document is open"
end tell
`;
}

/** AppleScript that drives File ▸ Bounce ▸ Project or Section (⌘B), the Bounce
 * settings dialog, and the Save panel — pointing the save panel at `outDir` via
 * Go to Folder. Needs Accessibility permission (System Events UI scripting).
 *
 * Verified against Logic Pro 11 (Creator Studio):
 *  - The settings dialog ("Bounce <name>") is confirmed with its OK button.
 *  - It then reveals the standard Save panel whose default button Logic labels
 *    "Bounce" — that button lives inside the panel's split group, NOT as a
 *    direct child of the window, so the search descends into splitter groups.
 *  - Go to Folder's typed path is confirmed with the physical Return key
 *    (key code 36) to dismiss its autocomplete sheet, then the panel needs a
 *    moment to settle before the Bounce button becomes clickable.
 * Older builds may label the settings button "Bounce" and the save button
 * "Save", so each step tries a small list of names. */
export function buildBounceScript(variant: LogicProVariant, outDir: string): string {
  const appName = escapeAppleScriptString(variant.appName);
  const processName = escapeAppleScriptString(variant.processName);
  const dir = escapeAppleScriptString(outDir);

  return `
on hasButton(processName, btnName)
  tell application "System Events"
    tell process processName
      repeat with w in windows
        try
          if exists button btnName of w then return true
        end try
        try
          if exists button btnName of sheet 1 of w then return true
        end try
        try
          repeat with sg in splitter groups of w
            if exists button btnName of sg then return true
          end repeat
        end try
      end repeat
    end tell
  end tell
  return false
end hasButton

on clickButton(processName, btnName)
  tell application "System Events"
    tell process processName
      repeat with attempt from 1 to 40
        repeat with w in windows
          try
            if exists button btnName of w then
              click button btnName of w
              return true
            end if
          end try
          try
            if exists button btnName of sheet 1 of w then
              click button btnName of sheet 1 of w
              return true
            end if
          end try
          try
            repeat with sg in splitter groups of w
              if exists button btnName of sg then
                click button btnName of sg
                return true
              end if
            end repeat
          end try
        end repeat
        delay 0.15
      end repeat
    end tell
  end tell
  return false
end clickButton

on waitForButton(processName, names)
  repeat with attempt from 1 to 60
    repeat with n in names
      if my hasButton(processName, (n as text)) then return (n as text)
    end repeat
    delay 0.2
  end repeat
  return missing value
end waitForButton

tell application "${appName}" to activate
delay 0.5

tell application "System Events"
  tell process "${processName}"
    keystroke "b" using {command down}
  end tell
end tell

-- Settings dialog ("Bounce <name>"): confirm with OK (older builds: Bounce).
set settingsButton to my waitForButton("${processName}", {"OK", "Bounce"})
if settingsButton is missing value then error "Bounce dialog did not appear"
my clickButton("${processName}", settingsButton)

-- Save panel: wait for it, point it at the output folder, then render.
set saveButton to my waitForButton("${processName}", {"Bounce", "Save"})
if saveButton is missing value then error "Save dialog did not appear"

tell application "System Events"
  tell process "${processName}"
    keystroke "g" using {command down, shift down}
    delay 0.6
    keystroke "${dir}"
    delay 0.4
    key code 36
    delay 1.2
  end tell
end tell

-- Clicking the save button is the LAST UI action: once the render starts, Logic
-- stops answering Accessibility queries, so any further scripting here would
-- block until the bounce finishes and blow the osascript timeout. autoBounceProject
-- renders into a freshly-cleared folder, so no "replace existing file?" prompt
-- appears; the render is awaited by polling the filesystem, not the UI.
if not (my clickButton("${processName}", saveButton)) then error "Save dialog did not appear"
`;
}

export function isBounceAudioFile(name: string): boolean {
  const ext = path.extname(name).slice(1).toLowerCase();
  return BOUNCE_AUDIO_EXTENSIONS.includes(ext);
}

export type DirEntry = { name: string; size: number; mtimeMs: number };

/** The newest audio file among `entries`, or null when there is none. Pure so
 * the selection rule can be tested without a filesystem. */
export function newestBounceFile(entries: DirEntry[]): DirEntry | null {
  let best: DirEntry | null = null;
  for (const entry of entries) {
    if (!isBounceAudioFile(entry.name)) continue;
    if (!best || entry.mtimeMs > best.mtimeMs) best = entry;
  }
  return best;
}

/** A cooperative cancel flag, flipped by the progress window's Cancel button. */
export type CancelToken = { cancelled: boolean };

export type AutoBounceOutcome =
  | { ok: true; path: string }
  | { ok: false; error: string; cancelled?: boolean };

export type AutoBounceDeps = {
  platform?: NodeJS.Platform;
  /** Validate the selection and return the real .logicx bundle path, or null. */
  resolveBundle?: (logicxPath: string) => string | null;
  /** Create (and clear) the deterministic output dir, returning its path. */
  makeOutDir?: (logicxPath: string) => string;
  openProject?: (logicxPath: string) => LogicProVariant | null;
  getVariant?: () => LogicProVariant | null;
  waitForDocument?: (variant: LogicProVariant, logicxPath: string) => Promise<AppleScriptResult> | AppleScriptResult;
  runBounce?: (variant: LogicProVariant, outDir: string) => AppleScriptResult;
  waitForOutput?: (outDir: string) => Promise<string | null> | (string | null);
  /** Progress messages for the UI, emitted at each phase. */
  onStatus?: (message: string) => void;
  /** Checked between phases and while waiting for output; flips to abort. */
  cancelToken?: CancelToken;
};

const CANCELLED: AutoBounceOutcome = { ok: false, error: 'Bounce cancelled.', cancelled: true };

export async function autoBounceProject(logicxPath: string, deps: AutoBounceDeps = {}): Promise<AutoBounceOutcome> {
  const status = (message: string) => { try { deps.onStatus?.(message); } catch { /* non-fatal */ } };
  const cancelled = () => deps.cancelToken?.cancelled === true;

  const platform = deps.platform ?? process.platform;
  if (platform !== 'darwin') {
    return { ok: false, error: 'Automatic bounce is only available on macOS.' };
  }

  const bundle = (deps.resolveBundle ?? defaultResolveBundle)(logicxPath);
  if (!bundle) {
    return { ok: false, error: 'That project is not a readable .logicx bundle.' };
  }
  if (cancelled()) return CANCELLED;

  const outDir = (deps.makeOutDir ?? defaultMakeOutDir)(bundle);

  status('Opening the project in Logic Pro…');
  const openedVariant = (deps.openProject ?? ((p) => openLogicProject(p)))(bundle);
  if (!openedVariant) {
    return { ok: false, error: 'Could not open the project in Logic Pro. Is Logic Pro installed?' };
  }

  const documentReady = await (deps.waitForDocument ?? defaultWaitForDocument)(openedVariant, bundle);
  if (!documentReady.ok) {
    return { ok: false, error: documentReady.error };
  }
  if (cancelled()) return CANCELLED;

  // open -a may have launched a variant other than the one it reported; prefer
  // whatever is actually running now for the System Events scripting.
  const variant = (deps.getVariant ?? getRunningLogicVariant)() ?? openedVariant;

  status('Starting the bounce in Logic Pro…');
  const bounced = (deps.runBounce ?? defaultRunBounce)(variant, outDir);
  if (!bounced.ok) {
    return { ok: false, error: bounced.error };
  }
  if (cancelled()) return CANCELLED;

  status('Logic Pro is rendering the bounce…');
  const outPath = await (deps.waitForOutput ?? ((dir: string) => defaultWaitForOutput(dir, deps.cancelToken)))(outDir);
  if (cancelled()) return CANCELLED;
  if (!outPath) {
    return {
      ok: false,
      error: 'The bounce did not produce an audio file in time. Check that a PCM or MP3 output is enabled in Logic’s Bounce settings.',
    };
  }

  return { ok: true, path: outPath };
}

function defaultResolveBundle(logicxPath: string): string | null {
  try {
    return resolveLogicPaths(logicxPath).projectPath ?? null;
  } catch {
    return null;
  }
}

function defaultMakeOutDir(logicxPath: string): string {
  // Required lazily so importing this module never touches electron/fs (keeps
  // the pure helpers importable under the test bundler).
  const { app } = require('electron');
  const crypto = require('node:crypto');
  const fs = require('node:fs');
  const key = crypto.createHash('sha1').update(logicxPath).digest('hex').slice(0, 16);
  const dir = path.join(app.getPath('temp'), 'lv-bounce', key);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function defaultWaitForDocument(variant: LogicProVariant, logicxPath: string): Promise<AppleScriptResult> {
  const deadline = Date.now() + DOCUMENT_OPEN_TIMEOUT_MS;
  let last: AppleScriptResult = { ok: false, error: 'Logic Pro did not open the project in time.' };
  while (Date.now() < deadline) {
    last = runAppleScript(buildDocumentOpenScript(variant, logicxPath), DOCUMENT_CHECK_TIMEOUT_MS);
    if (last.ok) return last;
    await delay(POLL_INTERVAL_MS);
  }
  return last.ok ? last : { ok: false, error: 'Logic Pro did not open the project in time.' };
}

function defaultRunBounce(variant: LogicProVariant, outDir: string): AppleScriptResult {
  return runAppleScript(buildBounceScript(variant, outDir), BOUNCE_SCRIPT_TIMEOUT_MS);
}

async function defaultWaitForOutput(outDir: string, cancelToken?: CancelToken): Promise<string | null> {
  const fs = require('node:fs') as typeof import('node:fs');
  const deadline = Date.now() + OUTPUT_TIMEOUT_MS;
  const lastSize = new Map<string, number>();
  while (Date.now() < deadline) {
    if (cancelToken?.cancelled) return null;
    let entries: DirEntry[] = [];
    try {
      entries = fs.readdirSync(outDir).map((name) => {
        const stat = fs.statSync(path.join(outDir, name));
        return { name, size: stat.size, mtimeMs: stat.mtimeMs };
      });
    } catch {
      entries = [];
    }
    const candidate = newestBounceFile(entries);
    if (candidate) {
      // Offline bounce writes progressively; only accept a file whose size has
      // settled between two polls (and is non-empty).
      if (candidate.size > 0 && lastSize.get(candidate.name) === candidate.size) {
        return path.join(outDir, candidate.name);
      }
      lastSize.set(candidate.name, candidate.size);
    }
    await delay(OUTPUT_POLL_INTERVAL_MS);
  }
  return null;
}
