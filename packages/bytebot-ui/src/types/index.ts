import { MessageContentBlock } from "@bytebot/shared";

export enum Role {
  USER = "USER",
  ASSISTANT = "ASSISTANT",
}

// Message interface
export interface Message {
  id: string;
  content: MessageContentBlock[];
  role: Role;
  taskId?: string;
  createdAt?: string;
  take_over?: boolean;
}

// Grouped messages interface for processed endpoint
export interface GroupedMessages {
  role: Role;
  messages: Message[];
  take_over?: boolean;
}

export interface Model {
  provider: string;
  name: string;
  title: string;
}

// Task related enums and types
export enum TaskStatus {
  PENDING = "PENDING",
  RUNNING = "RUNNING",
  NEEDS_HELP = "NEEDS_HELP",
  NEEDS_REVIEW = "NEEDS_REVIEW",
  COMPLETED = "COMPLETED",
  CANCELLED = "CANCELLED",
  FAILED = "FAILED",
}

export enum TaskPriority {
  LOW = "LOW",
  MEDIUM = "MEDIUM",
  HIGH = "HIGH",
  URGENT = "URGENT",
}

export enum TaskType {
  IMMEDIATE = "IMMEDIATE",
  SCHEDULED = "SCHEDULED",
}

export interface FileWithBase64 {
  name: string;
  base64: string;
  type: string;
  size: number;
}

export interface SecureCredentialInput {
  site: string;
  username?: string;
  password?: string;
  otp?: string;
  mode: "use_once" | "save_for_later";
  sessionLabel?: string;
}

export interface SavedBrowserSession {
  label: string;
  site?: string;
  browser?: "brave" | "firefox";
  createdAt: string;
  updatedAt: string;
  hasCredential?: boolean;
}

export interface SavedBrowserSessionInput {
  label: string;
  site?: string;
  browser?: "brave" | "firefox";
}

export interface TaskUsageByModelEntry {
  provider: string;
  model: string;
  purpose?: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  lastCalledAt: string;
}

export interface TaskUsageInfo {
  totals: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  byModel: Record<string, TaskUsageByModelEntry>;
  lastCall?: {
    provider: string;
    model: string;
    purpose?: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    calledAt: string;
  };
  lastUpdatedAt?: string;
}

export interface TaskSecuritySessionState {
  keepAliveUntilUserDone?: boolean;
  phase?: "active" | "waiting_user" | "needs_attention" | "paused" | "closed";
  mode?: "normal" | "media" | "meeting";
  awaitingUserDecision?: boolean;
  lastTerminalStatus?: "completed" | "failed" | "needs_help";
  lastTerminalSummary?: string;
  parkedAt?: string;
  closedAt?: string;
  lastUserInstructionAt?: string;
  currentTurnGoal?: string;
}

export interface TaskSecurityMediaAudioMonitoringState {
  mode?: "audio_first";
  lastPolledAt?: string;
  lastAudibleAt?: string;
  lastVisualCheckAt?: string;
  silenceStartedAt?: string;
  lastPeakDb?: number | null;
  lastRmsDb?: number | null;
  lastZeroCrossingRate?: number | null;
  lastSignature?: string | null;
  lastTriggerAt?: string;
  lastTriggerReason?:
    | "prolonged_silence"
    | "meeting_extended_silence_check"
    | "playback_identity_check"
    | "audio_signature_changed"
    | "signal_returned_after_silence"
    | "periodic_progress_check"
    | "expected_end_check";
  lastClassification?:
    | "requested_media_active"
    | "requested_media_paused"
    | "requested_media_mismatch"
    | "ad_visible"
    | "follow_on_media"
    | "requested_media_ended"
    | "meeting_active"
    | "meeting_quiet"
    | "meeting_waiting"
    | "meeting_ended"
    | "network_issue"
    | "unknown";
  lastClassificationAt?: string;
  visualChecksTriggered?: number;
  noProgressVisualChecks?: number;
  lastAutoRecoveryAt?: string;
  lastProviderFailureAt?: string;
  providerFailureCount?: number;
}

