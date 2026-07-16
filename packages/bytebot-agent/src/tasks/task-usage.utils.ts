import { TaskUsageState } from './task-security.types';

type UsageInput = {
  provider: string;
  model: string;
  purpose?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export function mergeTaskUsage(
  current: TaskUsageState | undefined,
  next: UsageInput,
  calledAt = new Date().toISOString(),
): TaskUsageState {
  const byModel = { ...(current?.byModel || {}) };
  const modelKey = `${next.provider}:${next.model}`;
  const existingModel = byModel[modelKey];

  byModel[modelKey] = {
    provider: next.provider,
    model: next.model,
    purpose: next.purpose,
    calls: (existingModel?.calls || 0) + 1,
    inputTokens: (existingModel?.inputTokens || 0) + next.inputTokens,
    outputTokens: (existingModel?.outputTokens || 0) + next.outputTokens,
    totalTokens: (existingModel?.totalTokens || 0) + next.totalTokens,
    lastCalledAt: calledAt,
  };

  return {
    totals: {
      calls: (current?.totals.calls || 0) + 1,
      inputTokens: (current?.totals.inputTokens || 0) + next.inputTokens,
      outputTokens: (current?.totals.outputTokens || 0) + next.outputTokens,
      totalTokens: (current?.totals.totalTokens || 0) + next.totalTokens,
    },
    byModel,
    lastCall: {
      provider: next.provider,
      model: next.model,
      purpose: next.purpose,
      inputTokens: next.inputTokens,
      outputTokens: next.outputTokens,
      totalTokens: next.totalTokens,
      calledAt,
    },
    lastUpdatedAt: calledAt,
  };
}
