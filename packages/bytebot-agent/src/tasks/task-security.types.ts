export type SecureCredentialMode = 'use_once' | 'save_for_later';
export type BrowserKind = 'brave' | 'firefox';
export type BrowserSessionRestoreReason =
  | 'explicit'
  | 'inferred_auth'
  | 'inferred_open_session';

export type SecureCredentialInput = {
  site: string;
  username?: string;
  password?: string;
  otp?: string;
  mode: SecureCredentialMode;
  sessionLabel?: string;
};

export type SavedBrowserSessionInput = {
  label: string;
  site?: string;
  browser?: BrowserKind;
};

export type BrowserSessionMetadata = {
  label: string;
  site?: string;
  browser?: BrowserKind;
  createdAt: string;
  updatedAt: string;
  hasCredential?: boolean;
};

export type TaskUsageBreakdown = {
  provider: string;
  model: string;
  purpose?: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  lastCalledAt: string;
};

export type TaskUsageState = {
  totals: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  byModel: Record<string, TaskUsageBreakdown>;
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
};

export type MediaRoute =
  | 'supported_video'
  | 'supported_audio'
  | 'supported_meeting'
  | 'unsupported_media';

export type MediaPlatform =
  | 'youtube'
  | 'spotify'
  | 'soundcloud'
  | 'apple_music'
  | 'google_meet'
  | 'zoom'
  | 'teams';

export type ExecutionWatchdogReason =
  | 'drifted'
  | 'stuck'
  | 'looping'
  | 'field_mismatch'
  | 'wrong_surface'
  | 'media_mismatch'
  | 'human_challenge';

export type SessionActiveBranch =
  | 'preflight_wait'
  | 'executing'
  | 'blocked_recovery'
  | 'awaiting_confirmation'
  | 'parked_result'
  | 'needs_help'
  | 'closed';

