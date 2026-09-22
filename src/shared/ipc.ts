// The IPC contract, imported by BOTH the preload and the renderer so the two
// can never drift. Nothing here may import node: or electron.
import type { ProjectModel } from './model';

export type Failure = { error: string };
export type Result<T> = T | Failure;

export function isFailure<T>(value: Result<T>): value is Failure {
  return typeof value === 'object' && value !== null && 'error' in value;
}

export type BounceFile = {
  path: string;
  name: string;
  bytes: ArrayBuffer;
};

export type AudioFileBytes = {
  path: string;
  bytes: ArrayBuffer;
};

/**
 * A recent project's thumbnail, read from the WindowImage.jpg inside the bundle.
 * `exists` is whether the project can still be opened at all (bundle + ProjectData
 * present); `dataUrl` is a downscaled JPEG, or null when there is no window image.
 */
export type RecentPreview = {
  exists: boolean;
  dataUrl: string | null;
  /** Whether a bounce has been saved for this project. */
  hasBounce: boolean;
};

export type LvApi = {
  project: {
    pick(): Promise<string | null>;
    load(selectionPath: string): Promise<Result<ProjectModel>>;
    /** A downscaled preview + availability for a recent project path. */
    preview(projectPath: string): Promise<Result<RecentPreview>>;
  };
  bounce: {
    pick(): Promise<string | null>;
    read(filePath: string): Promise<Result<BounceFile>>;
    /** Copies the picked bounce into app storage, keyed to the project. */
    save(projectPath: string, sourcePath: string): Promise<Result<{ name: string }>>;
    /** The bounce saved for a project, or null when there is none. */
    saved(projectPath: string): Promise<Result<BounceFile | null>>;
    /** Forgets and deletes a project's saved bounce. */
    clear(projectPath: string): Promise<Result<{ cleared: boolean }>>;
    /**
     * Opens the project in Logic Pro and drives a full bounce via AppleScript,
     * then stores and returns the rendered mixdown. macOS only; needs
     * Accessibility + Automation permission.
     */
    auto(projectPath: string): Promise<Result<BounceFile>>;
  };
  audio: {
    /** Reads a media file from the open project. Path must be inside the bundle. */
    read(filePath: string): Promise<Result<AudioFileBytes>>;
  };
};

export const CHANNELS = {
  projectPick: 'project:pick',
  projectLoad: 'project:load',
  projectPreview: 'project:preview',
  bouncePick: 'bounce:pick',
  bounceRead: 'bounce:read',
  bounceSave: 'bounce:save',
  bounceSaved: 'bounce:saved',
  bounceClear: 'bounce:clear',
  bounceAuto: 'bounce:auto',
  audioRead: 'audio:read',
} as const;
