export type ExecutionMode = "fast" | "guarded" | "strict";

export type ExecutionCheckpointStatus =
  | "in_progress"
  | "completed"
  | "drifted"
  | "failed";

export type ExecutionCheckpoint = {
  checkpointIndex: number;
  status: ExecutionCheckpointStatus;
  currentUrl?: string;
  visibleSummary: string;
  extractedFacts?: Record<string, string>;
  pageType?:
    | "desktop"
    | "blank"
    | "browser_home"
    | "search_results"
    | "detail_page"
    | "form"
    | "login"
    | "interstitial"
    | "consent"
    | "cart"
    | "player"
    | "meeting"
    | "unknown";
  blockerType?:
    | "none"
    | "captcha"
    | "login_required"
    | "consent"
    | "interstitial"
    | "modal"
    | "network"
    | "permission"
    | "unknown";
  targetVisible?: boolean;
  nextActionNeeded?: boolean;
  driftReason?: string;
  actionName?: string;
  actionOutput?: string;
};

export type ExecutionTracePayload = {
  type: "allyra_execution_trace";
  version: 1;
  mode: ExecutionMode;
  description: string;
  taskGoal: string;
  status: ExecutionCheckpointStatus;
  summary: string;
  currentUrl?: string;
  expectedState?: Record<string, string>;
  completionCondition?: string;
  driftCondition?: string;
  checkpoints: ExecutionCheckpoint[];
};

export const EXECUTION_TRACE_PREFIX = "[ALLYRA_EXECUTION_TRACE]";

export function buildExecutionTraceText(
  payload: ExecutionTracePayload,
): string {
  return `${EXECUTION_TRACE_PREFIX}\n${JSON.stringify(payload)}`;
}

export function parseExecutionTraceText(
  text: string,
): ExecutionTracePayload | null {
  if (!text || !text.startsWith(EXECUTION_TRACE_PREFIX)) {
    return null;
  }

  const json = text.slice(EXECUTION_TRACE_PREFIX.length).trim();
  if (!json) {
    return null;
  }

  try {
    const parsed = JSON.parse(json) as Partial<ExecutionTracePayload>;
    if (
      parsed.type !== "allyra_execution_trace" ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.checkpoints) ||
      typeof parsed.description !== "string" ||
      typeof parsed.taskGoal !== "string" ||
      typeof parsed.summary !== "string"
    ) {
      return null;
    }

    return parsed as ExecutionTracePayload;
  } catch {
    return null;
  }
}