export type TaskSecurityState = {
  session?: {
    keepAliveUntilUserDone?: boolean;
    phase?:
      | 'active'
      | 'waiting_user'
      | 'needs_attention'
      | 'paused'
      | 'closed';
    activeBranch?: SessionActiveBranch;
    mode?: 'normal' | 'media' | 'meeting';
    awaitingUserDecision?: boolean;
    lastTerminalStatus?: 'completed' | 'failed' | 'needs_help';
    lastTerminalSummary?: string;
    parkedAt?: string;
    closedAt?: string;
    lastUserInstructionAt?: string;
    currentTurnGoal?: string;
  };
  preflight?: {
    turnId?: string;
    turnKind?: 'initial' | 'follow_up';
    questionAsked?: boolean;
    questionAnswered?: boolean;
    executionStarted?: boolean;
    awaitingUserResponse?: boolean;
    followUpPending?: boolean;
    question?: string;
    plan?: string;
    planSteps?: string[];
    guidelines?: string[];
    reason?: 'confirmation' | 'clarification';
    askedAt?: string;
    confirmedAt?: string;
  };
  media?: {
    kind?: 'audio' | 'video' | 'meeting';
    route?: MediaRoute;
    platform?: MediaPlatform;
    shortForm?: boolean;
    keepRunningUntilDone?: boolean;
    continueWithRelatedMedia?: boolean;
    transcriptRequested?: boolean;
    summaryRequested?: boolean;
    selectedModeLabel?: string;
    askedAt?: string;
    selectedAt?: string;
    phase?:
      | 'opening'
      | 'ad_handling'
      | 'playback_verification'
      | 'transcript_capture'
      | 'recording'
      | 'monitoring'
      | 'quiet_monitoring'
      | 'network_recovery'
      | 'follow_on_detected'
      | 'transcribing'
      | 'summarizing'
      | 'ended';
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
    recordingFormat?: 'wav' | 'flac';
    transcriptionStatus?:
      | 'idle'
      | 'recording'
      | 'transcribing'
      | 'ready'
      | 'unavailable'
      | 'failed';
    transcriptText?: string;
    conciseSummary?: string;
    detailedSummary?: string;
    transcriptionError?: string;
    audioMonitoring?: {
      mode?: 'audio_first';
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
        | 'prolonged_silence'
        | 'meeting_extended_silence_check'
        | 'playback_identity_check'
        | 'audio_signature_changed'
        | 'signal_returned_after_silence'
        | 'periodic_progress_check'
        | 'expected_end_check';
      lastClassification?:
        | 'requested_media_active'
        | 'requested_media_paused'
        | 'requested_media_mismatch'
        | 'ad_visible'
        | 'follow_on_media'
        | 'requested_media_ended'
        | 'meeting_active'
        | 'meeting_quiet'
        | 'meeting_waiting'
        | 'meeting_ended'
        | 'network_issue'
        | 'unknown';
      lastClassificationAt?: string;
      visualChecksTriggered?: number;
      noProgressVisualChecks?: number;
      lastAutoRecoveryAt?: string;
      lastProviderFailureAt?: string;
      providerFailureCount?: number;
    };
  };
  browserSession?: {
    restoreLabel?: string;
    saveLabel?: string;
    site?: string;
    browser?: BrowserKind;
    restoreReason?: BrowserSessionRestoreReason;
    restoredAt?: string;
    savedAt?: string;
  };
  secureCredentialMode?: SecureCredentialMode;
  pendingConfirmation?: {
    actionName: string;
    actionArgs: Record<string, unknown>;
    stepDescription: string;
    prompt: string;
    requestedAt: string;
  };
  postConfirmationReview?: {
    actionName: string;
    enabledAt: string;
  };
  execution?: {
    activeExecution?: {
      description: string;
      executionMode?: 'fast' | 'guarded' | 'strict';
      expectedState?: Record<string, unknown>;
      completionCondition?: string;
      driftCondition?: string;
      source?: 'initial' | 'replan';
      createdAt?: string;
      startedAt?: string;
      completedAt?: string;
      blockedAt?: string;
      blockReason?: string;
    };
    pendingSteps?: Array<{
      description: string;
      executionMode?: 'fast' | 'guarded' | 'strict';
      expectedState?: Record<string, unknown>;
      completionCondition?: string;
      driftCondition?: string;
    }>;
    stepPlan?: {
      summary?: string;
      guidelines?: string[];
      source?: 'initial' | 'replan';
      createdAt?: string;
      startedAt?: string;
      completedAt?: string;
      currentIndex?: number;
      totalSteps?: number;
    };
    mediaQueue?: Array<{
      description: string;
      executionMode?: 'fast' | 'guarded' | 'strict';
      expectedState?: Record<string, unknown>;
      completionCondition?: string;
      driftCondition?: string;
    }>;
    mediaPlan?: {
      summary?: string;
      source?: 'initial' | 'replan';
      createdAt?: string;
      startedAt?: string;
      completedAt?: string;
      blockedAt?: string;
      blockReason?: string;
      currentIndex?: number;
      totalSteps?: number;
    };
    driftCount?: number;
    stepRetries?: Record<string, number>;
    lastDriftAt?: string;
    lastDriftReason?: string;
    currentStep?: string;
    completedSteps?: string[];
    skippedSteps?: string[];
    blockedStep?: {
      description: string;
      reason: string;
      retries: number;
      lastSeenAt: string;
      recoveryStrategy?: 'planner_reentry' | 'media_reentry';
      currentUrl?: string;
      lastVisibleSummary?: string;
      watchdogReason?: ExecutionWatchdogReason;
    };
    recoveryHistory?: Array<{
      description: string;
      outcome:
        | 'resolved'
        | 'stuck'
        | 'looping'
        | 'drifted'
        | 'wrong_surface'
        | 'media_mismatch'
        | 'human_challenge';
      recordedAt: string;
    }>;
    watchdog?: {
      lastObservedAt?: string;
      lastObservedStatus?: 'healthy' | 'recovering';
      lastTriggerAt?: string;
      lastTriggerReason?: ExecutionWatchdogReason;
      activeRecovery?: boolean;
      currentUrl?: string;
      lastVisibleSummary?: string;
    };
    relevantContextUsed?: boolean;
    lastOpenedApplication?: string;
    lastApplicationOpenedAt?: string;
    resultReview?: {
      pending?: boolean;
      requestedAt?: string;
      completedAt?: string;
      lastDescription?: string;
      lastSummary?: string;
      followUpCount?: number;
    };
    syntheticContinuationCount?: number;
    lastSyntheticContinuationAt?: string;
    lastSyntheticContinuationText?: string;
    suppressedContinuationPromptCount?: number;
    lastSuppressedContinuationPrompt?: string;
    lastSuppressedContinuationAt?: string;
    suppressedExecutionNarrationCount?: number;
    lastSuppressedExecutionNarration?: string;
    lastSuppressedExecutionNarrationAt?: string;
    lastLoopSignature?: string;
    repeatedLoopSignatureCount?: number;
  };
};

