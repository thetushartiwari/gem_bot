"use client";

import React from "react";
import { TaskUsageInfo } from "@/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";

interface TaskUsagePanelProps {
  usage?: TaskUsageInfo;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}

function formatNumber(value?: number | null): string {
  return new Intl.NumberFormat("en-US").format(value || 0);
}

function formatDate(value?: string): string {
  if (!value) {
    return "Not yet";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

export function TaskUsagePanel({
  usage,
  enabled,
  onEnabledChange,
}: TaskUsagePanelProps) {
  const models = Object.values(usage?.byModel || {}).sort(
    (a, b) => b.totalTokens - a.totalTokens,
  );

  return (
    <Card className="mb-3 border-bytebot-bronze-light-7/60 bg-white/85 shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <div>
          <CardTitle className="text-sm font-semibold text-zinc-800">
            Model Usage
          </CardTitle>
          <p className="mt-1 text-xs text-zinc-500">
            Turn this on only when you want to inspect task token usage.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-zinc-500">
            {enabled ? "Visible" : "Hidden"}
          </span>
          <Switch checked={enabled} onCheckedChange={onEnabledChange} />
        </div>
      </CardHeader>
      {enabled && (
        <CardContent className="space-y-4 pt-0">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
              <div className="text-[11px] uppercase tracking-wide text-zinc-500">
                Calls
              </div>
              <div className="mt-1 text-lg font-semibold text-zinc-900">
                {formatNumber(usage?.totals.calls)}
              </div>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
              <div className="text-[11px] uppercase tracking-wide text-zinc-500">
                Input Tokens
              </div>
              <div className="mt-1 text-lg font-semibold text-zinc-900">
                {formatNumber(usage?.totals.inputTokens)}
              </div>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
              <div className="text-[11px] uppercase tracking-wide text-zinc-500">
                Output Tokens
              </div>
              <div className="mt-1 text-lg font-semibold text-zinc-900">
                {formatNumber(usage?.totals.outputTokens)}
              </div>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
              <div className="text-[11px] uppercase tracking-wide text-zinc-500">
                Total Tokens
              </div>
              <div className="mt-1 text-lg font-semibold text-zinc-900">
                {formatNumber(usage?.totals.totalTokens)}
              </div>
            </div>
          </div>

          {usage?.lastCall && (
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-600">
              <span className="font-medium text-zinc-800">Last call:</span>{" "}
              {usage.lastCall.model} via {usage.lastCall.provider}
              {usage.lastCall.purpose ? ` (${usage.lastCall.purpose})` : ""} at{" "}
              {formatDate(usage.lastCall.calledAt)}
            </div>
          )}

          {models.length > 0 ? (
            <div className="space-y-2">
              {models.map((entry) => (
                <div
                  key={`${entry.provider}:${entry.model}`}
                  className="rounded-lg border border-zinc-200 bg-white p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium text-zinc-900">
                        {entry.model}
                      </div>
                      <div className="text-xs text-zinc-500">
                        {entry.provider}
                        {entry.purpose ? ` • last purpose: ${entry.purpose}` : ""}
                      </div>
                    </div>
                    <div className="text-right text-xs text-zinc-500">
                      <div>{formatNumber(entry.calls)} call(s)</div>
                      <div>{formatDate(entry.lastCalledAt)}</div>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                    <div className="rounded-md bg-zinc-50 px-2 py-1.5 text-zinc-700">
                      In: {formatNumber(entry.inputTokens)}
                    </div>
                    <div className="rounded-md bg-zinc-50 px-2 py-1.5 text-zinc-700">
                      Out: {formatNumber(entry.outputTokens)}
                    </div>
                    <div className="rounded-md bg-zinc-50 px-2 py-1.5 text-zinc-700">
                      Total: {formatNumber(entry.totalTokens)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-500">
              No model usage has been recorded for this task yet.
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
