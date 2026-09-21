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

export type LvApi = {
  project: {
    pick(): Promise<string | null>;
    load(selectionPath: string): Promise<Result<ProjectModel>>;
  };
  bounce: {
    pick(): Promise<string | null>;
    read(filePath: string): Promise<Result<BounceFile>>;
  };
  audio: {
    /** Reads a media file from the open project. Path must be inside the bundle. */
    read(filePath: string): Promise<Result<AudioFileBytes>>;
  };
};

export const CHANNELS = {
  projectPick: 'project:pick',
  projectLoad: 'project:load',
  bouncePick: 'bounce:pick',
  bounceRead: 'bounce:read',
  audioRead: 'audio:read',
} as const;