export interface TaskSecurityMediaState {
  kind?: "audio" | "video" | "meeting";
  route?: string;
  platform?: string;
  shortForm?: boolean;
  keepRunningUntilDone?: boolean;
  continueWithRelatedMedia?: boolean;
  transcriptRequested?: boolean;
  summaryRequested?: boolean;
  selectedModeLabel?: string;
  askedAt?: string;
  selectedAt?: string;
  phase?:
    | "opening"
    | "ad_handling"
    | "playback_verification"
    | "transcript_capture"
    | "recording"
    | "monitoring"
    | "quiet_monitoring"
    | "network_recovery"
    | "follow_on_detected"
    | "transcribing"
    | "summarizing"
    | "ended";
  playbackPrimedAt?: string;
  playbackVerifiedAt?: string;
  completionLatchedAt?: string;
  endedAt?: string;
  observedAt?: string;
  observedPositionMs?: number;
  observedDurationMs?: number;
  observedTitle?: string;
  observedChannel?: string;
  observedUrl?: string;
  observedPlayerName?: string;
  observedPlayerState?: string;
  maxObservedPositionMs?: number;
  transcriptUnavailableAt?: string;
  transcriptAttemptCount?: number;
  continuationCount?: number;
  lastSummary?: string;
  recordingStartedAt?: string;
  recordingStoppedAt?: string;
  recordingFilePath?: string;
  recordingSource?: string;
  recordingFormat?: "wav" | "flac";
  transcriptionStatus?:
    | "idle"
    | "recording"
    | "transcribing"
    | "ready"
    | "unavailable"
    | "failed";
  transcriptText?: string;
  conciseSummary?: string;
  detailedSummary?: string;
  transcriptionError?: string;
  audioMonitoring?: TaskSecurityMediaAudioMonitoringState;
}

export interface TaskSecurityExecutionBlockedStep {
  description: string;
  reason: string;
  retries: number;
  lastSeenAt: string;
  recoveryStrategy?: "planner_reentry" | "media_reentry";
  currentUrl?: string;
  lastVisibleSummary?: string;
  watchdogReason?:
    | "drifted"
    | "stuck"
    | "looping"
    | "field_mismatch"
    | "wrong_surface"
    | "media_mismatch"
    | "human_challenge";
}

export interface TaskSecurityExecutionState {
  activeExecution?: {
    description: string;
    executionMode?: "fast" | "guarded" | "strict";
    expectedState?: Record<string, unknown>;
    completionCondition?: string;
    driftCondition?: string;
    source?: "initial" | "replan";
    createdAt?: string;
    startedAt?: string;
    completedAt?: string;
    blockedAt?: string;
    blockReason?: string;
  };
  currentStep?: string;
  blockedStep?: TaskSecurityExecutionBlockedStep;
  watchdog?: {
    lastObservedAt?: string;
    lastObservedStatus?: "healthy" | "recovering";
    lastTriggerAt?: string;
    lastTriggerReason?:
      | "drifted"
      | "stuck"
      | "looping"
      | "field_mismatch"
      | "wrong_surface"
      | "media_mismatch"
      | "human_challenge";
    activeRecovery?: boolean;
    currentUrl?: string;
    lastVisibleSummary?: string;
  };
  stepPlan?: {
    summary?: string;
    source?: "initial" | "replan";
    createdAt?: string;
    startedAt?: string;
    completedAt?: string;
    currentIndex?: number;
    totalSteps?: number;
  };
  mediaPlan?: {
    summary?: string;
    source?: "initial" | "replan";
    createdAt?: string;
    startedAt?: string;
    completedAt?: string;
    blockedAt?: string;
    blockReason?: string;
    currentIndex?: number;
    totalSteps?: number;
  };
  resultReview?: {
    pending?: boolean;
    requestedAt?: string;
    completedAt?: string;
    lastDescription?: string;
    lastSummary?: string;
    followUpCount?: number;
  };
}

export interface TaskSecurityState {
  session?: TaskSecuritySessionState;
  media?: TaskSecurityMediaState;
  execution?: TaskSecurityExecutionState;
}

export interface TaskResult {
  usage?: TaskUsageInfo;
  security?: TaskSecurityState;
  [key: string]: unknown;
}

export interface File {
  id: string;
  name: string;
  type: string;
  size: number;
  data: string;
  createdAt: string;
  updatedAt: string;
  taskId: string;
}

export interface Task {
  id: string;
  description: string;
  type: TaskType;
  status: TaskStatus;
  priority: TaskPriority;
  control: Role;
  createdBy: Role;
  createdAt: string;
  updatedAt: string;
  scheduledFor?: string;
  executedAt?: string;
  completedAt?: string;
  queuedAt?: string;
  error?: string;
  result?: TaskResult;
  model: Model;
  files?: File[];
}
