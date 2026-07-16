import {
  SessionActiveBranch,
  TaskSecurityState,
} from '../tasks/task-security.types';

export function applySessionActiveBranch(
  security: TaskSecurityState,
  branch: SessionActiveBranch,
  sessionPatch: Partial<NonNullable<TaskSecurityState['session']>> = {},
): TaskSecurityState {
  return {
    ...security,
    session: {
      ...(security.session || {}),
      ...sessionPatch,
      activeBranch: branch,
    },
  };
}
