export type Coordinates = { x: number; y: number };
export type Button = "left" | "right" | "middle";
export type Press = "up" | "down";
export type Application =
  | "brave"
  | "firefox"
  | "vscode"
  | "terminal"
  | "desktop"
  | "directory";

// Define individual computer action types
export type MoveMouseAction = {
  action: "move_mouse";
  coordinates: Coordinates;
};

export type TraceMouseAction = {
  action: "trace_mouse";
  path: Coordinates[];
  holdKeys?: string[];
};

export type ClickMouseAction = {
  action: "click_mouse";
  coordinates?: Coordinates;
  button: Button;
  holdKeys?: string[];
  clickCount: number;
};

export type PressMouseAction = {
  action: "press_mouse";
  coordinates?: Coordinates;
  button: Button;
  press: Press;
};

export type DragMouseAction = {
  action: "drag_mouse";
  path: Coordinates[];
  button: Button;
  holdKeys?: string[];
};

export type ScrollAction = {
  action: "scroll";
  coordinates?: Coordinates;
  direction: "up" | "down" | "left" | "right";
  scrollCount: number;
  holdKeys?: string[];
};

export type TypeKeysAction = {
  action: "type_keys";
  keys: string[];
  delay?: number;
};

export type PasteTextAction = {
  action: "paste_text";
  text: string;
  sensitive?: boolean;
  clearAfter?: boolean;
};

export type PressKeysAction = {
  action: "press_keys";
  keys: string[];
  press: Press;
};

export type TypeTextAction = {
  action: "type_text";
  text: string;
  delay?: number;
  sensitive?: boolean;
};

export type WaitAction = {
  action: "wait";
  duration: number;
};

export type ScreenshotAction = {
  action: "screenshot";
};

export type CursorPositionAction = {
  action: "cursor_position";
};

export type ApplicationAction = {
  action: "application";
  application: Application;
};

export type WriteFileAction = {
  action: "write_file";
  path: string;
  data: string; // Base64 encoded data
};

export type ReadFileAction = {
  action: "read_file";
  path: string;
};

export type BrowserSessionExportAction = {
  action: "browser_session_export";
  browser?: "brave" | "firefox";
};

export type BrowserSessionImportAction = {
  action: "browser_session_import";
  archive: string;
  browser?: "brave" | "firefox";
};

export type BrowserSessionClearAction = {
  action: "browser_session_clear";
  browser?: "brave" | "firefox";
};

export type AudioDevicesAction = {
  action: "audio_devices";
};

export type AudioRecordStartAction = {
  action: "audio_record_start";
  source?: string;
  format?: "wav" | "flac";
  purpose?: string;
};

export type AudioRecordStopAction = {
  action: "audio_record_stop";
};

export type AudioRecordStatusAction = {
  action: "audio_record_status";
};

export type AudioChunkExportAction = {
  action: "audio_chunk_export";
  path: string;
  chunkDurationSeconds?: number;
  format?: "wav" | "flac";
  maxChunks?: number;
};

// Define the union type using the individual action types
export type ComputerAction =
  | MoveMouseAction
  | TraceMouseAction
  | ClickMouseAction
  | PressMouseAction
  | DragMouseAction
  | ScrollAction
  | TypeKeysAction
  | PressKeysAction
  | TypeTextAction
  | PasteTextAction
  | WaitAction
  | ScreenshotAction
  | CursorPositionAction
  | ApplicationAction
  | WriteFileAction
  | ReadFileAction
  | BrowserSessionExportAction
  | BrowserSessionImportAction
  | BrowserSessionClearAction
  | AudioDevicesAction
  | AudioRecordStartAction
  | AudioRecordStopAction
  | AudioRecordStatusAction
  | AudioChunkExportAction;
