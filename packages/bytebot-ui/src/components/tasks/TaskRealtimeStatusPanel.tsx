import React from "react";
import {
  Task,
  TaskSecurityExecutionState,
  TaskSecurityMediaState,
  TaskSecuritySessionState,
} from "@/types";

interface TaskRealtimeStatusPanelProps {
  task: Task | null;
}

function formatTimestamp(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(ms?: number): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function buildSessionLine(session?: TaskSecuritySessionState): string | null {
  if (!session?.phase) return null;

  const phaseText = session.phase.replace(/_/g, " ");
  if (session.lastTerminalSummary) {
    return `${phaseText}: ${session.lastTerminalSummary}`;
  }

  return phaseText;
}

function buildExecutionLine(execution?: TaskSecurityExecutionState): string | null {
  if (execution?.activeExecution?.description) {
    return execution.activeExecution.description;
  }

  if (execution?.currentStep) {
    return execution.currentStep;
  }

  if (execution?.blockedStep?.reason) {
    return execution.blockedStep.reason;
  }

  if (execution?.stepPlan?.summary) {
    const currentIndex = execution.stepPlan.currentIndex || 0;
    const totalSteps = execution.stepPlan.totalSteps || 0;
    const prefix =
      currentIndex > 0 && totalSteps > 0
        ? `Step ${currentIndex}/${totalSteps}: `
        : "";
    return `${prefix}${execution.stepPlan.summary}`;
  }

  return null;
}

function buildMediaSummary(media?: TaskSecurityMediaState): string | null {
  if (!media) return null;

  const parts: string[] = [];
  if (media.platform) {
    parts.push(media.platform);
  }
  if (media.phase) {
    parts.push(media.phase.replace(/_/g, " "));
  }
  if (media.observedPlayerState) {
    parts.push(`player ${media.observedPlayerState}`);
  }
  if (media.playbackVerifiedAt) {
    parts.push("playback verified");
  } else if (media.playbackPrimedAt) {
    parts.push("playback primed");
  }
  if (media.recordingStartedAt && !media.recordingStoppedAt) {
    parts.push("recording live");
  } else if (media.recordingStoppedAt) {
    parts.push("recording captured");
  }
  if (media.transcriptionStatus) {
    parts.push(`transcript ${media.transcriptionStatus}`);
  }

  return parts.length > 0 ? parts.join(" • ") : null;
}

function buildMediaDetail(media?: TaskSecurityMediaState): string | null {
  if (!media) return null;

  const title = media.observedTitle?.trim();
  const progress =
    formatDuration(media.observedPositionMs) && formatDuration(media.observedDurationMs)
      ? `${formatDuration(media.observedPositionMs)} / ${formatDuration(media.observedDurationMs)}`
      : formatDuration(media.observedDurationMs);

  if (title && progress) {
    return `${title} (${progress})`;
  }
  if (title) {
    return title;
  }
  if (progress) {
    return progress;
  }

  return media.lastSummary || null;
}

function StatusRow({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string | null | undefined;
  tone?: "default" | "warn" | "danger" | "success";
}) {
  if (!value) return null;

  const toneClass =
    tone === "danger"
      ? "border-red-200 bg-red-50 text-red-700"
      : tone === "warn"
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : tone === "success"
          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
          : "border-bytebot-bronze-light-6 bg-bytebot-bronze-light-1/80 text-bytebot-bronze-light-12";

  return (
    <div className={`rounded-xl border px-3 py-2 ${toneClass}`}>
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] opacity-70">
        {label}
      </div>
      <div className="mt-1 whitespace-pre-line text-sm leading-5">{value}</div>
    </div>
  );
}

export function TaskRealtimeStatusPanel({
  task,
}: TaskRealtimeStatusPanelProps) {
  const security = task?.result?.security;
  const execution = security?.execution;
  const media = security?.media;
  const session = security?.session;

  const sessionLine = buildSessionLine(session);
  const executionLine = buildExecutionLine(execution);
  const mediaLine = buildMediaSummary(media);
  const mediaDetail = buildMediaDetail(media);
  const watchdogLine = execution?.watchdog?.lastVisibleSummary || execution?.blockedStep?.reason;
  const recordingLine = media?.recordingStartedAt
    ? [
        `started ${formatTimestamp(media.recordingStartedAt)}`,
        media.recordingStoppedAt
          ? `stopped ${formatTimestamp(media.recordingStoppedAt)}`
          : "still recording",
      ]
        .filter(Boolean)
        .join(" • ")
    : media?.transcriptionError
      ? `not recording • ${media.transcriptionError}`
      : null;
  const transcriptLine = media?.transcriptionStatus
    ? [
        media.transcriptionStatus,
        media.conciseSummary ? "summary ready" : null,
        media.transcriptionError || null,
      ]
        .filter(Boolean)
        .join(" • ")
    : null;

  if (
    !sessionLine &&
    !executionLine &&
    !mediaLine &&
    !watchdogLine &&
    !recordingLine &&
    !transcriptLine
  ) {
    return null;
  }

  return (
    <div className="mb-3 rounded-2xl border border-bytebot-bronze-light-6 bg-white/95 px-3 py-3 shadow-[0_12px_28px_rgba(32,20,49,0.06)]">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="text-sm font-semibold text-bytebot-bronze-light-12">
          Live Task State
        </div>
        {media?.audioMonitoring?.lastAudibleAt && (
          <div className="text-[11px] text-bytebot-bronze-light-10">
            Last audible {formatTimestamp(media.audioMonitoring.lastAudibleAt)}
          </div>
        )}
      </div>

      <div className="grid gap-2">
        <StatusRow label="Session" value={sessionLine} />
        <StatusRow label="Step" value={executionLine} />
        <StatusRow
          label="Watchdog"
          value={watchdogLine}
          tone={execution?.blockedStep ? "warn" : "default"}
        />
        <StatusRow
          label="Media"
          value={[mediaLine, mediaDetail].filter(Boolean).join("\n")}
          tone={
            media?.phase === "recording" || media?.transcriptionStatus === "ready"
              ? "success"
              : media?.transcriptionStatus === "failed"
                ? "danger"
                : "default"
          }
        />
        <StatusRow
          label="Recording"
          value={recordingLine}
          tone={
            media?.recordingStartedAt && !media?.recordingStoppedAt
              ? "success"
              : media?.transcriptionError
                ? "danger"
                : "default"
          }
        />
        <StatusRow
          label="Transcript"
          value={transcriptLine}
          tone={
            media?.transcriptionStatus === "ready"
              ? "success"
              : media?.transcriptionStatus === "failed"
                ? "danger"
                : media?.transcriptionStatus === "transcribing" ||
                    media?.transcriptionStatus === "recording"
                  ? "warn"
                  : "default"
          }
        />
      </div>
    </div>
  );
}
