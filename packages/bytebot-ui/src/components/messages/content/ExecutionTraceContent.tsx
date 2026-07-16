import React from "react";
import { ExecutionTracePayload } from "@bytebot/shared";

interface ExecutionTraceContentProps {
  trace: ExecutionTracePayload;
}

function statusClasses(status: ExecutionTracePayload["status"]) {
  switch (status) {
    case "completed":
      return "bg-emerald-50 text-emerald-800 border-emerald-200";
    case "drifted":
      return "bg-amber-50 text-amber-900 border-amber-200";
    case "failed":
      return "bg-red-50 text-red-800 border-red-200";
    default:
      return "bg-sky-50 text-sky-800 border-sky-200";
  }
}

export function ExecutionTraceContent({
  trace,
}: ExecutionTraceContentProps) {
  const latestCheckpoint = trace.checkpoints[trace.checkpoints.length - 1];

  return (
    <div className="mb-3 rounded-xl border border-bytebot-bronze-light-7 bg-bytebot-bronze-light-2 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-bytebot-bronze-dark-9 text-sm font-semibold">
          {trace.description}
        </span>
        <span
          className={`rounded-full border px-2 py-0.5 text-xs font-medium ${statusClasses(trace.status)}`}
        >
          {trace.mode} {" - "} {trace.status.replace("_", " ")}
        </span>
      </div>

      <p className="text-bytebot-bronze-dark-8 mb-2 text-sm leading-relaxed">
        {trace.summary}
      </p>

      {(trace.currentUrl || latestCheckpoint?.currentUrl) && (
        <p className="text-bytebot-bronze-dark-7 mb-2 text-xs break-all">
          URL: {trace.currentUrl || latestCheckpoint?.currentUrl}
        </p>
      )}

      {latestCheckpoint?.extractedFacts &&
        Object.keys(latestCheckpoint.extractedFacts).length > 0 && (
          <div className="mb-2 rounded-lg bg-white/70 p-2">
            <p className="text-bytebot-bronze-dark-9 mb-1 text-xs font-semibold uppercase tracking-wide">
              Visible facts
            </p>
            <div className="space-y-1">
              {Object.entries(latestCheckpoint.extractedFacts).map(([key, value]) => (
                <div
                  key={key}
                  className="text-bytebot-bronze-dark-8 flex justify-between gap-3 text-xs"
                >
                  <span className="font-medium capitalize">
                    {key.replace(/_/g, " ")}
                  </span>
                  <span className="text-right">{value}</span>
                </div>
              ))}
            </div>
          </div>
        )}

      {latestCheckpoint?.driftReason && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
          Drift detected: {latestCheckpoint.driftReason}
        </div>
      )}
    </div>
  );
}
