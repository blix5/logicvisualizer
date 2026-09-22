// AppleScript / Logic-Pro control primitives. This module deliberately lives
// OUTSIDE src/main/logic/, which is the read-only vendored parser and is
// forbidden from shelling out to osascript (see src/main/logic/VENDORED.md).
// The helpers here are adapted from Texture's logicRevert.ts / logicVariants.ts
// / window.ts, copied rather than linked (the two apps share no runtime code).
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export type LogicProVariant = {
  /** The application name passed to `open -a` and `tell application`. */
  appName: string;
  /** The process name as it appears to `pgrep -xi` / System Events. */
  processName: string;
};

// Newest / most-specific first, matching Texture's DAW_MAC_APP_NAMES.logic_pro.
export const LOGIC_PRO_VARIANTS: readonly LogicProVariant[] = [
  { appName: 'Logic Pro Creator Studio', processName: 'Logic Pro Creator Studio' },
  { appName: 'Logic Pro', processName: 'Logic Pro' },
  { appName: 'Logic Pro X', processName: 'Logic Pro X' },
];

export function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function processOutputToString(value: unknown): string {
  if (!value) return '';
  if (Buffer.isBuffer(value)) return value.toString('utf-8');
  if (Array.isArray(value)) return value.map(processOutputToString).filter(Boolean).join('\n');
  return String(value);
}

function errorField(error: unknown, field: 'stderr' | 'stdout' | 'output'): unknown {
  if (error && typeof error === 'object' && field in error) {
    return (error as Record<string, unknown>)[field];
  }
  return undefined;
}

function firstMeaningfulLine(message: string): string {
  return message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('Command failed:')) || '';
}

/** Maps raw osascript stderr to a message worth showing the user. */
export function formatAppleScriptErrorForUser(error: unknown): string {
  const stderr = processOutputToString(errorField(error, 'stderr'));
  const stdout = processOutputToString(errorField(error, 'stdout'));
  const output = processOutputToString(errorField(error, 'output'));
  const message = error instanceof Error ? error.message : String(error);
  const combined = [stderr, stdout, output, message].filter(Boolean).join('\n');

  if (combined.includes('not allowed assistive access') || combined.includes('-1719')) {
    return 'Accessibility permission is required for Logic Visualizer to control Logic Pro. Grant it in System Settings ▸ Privacy & Security ▸ Accessibility, then try again.';
  }
  if (combined.includes('Not authorized to send Apple events') || combined.includes('-1743')) {
    return 'Automation permission is required to control Logic Pro. Allow it in System Settings ▸ Privacy & Security ▸ Automation, then try again.';
  }
  if (combined.includes('No Logic document is open') || combined.includes('has no open windows')) {
    return 'Logic Pro has no open project.';
  }
  if (combined.includes('Bounce dialog did not appear')) {
    return 'Logic Pro did not open the Bounce dialog. Make sure the project is open and try again.';
  }
  if (combined.includes('Save dialog did not appear')) {
    return "Logic Pro did not open the Bounce save dialog, so the output location couldn't be set.";
  }

  const conciseDetail = firstMeaningfulLine(stderr || stdout || output);
  return conciseDetail ? `Logic automation failed: ${conciseDetail}` : 'Logic automation failed.';
}

export type AppleScriptResult = { ok: true } | { ok: false; error: string };

export function runAppleScript(script: string, timeoutMs: number): AppleScriptResult {
  try {
    execFileSync('osascript', ['-e', script], { encoding: 'utf-8', timeout: timeoutMs });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: formatAppleScriptErrorForUser(error) };
  }
}

/** True when `processName` is running, via `pgrep -xi`. Injectable for tests. */
export function findRunningLogicVariant(
  isRunning: (processName: string) => boolean = defaultIsProcessRunning,
): LogicProVariant | null {
  for (const variant of LOGIC_PRO_VARIANTS) {
    if (isRunning(variant.processName)) return variant;
  }
  return null;
}

function defaultIsProcessRunning(processName: string): boolean {
  try {
    execFileSync('pgrep', ['-xi', processName], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function getRunningLogicVariant(): LogicProVariant | null {
  if (process.platform !== 'darwin') return null;
  return findRunningLogicVariant();
}

/**
 * Ask Logic to abort an in-progress bounce with its own ⌘-. shortcut. Fire and
 * forget: during a render Logic may be slow to answer, so this never blocks the
 * caller and ignores any failure — it is a courtesy on top of the app simply
 * no longer waiting for the output.
 */
export function requestLogicBounceCancel(): void {
  if (process.platform !== 'darwin') return;
  const variant = getRunningLogicVariant();
  if (!variant) return;
  try {
    const { execFile } = require('node:child_process') as typeof import('node:child_process');
    const script = `tell application "System Events" to tell process "${escapeAppleScriptString(
      variant.processName,
    )}" to keystroke "." using {command down}`;
    execFile('osascript', ['-e', script], () => { /* best effort */ });
  } catch {
    /* best effort */
  }
}

export type OpenLogicDeps = {
  exec?: (file: string, args: string[]) => void;
  exists?: (p: string) => boolean;
};

/**
 * Opens a `.logicx` bundle in whichever Logic Pro variant is installed, via
 * `open -a`. Returns the variant that accepted the open, or null on failure.
 */
export function openLogicProject(logicxPath: string, deps: OpenLogicDeps = {}): LogicProVariant | null {
  const exec = deps.exec ?? ((file, args) => { execFileSync(file, args, { stdio: 'ignore' }); });
  const exists = deps.exists ?? ((p) => require('node:fs').existsSync(p));
  const resolved = path.resolve(logicxPath);
  if (!exists(resolved)) return null;
  for (const variant of LOGIC_PRO_VARIANTS) {
    try {
      exec('open', ['-a', variant.appName, resolved]);
      return variant;
    } catch {
      // Try the next variant name.
    }
  }
  return null;
}
