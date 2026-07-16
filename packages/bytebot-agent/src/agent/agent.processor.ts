import { TasksService } from '../tasks/tasks.service';
import { MessagesService } from '../messages/messages.service';
import { Injectable, Logger } from '@nestjs/common';
import {
  Message,
  Role,
  Task,
  TaskPriority,
  TaskStatus,
  TaskType,
} from '@prisma/client';
import { AnthropicService } from '../anthropic/anthropic.service';
import {
  buildExecutionTraceText,
  ExecutionCheckpoint,
  ExecutionMode,
  isComputerToolUseContentBlock,
  isSetTaskStatusToolUseBlock,
  isCreateTaskToolUseBlock,
  SetTaskStatusToolUseBlock,
  ToolUseContentBlock,
} from '@bytebot/shared';

import {
  MessageContentBlock,
  MessageContentType,
  ToolResultContentBlock,
  TextContentBlock,
} from '@bytebot/shared';
import { InputCaptureService } from './input-capture.service';
import { OnEvent } from '@nestjs/event-emitter';
import { OpenAIService } from '../openai/openai.service';
import { GoogleService } from '../google/google.service';
import {
  BytebotAgentModel,
  BytebotAgentService,
  BytebotAgentResponse,
} from './agent.types';
import {
  AGENT_SYSTEM_PROMPT,
  AGENT_SYSTEM_PROMPT_PLANNER,
  PREFLIGHT_SYSTEM_PROMPT,
  SUMMARIZATION_SYSTEM_PROMPT,
} from './agent.constants';
import { SummariesService } from '../summaries/summaries.service';
import { handleComputerToolUse } from './agent.computer-use';
import { ProxyService } from '../proxy/proxy.service';
import { ComputerUseExecutorService } from './computer-use-executor.service';
import { BrowserSessionsService } from '../tasks/browser-sessions.service';
import { TaskSecretsService } from '../tasks/task-secrets.service';
import {
  ExecutionWatchdogReason,
  MediaPlatform,
  MediaRoute,
  SessionActiveBranch,
  TaskSecurityState,
  TaskUsageState,
} from '../tasks/task-security.types';
import { MediaSessionService } from '../tasks/media-session.service';
import { mergeTaskUsage } from '../tasks/task-usage.utils';
import { PlannerPlanCompiler } from './planner-plan.compiler';
import { applySessionActiveBranch } from './session-branch.utils';

const BYTEBOT_DESKTOP_BASE_URL = process.env
  .BYTEBOT_DESKTOP_BASE_URL as string;

type DesktopAudioStatus = {
  source: string;
  hasSignal: boolean;
  peakDb: number | null;
  rmsDb?: number | null;
  zeroCrossingRate?: number | null;
  signature?: string | null;
  sampledAt?: string;
  message?: string;
};

type DesktopMediaSessionState = {
  success: boolean;
  sampledAt?: string;
  activeWindowTitle?: string;
  activeWindowClass?: string;
  session?: {
    available?: boolean;
    source?: 'playerctl' | 'window';
    playerName?: string;
    status?: string;
    positionMs?: number;
    lengthMs?: number;
    title?: string;
    artist?: string;
    album?: string;
    url?: string;
    message?: string;
  };
};

type MediaMonitorConfig = {
  intervalMs: number;
  silenceTriggerMs: number;
  minVisualCooldownMs: number;
  signatureTriggerThreshold: number;
  periodicVisualCheckMs?: number;
  expectedDurationMs?: number;
  expectedEndLeadMs?: number;
  monitorWarmupMs?: number;
};

type MediaMonitorTriggerReason =
  | 'prolonged_silence'
  | 'meeting_extended_silence_check'
  | 'playback_identity_check'
  | 'audio_signature_changed'
  | 'signal_returned_after_silence'
  | 'periodic_progress_check'
  | 'expected_end_check';

type MediaReviewState =
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

@Injectable()
export class AgentProcessor {
  private readonly logger = new Logger(AgentProcessor.name);
  private readonly plannerPlanCompiler = new PlannerPlanCompiler();
  private currentTaskId: string | null = null;
  private isProcessing = false;
  private abortController: AbortController | null = null;
  private services: Record<string, BytebotAgentService> = {};

  constructor(
    private readonly tasksService: TasksService,
    private readonly messagesService: MessagesService,
    private readonly summariesService: SummariesService,
    private readonly anthropicService: AnthropicService,
    private readonly openaiService: OpenAIService,
    private readonly googleService: GoogleService,
    private readonly proxyService: ProxyService,
    private readonly inputCaptureService: InputCaptureService,
    private readonly computerUseExecutor: ComputerUseExecutorService,
    private readonly browserSessionsService: BrowserSessionsService,
    private readonly taskSecretsService: TaskSecretsService,
    private readonly mediaSessionService: MediaSessionService,
  ) {
    this.services = {
      anthropic: this.anthropicService,
      openai: this.openaiService,
      google: this.googleService,
      proxy: this.proxyService,
    };
    this.logger.log('AgentProcessor initialized');
  }

  private createPlannerTurnId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /**
   * Check if the processor is currently processing a task
   */
  isRunning(): boolean {
    return this.isProcessing;
  }

  /**
   * Get the current task ID being processed
   */
  getCurrentTaskId(): string | null {
    return this.currentTaskId;
  }

  @OnEvent('task.takeover')
  handleTaskTakeover({ taskId }: { taskId: string }) {
    this.logger.log(`Task takeover event received for task ID: ${taskId}`);

    // If the agent is still processing this task, abort any in-flight operations
    if (this.currentTaskId === taskId && this.isProcessing) {
      this.abortController?.abort();
    }

    // Always start capturing user input so that emitted actions are received
    this.inputCaptureService.start(taskId);
  }

  @OnEvent('task.resume')
  handleTaskResume({ taskId }: { taskId: string }) {
    if (this.currentTaskId === taskId && this.isProcessing) {
      this.logger.log(`Task resume event received for task ID: ${taskId}`);
      this.abortController = new AbortController();

      void this.runIteration(taskId);
      return;
    }

    if (!this.isProcessing) {
      this.logger.log(
        `Task resume event queued fresh processing for task ID: ${taskId}`,
      );
      this.processTask(taskId);
    }
  }

  @OnEvent('task.cancel')
  async handleTaskCancel({ taskId }: { taskId: string }) {
    this.logger.log(`Task cancel event received for task ID: ${taskId}`);

    this.computerUseExecutor.forgetTaskContext(taskId);
    this.taskSecretsService.forget(taskId);

    if (this.currentTaskId !== taskId) {
      return;
    }

    await this.stopProcessing();
  }

  processTask(taskId: string) {
    this.logger.log(`Starting processing for task ID: ${taskId}`);

    if (this.isProcessing) {
      this.logger.warn('AgentProcessor is already processing another task');
      return;
    }

    this.isProcessing = true;
    this.currentTaskId = taskId;
    this.abortController = new AbortController();

    // Kick off the first iteration without blocking the caller
    void this.runIteration(taskId);
  }

  /**
   * Runs a single iteration of task processing and schedules the next
   * iteration via setImmediate while the task remains RUNNING.
   */
  private async runIteration(taskId: string): Promise<void> {
    if (!this.isProcessing) {
      return;
    }

    let task: Task | null = null;
    try {
      task = await this.tasksService.findById(taskId);

      if (task.status !== TaskStatus.RUNNING) {
        this.logger.log(
          `Task processing completed for task ID: ${taskId} with status: ${task.status}`,
        );
        if (!this.shouldPreserveSessionState(task)) {
          this.computerUseExecutor.forgetTaskContext(taskId);
          this.taskSecretsService.forget(taskId);
        }
        this.isProcessing = false;
        this.currentTaskId = null;
        return;
      }

      this.logger.log(`Processing iteration for task ID: ${taskId}`);

      // Refresh abort controller for this iteration to avoid accumulating
      // "abort" listeners on a single AbortSignal across iterations.
      this.abortController = new AbortController();

      let taskSecurity = this.getTaskSecurityState(task);
      await this.restoreSavedBrowserSessionIfNeeded(task, taskSecurity);
      taskSecurity = this.getTaskSecurityState(task);
      if (taskSecurity.pendingConfirmation) {
        const approvedAction = await this.computerUseExecutor.executeApprovedAction(
          taskId,
          taskSecurity.pendingConfirmation.actionName,
          taskSecurity.pendingConfirmation.actionArgs,
        );

        await this.messagesService.create({
          role: Role.USER,
          taskId,
          content: [
            {
              type: MessageContentType.ToolResult,
              tool_use_id: `approved-${Date.now()}`,
              content: [
                {
                  type: MessageContentType.Text,
                  text: `${taskSecurity.pendingConfirmation.prompt} Approval received and the action has now been executed. Verify the outcome before doing anything else.`,
                },
                ...(approvedAction.screenshotBase64
                  ? [
                      {
                        type: MessageContentType.Image,
                        source: {
                          media_type: 'image/png',
                          type: 'base64',
                          data: approvedAction.screenshotBase64,
                        },
                      } as any,
                    ]
                  : []),
              ],
            },
          ],
        });

        const updatedResult = this.mergeTaskResult(task, {
          security: {
            ...taskSecurity,
            pendingConfirmation: undefined,
            postConfirmationReview: {
              actionName: taskSecurity.pendingConfirmation.actionName,
              enabledAt: new Date().toISOString(),
            },
          },
        });

        await this.tasksService.update(taskId, {
          result: updatedResult,
        });
        task.result = updatedResult as any;
        taskSecurity = this.getTaskSecurityState(task);
      }
      const queuedPlanOutcome = await this.executeQueuedPlanIfPresent(
        taskId,
        task,
      );
      if (queuedPlanOutcome.halted) {
        return;
      }
      task = queuedPlanOutcome.task;
      const activeExecutionOutcome = await this.executeActiveHandoffIfPresent(
        taskId,
        task,
      );
      if (activeExecutionOutcome.halted) {
        return;
      }
      task = activeExecutionOutcome.task;
      taskSecurity = this.getTaskSecurityState(task);
      const mediaMonitorOutcome = await this.maybeHandleAudioFirstMediaMonitoring(
        taskId,
        task,
        taskSecurity,
      );
      if (mediaMonitorOutcome.halted) {
        return;
      }
      task = mediaMonitorOutcome.task;
      const latestSummary = await this.summariesService.findLatest(taskId);
      const unsummarizedMessages =
        await this.messagesService.findUnsummarized(taskId);
      const runtimeSecurityContext = this.buildRuntimeSecurityContext(
        task,
        taskId,
        this.getTaskSecurityState(task),
      );
      const messages = [
        ...(latestSummary
          ? [
              {
                id: '',
                createdAt: new Date(),
                updatedAt: new Date(),
                taskId,
                summaryId: null,
                role: Role.USER,
                content: [
                  {
                    type: MessageContentType.Text,
                    text: latestSummary.content,
                  },
                ],
              },
            ]
          : []),
        ...(runtimeSecurityContext
          ? [
              {
                id: '',
                createdAt: new Date(),
                updatedAt: new Date(),
                taskId,
                summaryId: null,
                role: Role.USER,
                content: [
                  {
                    type: MessageContentType.Text,
                    text: runtimeSecurityContext,
                  },
                ],
              },
            ]
          : []),
        ...unsummarizedMessages,
      ];
      const model = task.model as unknown as BytebotAgentModel;
      const preflightOutcome = await this.runPreflightIfNeeded(
        task,
        messages,
        model,
      );
      if (preflightOutcome === 'paused') {
        return;
      }
      const directLaunchOutcome = await this.maybeLaunchDirectTurnExecution(
        taskId,
        task,
      );
      if (directLaunchOutcome.halted) {
        return;
      }
      task = directLaunchOutcome.task;
      this.logger.debug(
        `Sending ${messages.length} messages to LLM for processing`,
      );

      let agentResponse: BytebotAgentResponse;

      const service = this.services[model.provider];
      if (!service) {
        this.logger.warn(
          `No service found for model provider: ${model.provider}`,
        );
        await this.messagesService.create({
          role: Role.ASSISTANT,
          taskId,
          content: [
            {
              type: MessageContentType.Text,
              text: `I could not continue this task because no model service is configured for provider "${model.provider}".`,
            },
          ],
        });
        await this.tasksService.update(taskId, {
          status: TaskStatus.FAILED,
        });
        this.computerUseExecutor.forgetTaskContext(taskId);
        this.taskSecretsService.forget(taskId);
        this.isProcessing = false;
        this.currentTaskId = null;
        return;
      }

      const usePlanningMode = model.provider === 'google';
      const systemPrompt = usePlanningMode
        ? AGENT_SYSTEM_PROMPT_PLANNER
        : AGENT_SYSTEM_PROMPT;

      agentResponse = await service.generateMessage(
        systemPrompt,
        messages,
        model.name,
        true,
        this.abortController.signal,
        usePlanningMode,
      );
      await this.recordTaskUsage(
        task,
        model,
        agentResponse,
        usePlanningMode ? 'planner' : 'agent',
      );

      let messageContentBlocks = this.sanitizeAssistantContentBlocks(
        task,
        agentResponse.contentBlocks,
      );

      messageContentBlocks = await this.enforceFinalResultReview(
        taskId,
        task,
        messageContentBlocks,
      );
      messageContentBlocks = await this.enforceCompletionReadiness(
        taskId,
        task,
        messageContentBlocks,
      );
      messageContentBlocks = await this.enforceMediaCandidateContinuation(
        taskId,
        task,
        messageContentBlocks,
      );
      messageContentBlocks = await this.enforceMediaExecutionProgress(
        taskId,
        task,
        messageContentBlocks,
      );

      this.logger.debug(
        `Received ${messageContentBlocks.length} content blocks from LLM`,
      );

      if (messageContentBlocks.length === 0) {
        const recoveredMediaBlocks = await this.recoverEmptyMediaPlannerResponse(
          taskId,
          task,
        );
        if (recoveredMediaBlocks.length > 0) {
          messageContentBlocks = recoveredMediaBlocks;
        }
      }

      if (messageContentBlocks.length === 0) {
        this.logger.warn(
          `Task ID: ${taskId} received no content blocks from LLM, marking as failed`,
        );
        await this.messagesService.create({
          role: Role.ASSISTANT,
          taskId,
          content: [
            {
              type: MessageContentType.Text,
              text: 'I could not continue because the model returned no usable next step. The task was stopped before completion.',
            },
          ],
        });
      await this.tasksService.update(taskId, {
        status: TaskStatus.FAILED,
      });
      this.isProcessing = false;
      this.currentTaskId = null;
      return;
    }

      const hasToolUseBlocks = messageContentBlocks.some(
        (block) => block.type === MessageContentType.ToolUse,
      );
      const assistantText = this.getCombinedTextContent(messageContentBlocks);

      if (
        task.createdBy === Role.USER &&
        !hasToolUseBlocks &&
        assistantText &&
        (await this.maybeContinueRemainingPlannerSteps(taskId, task, assistantText))
      ) {
        if (this.isProcessing) {
          setTimeout(() => this.runIteration(taskId), 0);
        }
        return;
      }

      if (
        task.createdBy === Role.USER &&
        !hasToolUseBlocks &&
        assistantText &&
        (await this.maybeAutoContinueExecutionNarration(taskId, task, assistantText))
      ) {
        if (this.isProcessing) {
          setTimeout(() => this.runIteration(taskId), 0);
        }
        return;
      }

      if (
        task.createdBy === Role.USER &&
        !hasToolUseBlocks &&
        assistantText &&
        (await this.maybeAutoContinueLowRiskPrompt(taskId, task, assistantText))
      ) {
        if (this.isProcessing) {
          setTimeout(() => this.runIteration(taskId), 0);
        }
        return;
      }

      if (
        task.createdBy === Role.USER &&
        !hasToolUseBlocks &&
        assistantText &&
        (await this.maybeAutoContinueSetupStateSummary(taskId, task, assistantText))
      ) {
        if (this.isProcessing) {
          setTimeout(() => this.runIteration(taskId), 0);
        }
        return;
      }

      await this.messagesService.create({
        content: messageContentBlocks,
        role: Role.ASSISTANT,
        taskId,
      });

      // Calculate if we need to summarize based on token usage
      const contextWindow = model.contextWindow || 200000; // Default to 200k if not specified
      const contextThreshold = contextWindow * 0.75;
      const shouldSummarize =
        agentResponse.tokenUsage.totalTokens >= contextThreshold;

      if (shouldSummarize) {
        try {
          // After we've successfully generated a response, we can summarize the unsummarized messages
          const summaryResponse = await service.generateMessage(
            SUMMARIZATION_SYSTEM_PROMPT,
            [
              ...messages,
              {
                id: '',
                createdAt: new Date(),
                updatedAt: new Date(),
                taskId,
                summaryId: null,
                role: Role.USER,
                content: [
                  {
                    type: MessageContentType.Text,
                    text: 'Respond with a summary of the messages above. Do not include any additional information.',
                  },
                ],
              },
            ],
            model.name,
            false,
            this.abortController.signal,
          );
          await this.recordTaskUsage(
            task,
            model,
            summaryResponse,
            'summarization',
          );

          const summaryContentBlocks = summaryResponse.contentBlocks;

          this.logger.debug(
            `Received ${summaryContentBlocks.length} summary content blocks from LLM`,
          );
          const summaryContent = summaryContentBlocks
            .filter(
              (block: MessageContentBlock) =>
                block.type === MessageContentType.Text,
            )
            .map((block: TextContentBlock) => block.text)
            .join('\n');

          const summary = await this.summariesService.create({
            content: summaryContent,
            taskId,
          });

          await this.messagesService.attachSummary(taskId, summary.id, [
            ...messages.map((message) => {
              return message.id;
            }),
          ]);

          this.logger.log(
            `Generated summary for task ${taskId} due to token usage (${agentResponse.tokenUsage.totalTokens}/${contextWindow})`,
          );
        } catch (error: any) {
          this.logger.error(
            `Error summarizing messages for task ID: ${taskId}`,
            error.stack,
          );
        }
      }

      this.logger.debug(
        `Token usage for task ${taskId}: ${agentResponse.tokenUsage.totalTokens}/${contextWindow} (${Math.round((agentResponse.tokenUsage.totalTokens / contextWindow) * 100)}%)`,
      );

      const generatedToolResults: ToolResultContentBlock[] = [];
      let setTaskStatusToolUseBlock: SetTaskStatusToolUseBlock | null = null;
      let executorNeedsAttentionPrompt: string | null = null;
      let queuedPlanPrepared = false;

      for (const block of messageContentBlocks) {
        if (
          (block as ToolUseContentBlock).name === 'execute_desktop_step' &&
          (block as ToolUseContentBlock).input?.description
        ) {
          const toolBlock = block as ToolUseContentBlock;
          const desktopStep = this.buildDesktopStepInput(task, toolBlock);
          const handoffSource =
            this.getTaskSecurityState(task).execution?.blockedStep
              ? 'replan'
              : 'initial';
          const useSingleExecution =
            !this.shouldUseQueuedExecution(task) ||
            this.shouldUseActiveFastHandoff(task, [desktopStep]);
          if (useSingleExecution) {
            task = await this.storeActiveExecutionHandoff(taskId, task, {
              summary: this.buildQueuedSummaryFromStep(desktopStep.description),
              source: handoffSource,
              step: desktopStep,
            });
          } else {
            task = await this.storeQueuedExecutionPlan(taskId, task, {
              summary: this.buildQueuedSummaryFromStep(desktopStep.description),
              source: handoffSource,
              steps: [desktopStep],
            });
          }
          queuedPlanPrepared = true;
          generatedToolResults.push({
            type: MessageContentType.ToolResult,
            tool_use_id: toolBlock.id,
            content: [
              {
                type: MessageContentType.Text,
                text: useSingleExecution
                  ? this.buildExecutionStartToolText(
                      task,
                      this.buildQueuedSummaryFromStep(desktopStep.description),
                    )
                  : this.buildMediaPlanStartToolText(
                      this.buildQueuedSummaryFromStep(desktopStep.description),
                      1,
                    ),
              },
            ],
          });
          continue;
        }

        if ((block as ToolUseContentBlock).name === 'queue_desktop_plan') {
          const toolBlock = block as ToolUseContentBlock;
          const queuedPlan = this.buildQueuedPlanInput(task, toolBlock);
          if (!this.shouldUseQueuedExecution(task)) {
            task = await this.storeNormalExecutionSequenceFromSteps(
              taskId,
              task,
              queuedPlan.summary,
              queuedPlan.source,
              queuedPlan.steps,
            );
            queuedPlanPrepared = queuedPlan.steps.length > 0;
            generatedToolResults.push({
              type: MessageContentType.ToolResult,
              tool_use_id: toolBlock.id,
              content: [
                {
                  type: MessageContentType.Text,
                  text: this.buildExecutionStartToolText(task, queuedPlan.summary),
                },
              ],
            });
            continue;
          }
          const shouldUseHandoff = this.shouldUseActiveFastHandoff(
            task,
            queuedPlan.steps,
          );
          if (shouldUseHandoff && queuedPlan.steps[0]) {
            task = await this.storeActiveExecutionHandoff(taskId, task, {
              summary: queuedPlan.summary,
              source: queuedPlan.source,
              step: queuedPlan.steps[0],
            });
            queuedPlanPrepared = true;
          } else {
            task = await this.storeQueuedExecutionPlan(taskId, task, queuedPlan);
            queuedPlanPrepared = queuedPlan.steps.length > 0;
          }

          generatedToolResults.push({
            type: MessageContentType.ToolResult,
            tool_use_id: toolBlock.id,
            content: [
              {
                type: MessageContentType.Text,
                text: shouldUseHandoff
                  ? this.buildExecutionStartToolText(task, queuedPlan.summary)
                  : this.buildMediaPlanStartToolText(
                      queuedPlan.summary,
                      queuedPlan.steps.length,
                    ),
              },
            ],
          });
          continue;
        }

        if (isComputerToolUseContentBlock(block)) {
          const result = await handleComputerToolUse(
            block,
            this.logger,
            this.taskSecretsService,
            taskId,
          );
          const imageBlock = (result.content || []).find(
            (contentBlock: any) =>
              contentBlock.type === MessageContentType.Image &&
              contentBlock.source?.data,
          ) as any;
          if (imageBlock?.source?.data) {
            this.computerUseExecutor.rememberRecentScreenshot(
              taskId,
              imageBlock.source.data,
            );
          }
          if (
            block.name === 'computer_application' &&
            typeof block.input?.application === 'string' &&
            ['brave', 'chrome', 'browser'].includes(
              block.input.application.toLowerCase(),
            )
          ) {
            const security = this.getTaskSecurityState(task);
            const updatedResult = this.mergeTaskResult(task, {
              security: {
                ...security,
                execution: {
                  ...(security.execution || {}),
                  lastOpenedApplication: 'brave',
                  lastApplicationOpenedAt: new Date().toISOString(),
                },
              },
            });
            await this.tasksService.update(taskId, {
              result: updatedResult,
            });
            task.result = updatedResult as any;
          } else if (
            block.name === 'computer_application' &&
            typeof block.input?.application === 'string'
          ) {
            const security = this.getTaskSecurityState(task);
            const updatedResult = this.mergeTaskResult(task, {
              security: {
                ...security,
                execution: {
                  ...(security.execution || {}),
                  lastOpenedApplication: block.input.application.toLowerCase(),
                  lastApplicationOpenedAt: new Date().toISOString(),
                },
              },
            });
            await this.tasksService.update(taskId, {
              result: updatedResult,
            });
            task.result = updatedResult as any;
          }
          generatedToolResults.push(result);
        }

        if (isCreateTaskToolUseBlock(block)) {
          const type = block.input.type?.toUpperCase() as TaskType;
          const priority = block.input.priority?.toUpperCase() as TaskPriority;

          await this.tasksService.create({
            description: block.input.description,
            type,
            createdBy: Role.ASSISTANT,
            ...(block.input.scheduledFor && {
              scheduledFor: new Date(block.input.scheduledFor),
            }),
            model: task.model,
            priority,
          });

          generatedToolResults.push({
            type: MessageContentType.ToolResult,
            tool_use_id: block.id,
            content: [
              {
                type: MessageContentType.Text,
                text: 'The task has been created',
              },
            ],
          });
        }

        if (isSetTaskStatusToolUseBlock(block)) {
          setTaskStatusToolUseBlock = block;

          generatedToolResults.push({
            type: MessageContentType.ToolResult,
            tool_use_id: block.id,
            is_error: block.input.status === 'failed',
            content: [
              {
                type: MessageContentType.Text,
                text: block.input.description,
              },
            ],
          });
        }
      }

      if (generatedToolResults.length > 0) {
        await this.messagesService.create({
          content: generatedToolResults,
          role: Role.USER,
          taskId,
        });
      }

      if (executorNeedsAttentionPrompt) {
        await this.tasksService.update(taskId, {
          status: TaskStatus.NEEDS_HELP,
          result: this.mergeTaskResult(task, {
            security: {
              ...this.getTaskSecurityState(task),
              session: {
                ...(this.getTaskSecurityState(task).session || {}),
                keepAliveUntilUserDone: true,
                phase: 'needs_attention',
                awaitingUserDecision: true,
              },
              pendingConfirmation: undefined,
            },
          }),
        });
        await this.messagesService.create({
          role: Role.ASSISTANT,
          taskId,
          content: [
            {
              type: MessageContentType.Text,
              text: executorNeedsAttentionPrompt,
            },
          ],
        });
        this.releaseProcessingLease(taskId);
        return;
      }

      // Update the task status after all tool results have been generated if we have a set task status tool use block
      if (setTaskStatusToolUseBlock) {
        switch (setTaskStatusToolUseBlock.input.status) {
          case 'completed':
            await this.handleTerminalTaskStatus(
              task,
              'completed',
              setTaskStatusToolUseBlock.input.description,
            );
            break;
          case 'needs_help':
            await this.handleTerminalTaskStatus(
              task,
              'needs_help',
              setTaskStatusToolUseBlock.input.description,
            );
            break;
        }
        return;
      }

      if (
        task.createdBy === Role.USER &&
        !hasToolUseBlocks &&
        assistantText
      ) {
        if (this.shouldDeferImplicitActiveMediaTerminal(task, assistantText)) {
          const security = this.getTaskSecurityState(task);
          const suppressedCount =
            security.execution?.suppressedContinuationPromptCount || 0;
          if (suppressedCount >= 2) {
            const recovered = await this.queueAutomaticMediaRecoveryStepIfNeeded(
              taskId,
              task,
              {
                summaryText: assistantText,
                reason:
                  'The planner kept narrating instead of producing a concrete media continuation step.',
              },
            );
            if (recovered) {
              if (this.isProcessing) {
                setTimeout(() => this.runIteration(taskId), 0);
              }
              return;
            }
            await this.handleTerminalTaskStatus(
              task,
              'failed',
              'The media session was still active, but the planner kept responding with narration instead of a safe executable step and automatic recovery was exhausted.',
            );
            return;
          }

          const updatedResult = this.mergeTaskResult(task, {
            security: {
              ...security,
              execution: {
                ...(security.execution || {}),
                suppressedContinuationPromptCount: suppressedCount + 1,
                lastSuppressedContinuationPrompt: assistantText,
                lastSuppressedContinuationAt: new Date().toISOString(),
              },
            },
          });
          await this.tasksService.update(taskId, {
            result: updatedResult,
          });
          task.result = updatedResult as any;

          this.logger.log(
            `Deferring implicit terminal handling for active media task ${taskId} because the media session is still in progress`,
          );
          if (this.isProcessing) {
            setTimeout(() => this.runIteration(taskId), 1000);
          }
          return;
        }
        await this.handleTerminalTaskStatus(
          task,
          this.inferImplicitTerminalStatus(task, assistantText),
          assistantText,
        );
        return;
      }

      // Schedule the next iteration with a delay so the GUI can render progress
      if (this.isProcessing) {
        setTimeout(
          () => this.runIteration(taskId),
          queuedPlanPrepared ? 0 : 1000,
        );
      }
    } catch (error: any) {
      if (error?.name === 'BytebotAgentInterrupt') {
        this.logger.warn(`Processing aborted for task ID: ${taskId}`);
      } else {
        this.logger.error(
          `Error during task processing iteration for task ID: ${taskId} - ${error.message}`,
          error.stack,
        );
        if (task) {
          const security = this.getTaskSecurityState(task);
          if (
            task.status === TaskStatus.NEEDS_REVIEW ||
            security.session?.awaitingUserDecision
          ) {
            this.releaseProcessingLease(taskId);
            return;
          }
          if (this.isProviderCapacityFailure(error?.message || '')) {
            if (
              await this.queueAutomaticMediaRecoveryStepIfNeeded(taskId, task, {
                providerFailure: true,
                summaryText: error.message || '',
                reason: 'provider_capacity_failure',
              })
            ) {
              return;
            }
            await this.handleTerminalTaskStatus(
              task,
              'needs_help',
              'I hit a temporary model/provider capacity limit while working on this task. Please retry in a moment, and I will continue from the same task state.',
            );
            return;
          }
          await this.handleTerminalTaskStatus(
            task,
            'failed',
            `I hit an internal error while working on this task and had to stop. Last error: ${error.message}`,
          );
        } else {
          this.isProcessing = false;
          this.currentTaskId = null;
        }
      }
    }
  }

  async stopProcessing(): Promise<void> {
    if (!this.isProcessing) {
      return;
    }

    this.logger.log(`Stopping execution of task ${this.currentTaskId}`);

    // Signal any in-flight async operations to abort
    this.abortController?.abort();

    await this.inputCaptureService.stop();

    if (this.currentTaskId) {
      this.computerUseExecutor.forgetTaskContext(this.currentTaskId);
      this.taskSecretsService.forget(this.currentTaskId);
    }

    this.isProcessing = false;
    this.currentTaskId = null;
  }

  private async takeDesktopScreenshot(): Promise<string | null> {
    try {
      const resp = await fetch(`${BYTEBOT_DESKTOP_BASE_URL}/computer-use`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'screenshot' }),
      });
      if (!resp.ok) {
        return null;
      }
      const data = await resp.json();
      return data.image || null;
    } catch {
      return null;
    }
  }

  private async getTraceScreenshotData(
    executorScreenshotBase64?: string,
  ): Promise<string | null> {
    if (executorScreenshotBase64) {
      return executorScreenshotBase64;
    }

    return this.takeDesktopScreenshot();
  }

  private shouldAttachTraceScreenshot(
    mode: ExecutionMode | undefined,
    status: 'in_progress' | 'completed' | 'drifted' | 'failed',
  ): boolean {
    if (status === 'failed' || status === 'drifted') {
      return true;
    }

    return mode === 'strict' || mode === 'guarded';
  }

  private async fetchDesktopAudioStatus(): Promise<DesktopAudioStatus | null> {
    try {
      const response = await fetch(
        `${BYTEBOT_DESKTOP_BASE_URL}/computer-use/audio/status`,
      );
      if (!response.ok) {
        return null;
      }
      return (await response.json()) as DesktopAudioStatus;
    } catch {
      return null;
    }
  }

  private async fetchDesktopMediaSessionState(): Promise<DesktopMediaSessionState | null> {
    try {
      const response = await fetch(
        `${BYTEBOT_DESKTOP_BASE_URL}/computer-use/media/session`,
      );
      if (!response.ok) {
        return null;
      }
      return (await response.json()) as DesktopMediaSessionState;
    } catch {
      return null;
    }
  }

  private async pauseDesktopPlaybackIfPossible(): Promise<void> {
    try {
      await fetch(`${BYTEBOT_DESKTOP_BASE_URL}/computer-use`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'press_keys',
          keys: ['Space'],
          press: 'press',
        }),
      });
    } catch (error: any) {
      this.logger.debug(
        `Best-effort pause for follow-on media failed: ${error?.message || 'unknown error'}`,
      );
    }
  }

  private shouldStopAfterRequestedMedia(
    media?: NonNullable<TaskSecurityState['media']>,
  ): boolean {
    if (!media) {
      return true;
    }

    return (
      media.transcriptRequested === true ||
      media.summaryRequested === true ||
      media.continueWithRelatedMedia !== true
    );
  }

  private hasLatchedMediaCompletion(
    media?: NonNullable<TaskSecurityState['media']>,
    summary?: string,
  ): boolean {
    if (!media?.selectedAt) {
      return false;
    }

    if (
      media.completionLatchedAt ||
      media.phase === 'ended' ||
      media.phase === 'transcribing' ||
      media.phase === 'summarizing'
    ) {
      return true;
    }

    const lastClassification = media.audioMonitoring?.lastClassification;
    if (media.kind === 'meeting') {
      return (
        lastClassification === 'meeting_ended' ||
        this.classifyMediaReviewState(summary || media.lastSummary || '', media) ===
          'meeting_ended'
      );
    }

    if (
      lastClassification === 'requested_media_ended' ||
      (lastClassification === 'follow_on_media' &&
        this.shouldStopAfterRequestedMedia(media))
    ) {
      return true;
    }

    const reviewState = this.classifyMediaReviewState(
      summary || media.lastSummary || '',
      media,
    );
    return (
      this.countMediaCompletionSignals(
        media,
        reviewState,
        summary || media.lastSummary || '',
        {
          positionMs: media.observedPositionMs,
          durationMs: media.observedDurationMs,
          playerState: media.observedPlayerState,
        },
      ) >= 2
    );
  }

  private countMediaCompletionSignals(
    media: NonNullable<TaskSecurityState['media']>,
    reviewState: MediaReviewState,
    summaryText: string,
    observation?: {
      positionMs?: number;
      durationMs?: number;
      playerState?: string;
    },
  ): number {
    const normalizedSummary = (summaryText || '').toLowerCase();
    const normalizedPlayerState = (observation?.playerState || '').toLowerCase();
    const durationMs = observation?.durationMs ?? media.observedDurationMs;
    const positionMs = observation?.positionMs ?? media.observedPositionMs;
    const maxObservedPositionMs = media.maxObservedPositionMs || 0;
    const reachedNearEnd =
      durationMs !== undefined &&
      maxObservedPositionMs >= Math.max(8000, durationMs - 5000);
    const resetToBeginning =
      positionMs !== undefined &&
      positionMs <= 4000 &&
      reachedNearEnd;

    let signals = 0;

    if (
      reviewState === 'requested_media_ended' ||
      (reviewState === 'follow_on_media' && this.shouldStopAfterRequestedMedia(media))
    ) {
      signals += 1;
    }

    if (
      media.audioMonitoring?.lastClassification === 'requested_media_ended' ||
      (media.audioMonitoring?.lastClassification === 'follow_on_media' &&
        this.shouldStopAfterRequestedMedia(media))
    ) {
      signals += 1;
    }

    if (
      normalizedPlayerState === 'ended' ||
      normalizedPlayerState === 'replay'
    ) {
      signals += 1;
    }

    if (
      /\b(replay button|ended screen|playback is complete|video ended|song ended|not playing anymore|stopped playing)\b/i.test(
        normalizedSummary,
      )
    ) {
      signals += 1;
    }

    if (resetToBeginning) {
      signals += 1;
    }

    return signals;
  }

  private async maybeHandleAudioFirstMediaMonitoring(
    taskId: string,
    task: Task,
    security: TaskSecurityState,
  ): Promise<{ task: Task; halted: boolean }> {
    const media = security.media;
    if (!this.shouldUseAudioFirstMonitoring(task, security)) {
      return { task, halted: false };
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const nativeMediaSession =
      media?.kind === 'meeting'
        ? null
        : await this.fetchDesktopMediaSessionState();
    let audioStatus = await this.fetchDesktopAudioStatus();
    if (
      !audioStatus &&
      nativeMediaSession?.session?.available &&
      media?.kind !== 'meeting'
    ) {
      audioStatus = {
        source: 'native_session_fallback',
        hasSignal: (nativeMediaSession.session.status || '').toLowerCase() === 'playing',
        sampledAt: nativeMediaSession.sampledAt || nowIso,
        peakDb: null,
        rmsDb: null,
        zeroCrossingRate: null,
        signature: null,
      };
    }
    if (!audioStatus) {
      return { task, halted: false };
    }

    const nativeObservation = this.buildMediaObservationFromNativeSession(
      media,
      nativeMediaSession,
    );
    const nativePlaybackLikelyActive = this.isNativeMediaSessionActivelyPlaying(
      media,
      nativeMediaSession,
    );
    const config = this.getMediaMonitorConfig(
      media
        ? {
            ...media,
            observedDurationMs:
              nativeObservation.durationMs ?? media.observedDurationMs,
            observedPositionMs:
              nativeObservation.positionMs ?? media.observedPositionMs,
          }
        : media,
      task.description,
    );
    const existingMonitor = media?.audioMonitoring || {};
    const hasStableIdentityClassification =
      media?.kind === 'meeting'
        ? existingMonitor.lastClassification === 'meeting_active' ||
          existingMonitor.lastClassification === 'meeting_quiet'
        : existingMonitor.lastClassification === 'requested_media_active';
    const audioDrivenRecordingReady =
      !!media &&
      !media.recordingStartedAt &&
      !media.recordingStoppedAt &&
      (media.transcriptRequested || media.summaryRequested) &&
      (audioStatus.hasSignal ||
        nativePlaybackLikelyActive ||
        !!media.playbackPrimedAt ||
        !!media.playbackVerifiedAt);
    const needsPlaybackIdentityCheck =
      !!media &&
      !!audioStatus.hasSignal &&
      !this.isAdHandlingSummary(media.lastSummary || '') &&
      !this.mediaReviewIndicatesEnded(media.lastSummary || '', media) &&
      (!media.playbackVerifiedAt || !hasStableIdentityClassification);
    const previousSignature = existingMonitor.lastSignature || null;
    const previousSilenceStartedAt = existingMonitor.silenceStartedAt;
    const previousSilenceDurationMs = previousSilenceStartedAt
      ? now.getTime() - new Date(previousSilenceStartedAt).getTime()
      : 0;
    const silenceStartedAt = audioStatus.hasSignal
      ? undefined
      : previousSilenceStartedAt || nowIso;
    const lastAudibleAt = audioStatus.hasSignal
      ? nowIso
      : existingMonitor.lastAudibleAt;
    const lastVisualCheckAt =
      existingMonitor.lastClassificationAt || existingMonitor.lastVisualCheckAt;
    const silenceDurationMs = silenceStartedAt
      ? now.getTime() - new Date(silenceStartedAt).getTime()
      : 0;
    const timeSinceVisualCheckMs = lastVisualCheckAt
      ? now.getTime() - new Date(lastVisualCheckAt).getTime()
      : Number.POSITIVE_INFINITY;
    const signatureDistance = this.computeAudioSignatureDistance(
      previousSignature,
      audioStatus.signature || null,
    );
    const cameBackAfterSilence =
      !!audioStatus.hasSignal &&
      !!previousSilenceStartedAt &&
      previousSilenceDurationMs >= config.silenceTriggerMs;
    const nativeTerminalSignal = this.inferTerminalMediaStateFromNativeSession(
      media,
      nativeMediaSession,
      audioStatus,
    );

    let triggerReason: MediaMonitorTriggerReason | null = null;
    const elapsedSinceVerifiedMs = media?.playbackVerifiedAt
      ? now.getTime() - new Date(media.playbackVerifiedAt).getTime()
      : null;
    const expectedDurationMs = config.expectedDurationMs ?? null;
    const expectedEndLeadMs = config.expectedEndLeadMs ?? 0;
    const periodicVisualCheckMs = config.periodicVisualCheckMs ?? null;
    const suppressRoutineProgressChecks = false;
    const monitorWarmupMs = config.monitorWarmupMs ?? 0;
    const monitorWarmupElapsed =
      elapsedSinceVerifiedMs === null || elapsedSinceVerifiedMs >= monitorWarmupMs;
    const observedPositionForEndCheck =
      nativeObservation.positionMs ?? media?.observedPositionMs;
    const nearExpectedEnd =
      media?.kind !== 'meeting' &&
      expectedDurationMs !== null &&
      (
        (observedPositionForEndCheck !== undefined &&
          observedPositionForEndCheck >=
            Math.max(0, expectedDurationMs - expectedEndLeadMs)) ||
        (elapsedSinceVerifiedMs !== null &&
          elapsedSinceVerifiedMs >=
            Math.max(0, expectedDurationMs - expectedEndLeadMs))
      );

    const playbackIdentityCooldownMs = hasStableIdentityClassification
      ? config.minVisualCooldownMs
      : Math.min(config.intervalMs, 2000);

    if (
      needsPlaybackIdentityCheck &&
      timeSinceVisualCheckMs >= playbackIdentityCooldownMs
    ) {
      triggerReason = 'playback_identity_check';
    } else if (
      !audioStatus.hasSignal &&
      !(media?.kind !== 'meeting' && nativePlaybackLikelyActive) &&
      !!existingMonitor.lastAudibleAt &&
      silenceDurationMs >= config.silenceTriggerMs &&
      timeSinceVisualCheckMs >= config.minVisualCooldownMs
    ) {
      triggerReason =
        media?.kind === 'meeting'
          ? 'meeting_extended_silence_check'
          : 'prolonged_silence';
    } else if (
      cameBackAfterSilence &&
      timeSinceVisualCheckMs >= config.minVisualCooldownMs
    ) {
      triggerReason = 'signal_returned_after_silence';
    } else if (
      nearExpectedEnd &&
      timeSinceVisualCheckMs >= config.minVisualCooldownMs
    ) {
      triggerReason = 'expected_end_check';
    } else if (
      media?.kind !== 'meeting' &&
      audioStatus.hasSignal &&
      previousSignature &&
      audioStatus.signature &&
      signatureDistance !== null &&
      signatureDistance >= config.signatureTriggerThreshold &&
      timeSinceVisualCheckMs >= config.minVisualCooldownMs
    ) {
      triggerReason = 'audio_signature_changed';
    } else if (
      media?.kind !== 'meeting' &&
      periodicVisualCheckMs !== null &&
      !suppressRoutineProgressChecks &&
      monitorWarmupElapsed &&
      timeSinceVisualCheckMs >= periodicVisualCheckMs
    ) {
      triggerReason = 'periodic_progress_check';
    }

    let updatedMedia: NonNullable<TaskSecurityState['media']> | undefined = media;
    if (updatedMedia && nativeObservation.observedAt) {
      updatedMedia = {
        ...updatedMedia,
        observedAt: nativeObservation.observedAt,
        observedPositionMs:
          nativeObservation.positionMs ?? updatedMedia.observedPositionMs,
        observedDurationMs:
          nativeObservation.durationMs ?? updatedMedia.observedDurationMs,
        observedTitle: nativeObservation.title || updatedMedia.observedTitle,
        observedChannel:
          nativeObservation.channel || updatedMedia.observedChannel,
        observedUrl: nativeObservation.url || updatedMedia.observedUrl,
        observedPlayerName:
          nativeObservation.playerName || updatedMedia.observedPlayerName,
        observedPlayerState:
          nativeObservation.playerState || updatedMedia.observedPlayerState,
        maxObservedPositionMs:
          nativeObservation.maxObservedPositionMs ??
          updatedMedia.maxObservedPositionMs,
      };
    }

    if (audioDrivenRecordingReady && media) {
      updatedMedia = await this.mediaSessionService.maybeStartRecording(
        taskId,
        task,
        {
          ...security,
          media: {
            ...(updatedMedia || media),
            audioMonitoring: {
              ...existingMonitor,
              lastAudibleAt,
              lastPolledAt: audioStatus.sampledAt || nowIso,
              lastPeakDb: audioStatus.peakDb ?? null,
              lastRmsDb: audioStatus.rmsDb ?? null,
              lastZeroCrossingRate: audioStatus.zeroCrossingRate ?? null,
              lastSignature: audioStatus.signature || null,
            },
          },
        },
        {
          currentAudioHasSignal: audioStatus.hasSignal,
          currentPlaybackLikelyActive:
            nativePlaybackLikelyActive ||
            !!media.playbackPrimedAt ||
            !!media.playbackVerifiedAt,
        },
      );
    }

    if (nativeTerminalSignal && updatedMedia) {
      if (audioStatus.hasSignal) {
        await this.pauseDesktopPlaybackIfPossible();
      }

      const terminalResult = this.mergeTaskResult(task, {
        security: {
          ...security,
          media: {
            ...updatedMedia,
            phase:
              nativeTerminalSignal.reviewState === 'follow_on_media'
                ? this.shouldStopAfterRequestedMedia(updatedMedia)
                  ? 'ended'
                  : 'follow_on_detected'
                : 'ended',
            completionLatchedAt: updatedMedia.completionLatchedAt || nowIso,
            endedAt:
              updatedMedia.kind !== 'meeting'
                ? updatedMedia.endedAt || nowIso
                : updatedMedia.endedAt,
            lastSummary: nativeTerminalSignal.summary,
            audioMonitoring: {
              ...existingMonitor,
              mode: 'audio_first',
              lastPolledAt: audioStatus.sampledAt || nowIso,
              lastAudibleAt,
              silenceStartedAt,
              lastPeakDb: audioStatus.peakDb ?? null,
              lastRmsDb: audioStatus.rmsDb ?? null,
              lastZeroCrossingRate: audioStatus.zeroCrossingRate ?? null,
              lastSignature: audioStatus.signature || null,
              lastTriggerAt: nowIso,
              lastTriggerReason: 'expected_end_check',
              lastClassification:
                nativeTerminalSignal.reviewState === 'follow_on_media' &&
                this.shouldStopAfterRequestedMedia(updatedMedia)
                  ? 'follow_on_media'
                  : nativeTerminalSignal.reviewState,
              lastClassificationAt: nowIso,
            },
          },
        },
      });

      await this.tasksService.update(taskId, {
        result: terminalResult,
      });
      task.result = terminalResult as any;
      await this.handleTerminalTaskStatus(
        task,
        'completed',
        nativeTerminalSignal.summary,
      );
      return { task, halted: true };
    }

    const updatedResult = this.mergeTaskResult(task, {
      security: {
        ...security,
        media: {
          ...(updatedMedia || media),
          audioMonitoring: {
            ...existingMonitor,
            mode: 'audio_first',
            lastPolledAt: audioStatus.sampledAt || nowIso,
            lastAudibleAt,
            silenceStartedAt,
            lastPeakDb: audioStatus.peakDb ?? null,
            lastRmsDb: audioStatus.rmsDb ?? null,
            lastZeroCrossingRate: audioStatus.zeroCrossingRate ?? null,
            lastSignature: audioStatus.signature || null,
            ...(triggerReason
              ? {
                  lastTriggerAt: nowIso,
                  lastTriggerReason: triggerReason,
                }
              : {}),
          },
        },
      },
    });

    await this.tasksService.update(taskId, {
      result: updatedResult,
    });
    task.result = updatedResult as any;

    if (
      !triggerReason &&
      (await this.queueAutomaticMediaRecoveryStepIfNeeded(taskId, task, {
        reason: 'paused_or_recovery_state',
      }))
    ) {
      return { task, halted: true };
    }

    if (!triggerReason) {
      const nextIntervalMs = audioStatus.hasSignal
        ? config.intervalMs
        : Math.min(config.intervalMs, Math.max(5000, config.silenceTriggerMs / 2));
      this.logger.debug(
        `Audio-first monitoring remains stable for task ${taskId}; next poll in ${nextIntervalMs}ms`,
      );
      if (this.isProcessing) {
        setTimeout(() => this.runIteration(taskId), nextIntervalMs);
      }
      return { task, halted: true };
    }

    const monitorReason = this.describeMediaMonitorTrigger(
      triggerReason,
      media?.kind,
      task.description,
      audioStatus,
      silenceDurationMs,
    );
    await this.messagesService.create({
      content: [
        {
          type: MessageContentType.ToolResult,
          tool_use_id: `audio-monitor-${Date.now()}`,
          content: [
            {
              type: MessageContentType.Text,
              text: monitorReason,
            },
          ],
        },
      ],
      role: Role.USER,
      taskId,
    });

    if (
      await this.queueAutomaticMediaRecoveryStepIfNeeded(taskId, task, {
        summaryText: monitorReason,
        reason: triggerReason,
      })
    ) {
      return { task, halted: true };
    }

    this.logger.log(
      `Audio-first monitoring triggered a focused visual check for task ${taskId}: ${triggerReason}`,
    );

    return { task, halted: false };
  }

  private getAutomaticMediaRecoveryContext(
    task: Task,
    security: TaskSecurityState,
    options?: {
      providerFailure?: boolean;
      summaryText?: string;
      reason?: string;
    },
  ): {
    media: NonNullable<TaskSecurityState['media']>;
    summaryText: string;
    reviewState: MediaReviewState;
    delayMs: number;
  } | null {
    const media = security.media;
    if (!this.isMediaTask(task.description) || !media?.selectedAt) {
      return null;
    }

    if (
      security.pendingConfirmation ||
      !!security.execution?.activeExecution ||
      (security.execution?.mediaQueue || []).length > 0
    ) {
      return null;
    }

    if (
      media.phase === 'ended' ||
      media.phase === 'transcribing' ||
      media.phase === 'summarizing' ||
      this.hasLatchedMediaCompletion(media, options?.summaryText)
    ) {
      return null;
    }

    const summaryText = options?.summaryText || media.lastSummary || '';
    const reviewState =
      media.audioMonitoring?.lastClassification ||
      this.classifyMediaReviewState(summaryText, media);
    const monitor = media.audioMonitoring || {};
    const lastAutoRecoveryAt = monitor.lastAutoRecoveryAt
      ? new Date(monitor.lastAutoRecoveryAt).getTime()
      : 0;
    const lastClassificationAt = monitor.lastClassificationAt
      ? new Date(monitor.lastClassificationAt).getTime()
      : 0;
    const now = Date.now();
    const autoRecoveryCooldownMs = options?.providerFailure ? 12000 : 6000;

    if (lastAutoRecoveryAt && now - lastAutoRecoveryAt < autoRecoveryCooldownMs) {
      return null;
    }

    const recentlyClassified =
      lastClassificationAt > 0 && now - lastClassificationAt <= 45000;
    const pausedRecoveryNeeded =
      (reviewState === 'requested_media_paused' ||
        (media.phase === 'playback_verification' &&
          this.isPausedMediaPlaybackSummary(summaryText))) &&
      recentlyClassified;
    const networkRecoveryNeeded =
      reviewState === 'network_issue' &&
      (media.phase === 'network_recovery' ||
        media.phase === 'playback_verification' ||
        options?.providerFailure === true);
    const mismatchRecoveryNeeded =
      reviewState === 'requested_media_mismatch' &&
      (media.phase === 'playback_verification' || options?.providerFailure === true);
    const triggerDrivenRecoveryNeeded =
      !options?.providerFailure &&
      !!options?.summaryText &&
      !!options?.reason &&
      [
        'playback_identity_check',
        'prolonged_silence',
        'signal_returned_after_silence',
        'expected_end_check',
        'audio_signature_changed',
        'periodic_progress_check',
        'meeting_extended_silence_check',
      ].includes(options.reason);

    if (
      !pausedRecoveryNeeded &&
      !networkRecoveryNeeded &&
      !mismatchRecoveryNeeded &&
      !triggerDrivenRecoveryNeeded
    ) {
      return null;
    }

    return {
      media,
      summaryText,
      reviewState,
      delayMs: options?.providerFailure ? 6000 : 0,
    };
  }

  private async queueAutomaticMediaRecoveryStepIfNeeded(
    taskId: string,
    task: Task,
    options?: { providerFailure?: boolean; summaryText?: string; reason?: string },
  ): Promise<boolean> {
    const security = this.getTaskSecurityState(task);
    const recovery = this.getAutomaticMediaRecoveryContext(task, security, {
      providerFailure: options?.providerFailure,
      summaryText: options?.summaryText,
    });

    if (!recovery) {
      return false;
    }

    const nowIso = new Date().toISOString();
    const description = this.buildMediaContinuationStep(
      task,
      recovery.summaryText,
    );
    const executionMode = this.getMediaContinuationExecutionMode(
      recovery.media,
      recovery.summaryText,
    );
    const updatedResult = this.mergeTaskResult(task, {
      security: {
        ...security,
        media: {
          ...recovery.media,
          audioMonitoring: {
            ...(recovery.media.audioMonitoring || {}),
            lastAutoRecoveryAt: nowIso,
            ...(options?.providerFailure
              ? {
                  lastProviderFailureAt: nowIso,
                  providerFailureCount:
                    (recovery.media.audioMonitoring?.providerFailureCount || 0) + 1,
                }
              : {}),
          },
        },
        execution: {
          ...(security.execution || {}),
          activeExecution: {
            description,
            executionMode,
            completionCondition: !recovery.media.playbackVerifiedAt
              ? 'Only mark this step complete once the requested media or meeting is visibly active on screen, not just loaded, paused, or blocked.'
              : recovery.reviewState === 'requested_media_paused'
                ? 'Only mark this step complete once the requested media is visibly playing and progressing again, not merely loaded or paused.'
                : 'Only mark this step complete once the current media or meeting session is stable again or a true ended state is visible.',
            driftCondition:
              'Only mark drift if the current page is clearly on the wrong app/site, a login wall, or a blocker that cannot be recovered from within the current session.',
            source: 'replan',
            createdAt: nowIso,
            startedAt: undefined,
            completedAt: undefined,
            blockedAt: undefined,
            blockReason: undefined,
          },
          pendingSteps: [],
          stepPlan: {
            summary: options?.providerFailure
              ? 'Automatic media recovery after temporary provider capacity issue.'
              : 'Automatic media recovery for the current session.',
            guidelines: this.defaultPlannerGuidelines(),
            source: 'replan',
            createdAt: nowIso,
            startedAt: nowIso,
            currentIndex: 1,
            totalSteps: 1,
            completedAt: undefined,
          },
          mediaQueue: [],
          mediaPlan: undefined,
          blockedStep: undefined,
          currentStep: undefined,
          syntheticContinuationCount:
            (security.execution?.syntheticContinuationCount || 0) + 1,
          lastSyntheticContinuationAt: nowIso,
          lastSyntheticContinuationText: description,
        },
      },
    });

    await this.tasksService.update(taskId, {
      result: updatedResult,
    });
    task.result = updatedResult as any;

    await this.messagesService.create({
      role: Role.ASSISTANT,
      taskId,
      content: [
        {
          type: MessageContentType.Text,
          text: this.buildCompactRecoveryText(
            1,
            1,
            recovery.summaryText || options?.reason || recovery.reviewState,
          ),
        },
      ],
    });

    this.logger.warn(
      `Queued automatic media recovery step for task ${taskId} (${options?.reason || recovery.reviewState})`,
    );

    if (this.isProcessing) {
      setTimeout(() => this.runIteration(taskId), recovery.delayMs);
    }

    return true;
  }

  private shouldUseAudioFirstMonitoring(
    task: Task,
    security: TaskSecurityState,
  ): boolean {
    const media = security.media;
    const wantsAudioDrivenMonitoring =
      !!media?.keepRunningUntilDone ||
      !!media?.transcriptRequested ||
      !!media?.summaryRequested;
    if (
      !media?.selectedAt ||
      !wantsAudioDrivenMonitoring ||
      (
        !media.playbackVerifiedAt &&
        !media.playbackPrimedAt &&
        (media.observedPlayerState || '').toLowerCase() !== 'playing' &&
        media.phase !== 'playback_verification' &&
        media.phase !== 'ad_handling' &&
        media.phase !== 'recording' &&
        media.phase !== 'monitoring' &&
        media.phase !== 'quiet_monitoring' &&
        media.phase !== 'network_recovery'
      )
    ) {
      return false;
    }

    if (
      security.execution?.blockedStep ||
      security.pendingConfirmation ||
      security.execution?.activeExecution
    ) {
      return false;
    }

    if (this.hasLatchedMediaCompletion(media)) {
      return false;
    }

    return this.isMediaTask(task.description);
  }

  private shouldHoldForMediaMonitoring(
    task: Task,
    security: TaskSecurityState,
  ): boolean {
    if (!this.isMediaTask(task.description)) {
      return false;
    }

    const media = security.media;
    if (
      !media?.selectedAt ||
      !media.playbackVerifiedAt ||
      this.hasLatchedMediaCompletion(media)
    ) {
      return false;
    }

    if (security.execution?.activeExecution || security.execution?.blockedStep) {
      return false;
    }

    return this.shouldUseAudioFirstMonitoring(task, security);
  }

  private getMediaMonitorConfig(
    media?: NonNullable<TaskSecurityState['media']>,
    taskDescription?: string,
  ): MediaMonitorConfig {
    const kind = media?.kind;
    if (kind === 'meeting') {
      return {
        intervalMs: 10000,
        silenceTriggerMs: 90000,
        minVisualCooldownMs: 45000,
        signatureTriggerThreshold: 0.72,
        monitorWarmupMs: 15000,
      };
    }

    if (kind === 'video' && media?.shortForm) {
      return {
        intervalMs: 1000,
        silenceTriggerMs: 2000,
        minVisualCooldownMs: 2500,
        signatureTriggerThreshold: 0.42,
        periodicVisualCheckMs: 4000,
        expectedDurationMs: 20 * 1000,
        expectedEndLeadMs: 5000,
        monitorWarmupMs: 1000,
      };
    }

    if (kind === 'audio') {
      return {
        intervalMs: 2500,
        silenceTriggerMs: 3500,
        minVisualCooldownMs: 5000,
        signatureTriggerThreshold: 0.42,
        periodicVisualCheckMs: 7000,
        expectedDurationMs: 2 * 60 * 1000,
        expectedEndLeadMs: 12000,
        monitorWarmupMs: 2000,
      };
    }

    const inferredExpectedDurationMs =
      media?.observedDurationMs ||
      this.inferRequestedMediaDurationMs(taskDescription);

    return {
      intervalMs: 1500,
      silenceTriggerMs: 2500,
      minVisualCooldownMs: 4000,
      signatureTriggerThreshold: 0.45,
      periodicVisualCheckMs: 7000,
      expectedDurationMs: inferredExpectedDurationMs || 90 * 1000,
      expectedEndLeadMs: inferredExpectedDurationMs
        ? Math.min(15000, Math.max(5000, Math.round(inferredExpectedDurationMs / 6)))
        : 10000,
      monitorWarmupMs: 1500,
    };
  }

  private inferRequestedMediaDurationMs(taskDescription?: string): number | null {
    const normalized = (taskDescription || '').toLowerCase();
    if (!normalized) {
      return null;
    }

    const minuteMatch = normalized.match(
      /\b(\d+)\s*(?:min|mins|minute|minutes)\b/,
    );
    if (minuteMatch) {
      return Number(minuteMatch[1]) * 60 * 1000;
    }

    const hyphenMinuteMatch = normalized.match(
      /\b(\d+)[-\s]*(?:minute|min)\b/,
    );
    if (hyphenMinuteMatch) {
      return Number(hyphenMinuteMatch[1]) * 60 * 1000;
    }

    const secondMatch = normalized.match(
      /\b(\d+)\s*(?:sec|secs|second|seconds)\b/,
    );
    if (secondMatch) {
      return Number(secondMatch[1]) * 1000;
    }

    return null;
  }

  private extractMediaObservation(
    summaryText: string,
    checkpoints?: Array<{
      visibleSummary?: string;
      extractedFacts?: Record<string, string>;
    }>,
  ): {
    positionMs?: number;
    durationMs?: number;
    title?: string;
    channel?: string;
    playerState?: string;
  } {
    const latestCheckpoint = [...(checkpoints || [])]
      .reverse()
      .find(
        (checkpoint) =>
          checkpoint?.visibleSummary ||
          (checkpoint?.extractedFacts &&
            Object.keys(checkpoint.extractedFacts).length > 0),
      );
    const extractedFacts = latestCheckpoint?.extractedFacts || {};
    const checkpointSummary = latestCheckpoint?.visibleSummary || '';
    const combined = `${summaryText}\n${checkpointSummary}`;

    const factPosition =
      this.parsePlayerTimestampToMs(
        extractedFacts.player_current_time ||
          extractedFacts.current_time ||
          extractedFacts.elapsed_time,
      ) ?? undefined;
    const factDuration =
      this.parsePlayerTimestampToMs(
        extractedFacts.player_total_time ||
          extractedFacts.total_time ||
          extractedFacts.duration,
      ) ?? undefined;

    const ratioMatch = /(\b\d{1,2}:\d{2}(?::\d{2})?)\s*(?:\/|of)\s*(\d{1,2}:\d{2}(?::\d{2})?)/i.exec(
      combined,
    );
    const pausedAtMatch = /\b(?:paused|playing|at)\s+(?:at\s+)?(\d{1,2}:\d{2}(?::\d{2})?)\b/i.exec(
      combined,
    );

    const title =
      extractedFacts.media_title ||
      extractedFacts.title ||
      this.extractQuotedMediaLabel(combined, /(video|song|track|media|short|reel)/i);
    const channel =
      extractedFacts.media_channel ||
      extractedFacts.channel ||
      this.extractQuotedMediaLabel(combined, /(channel|creator|artist|by)/i);
    const playerState =
      extractedFacts.player_state ||
      extractedFacts.state ||
      (/replay button/i.test(combined)
        ? 'ended'
        : /\bpaused\b/i.test(combined)
          ? 'paused'
          : /\bplaying\b/i.test(combined)
            ? 'playing'
            : undefined);

    return {
      positionMs:
        factPosition ??
        (ratioMatch
          ? this.parsePlayerTimestampToMs(ratioMatch[1]) ?? undefined
          : pausedAtMatch
            ? this.parsePlayerTimestampToMs(pausedAtMatch[1]) ?? undefined
            : undefined),
      durationMs:
        factDuration ??
        (ratioMatch
          ? this.parsePlayerTimestampToMs(ratioMatch[2]) ?? undefined
          : undefined),
      title,
      channel,
      playerState,
    };
  }

  private extractQuotedMediaLabel(
    text: string,
    anchorPattern: RegExp,
  ): string | undefined {
    const directQuoted =
      /(?:titled|called|currently on|current video|current song|channel|by)\s+"([^"]+)"/i.exec(
        text,
      );
    if (directQuoted?.[1]) {
      return directQuoted[1].trim();
    }

    if (!anchorPattern.test(text)) {
      return undefined;
    }

    const genericQuoted = /"([^"]+)"/.exec(text);
    return genericQuoted?.[1]?.trim() || undefined;
  }

  private parsePlayerTimestampToMs(value?: string): number | null {
    if (!value) {
      return null;
    }

    const normalized = value.trim();
    if (!normalized) {
      return null;
    }

    const parts = normalized.split(':').map((part) => Number(part));
    if (parts.some((part) => !Number.isFinite(part))) {
      return null;
    }

    if (parts.length === 2) {
      return (parts[0] * 60 + parts[1]) * 1000;
    }

    if (parts.length === 3) {
      return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
    }

    return null;
  }

  private buildMediaObservationFromNativeSession(
    media: NonNullable<TaskSecurityState['media']> | undefined,
    nativeState: DesktopMediaSessionState | null,
  ): {
    positionMs?: number;
    durationMs?: number;
    title?: string;
    channel?: string;
    playerState?: string;
    url?: string;
    playerName?: string;
    maxObservedPositionMs?: number;
    observedAt?: string;
  } {
    const session = nativeState?.session;
    if (!session?.available) {
      return {};
    }

    const positionMs =
      typeof session.positionMs === 'number' ? session.positionMs : undefined;
    const maxObservedPositionMs =
      positionMs === undefined
        ? media?.maxObservedPositionMs
        : Math.max(media?.maxObservedPositionMs || 0, positionMs);

    return {
      positionMs,
      durationMs:
        typeof session.lengthMs === 'number' ? session.lengthMs : undefined,
      title:
        this.stripBrowserMediaSuffix(session.title) ||
        this.stripBrowserMediaSuffix(nativeState?.activeWindowTitle),
      channel: session.artist,
      playerState: session.status?.toLowerCase(),
      url: session.url,
      playerName: session.playerName,
      maxObservedPositionMs,
      observedAt: nativeState?.sampledAt,
    };
  }

  private isNativeMediaSessionActivelyPlaying(
    media: NonNullable<TaskSecurityState['media']> | undefined,
    nativeState: DesktopMediaSessionState | null,
  ): boolean {
    const session = nativeState?.session;
    if (!session?.available) {
      return false;
    }

    const status = (session.status || '').toLowerCase();
    if (status === 'playing') {
      return true;
    }

    const positionMs =
      typeof session.positionMs === 'number' ? session.positionMs : undefined;
    if (positionMs === undefined) {
      return false;
    }

    const previousPositionMs =
      media?.observedPositionMs ?? media?.maxObservedPositionMs ?? 0;
    return positionMs >= previousPositionMs + 750;
  }

  private hasStrongPlaybackEvidence(
    media: NonNullable<TaskSecurityState['media']> | undefined,
    reviewState: MediaReviewState,
    summaryText: string,
    observation?: {
      positionMs?: number;
      durationMs?: number;
      title?: string;
      channel?: string;
      playerState?: string;
    },
    nativeState?: DesktopMediaSessionState | null,
  ): boolean {
    if (!media) {
      return false;
    }

    if (
      reviewState === 'requested_media_paused' ||
      reviewState === 'requested_media_mismatch' ||
      reviewState === 'ad_visible' ||
      reviewState === 'network_issue' ||
      this.mediaReviewIndicatesEnded(summaryText, media)
    ) {
      return false;
    }

    const normalizedPlayerState = (observation?.playerState || '').toLowerCase();
    if (
      reviewState === 'requested_media_active' ||
      reviewState === 'meeting_active' ||
      this.isActiveMediaPlaybackSummary(summaryText)
    ) {
      return true;
    }

    if (normalizedPlayerState === 'playing') {
      return true;
    }

    const observedPositionMs = observation?.positionMs;
    const previousPositionMs =
      media.observedPositionMs ?? media.maxObservedPositionMs ?? 0;
    if (observedPositionMs !== undefined && observedPositionMs >= previousPositionMs + 750) {
      return true;
    }

    return this.isNativeMediaSessionActivelyPlaying(media, nativeState || null);
  }

  private shouldLatchMediaCompletion(
    media: NonNullable<TaskSecurityState['media']> | undefined,
    reviewState: MediaReviewState,
    summaryText: string,
    observation?: {
      positionMs?: number;
      durationMs?: number;
      title?: string;
      channel?: string;
      playerState?: string;
    },
  ): boolean {
    if (!media?.selectedAt) {
      return false;
    }

    if (this.hasLatchedMediaCompletion(media, summaryText)) {
      return true;
    }

    if (media.kind === 'meeting') {
      return reviewState === 'meeting_ended';
    }

    return (
      this.countMediaCompletionSignals(
        media,
        reviewState,
        summaryText,
        observation,
      ) >= 2
    );
  }

  private inferTerminalMediaStateFromNativeSession(
    media: NonNullable<TaskSecurityState['media']> | undefined,
    nativeState: DesktopMediaSessionState | null,
    audioStatus: DesktopAudioStatus,
  ): { reviewState: MediaReviewState; summary: string } | null {
    if (!media || media.kind === 'meeting' || !media.playbackVerifiedAt) {
      return null;
    }

    const session = nativeState?.session;
    if (!session?.available) {
      return null;
    }

    const nativeObservation = this.buildMediaObservationFromNativeSession(
      media,
      nativeState,
    );
    const normalizedCurrentTitle = this.normalizeMediaIdentityText(
      nativeObservation.title,
    );
    const normalizedObservedTitle = this.normalizeMediaIdentityText(
      media.observedTitle,
    );
    const normalizedCurrentUrl = this.normalizeMediaIdentityText(session.url);
    const normalizedObservedUrl = this.normalizeMediaIdentityText(
      media.observedUrl,
    );
    const durationMs =
      nativeObservation.durationMs || media.observedDurationMs || undefined;
    const maxObservedPositionMs =
      nativeObservation.maxObservedPositionMs || media.maxObservedPositionMs || 0;
    const positionMs =
      nativeObservation.positionMs ?? media.observedPositionMs ?? undefined;
    const reachedNearEnd =
      durationMs !== undefined &&
      maxObservedPositionMs >= Math.max(8000, durationMs - 5000);
    const resetToBeginning =
      positionMs !== undefined &&
      positionMs <= 4000 &&
      reachedNearEnd;
    const currentlyNearEnd =
      durationMs !== undefined &&
      positionMs !== undefined &&
      positionMs >= Math.max(8000, durationMs - 2500);
    const titleChanged =
      !!normalizedCurrentTitle &&
      !!normalizedObservedTitle &&
      normalizedCurrentTitle !== normalizedObservedTitle;
    const urlChanged =
      !!normalizedCurrentUrl &&
      !!normalizedObservedUrl &&
      normalizedCurrentUrl !== normalizedObservedUrl;
    const status = (session.status || '').toLowerCase();
    const stopAfterRequestedMedia = media.continueWithRelatedMedia !== true;

    if (
      stopAfterRequestedMedia &&
      (titleChanged || urlChanged) &&
      (status === 'playing' ||
        audioStatus.hasSignal ||
        reachedNearEnd ||
        resetToBeginning)
    ) {
      return {
        reviewState: 'follow_on_media',
        summary: `MEDIA_STATE=follow_on_media Native media session moved from the requested item to "${nativeObservation.title || session.url || 'another media item'}" while playback continued.`,
      };
    }

    if (resetToBeginning) {
      return {
        reviewState: 'requested_media_ended',
        summary:
          'MEDIA_STATE=requested_media_ended Native media session reset to the beginning after reaching the end of the requested media.',
      };
    }

    if (
      stopAfterRequestedMedia &&
      (status === 'stopped' || status === 'paused') &&
      (reachedNearEnd || currentlyNearEnd || maxObservedPositionMs >= 15000)
    ) {
      return {
        reviewState: 'requested_media_ended',
        summary:
          status === 'paused'
            ? 'MEDIA_STATE=requested_media_ended Native media session reached the end of the requested item and paused there.'
            : 'MEDIA_STATE=requested_media_ended Native media session reported that playback stopped after the requested item finished.',
      };
    }

    if (
      stopAfterRequestedMedia &&
      !audioStatus.hasSignal &&
      (reachedNearEnd || currentlyNearEnd) &&
      status !== 'playing'
    ) {
      return {
        reviewState: 'requested_media_ended',
        summary:
          'MEDIA_STATE=requested_media_ended Native media session indicates the requested item reached its end and is no longer actively progressing.',
      };
    }

    return null;
  }

  private stripBrowserMediaSuffix(value?: string): string | undefined {
    const trimmed = (value || '').trim();
    if (!trimmed) {
      return undefined;
    }

    return trimmed
      .replace(/\s+-\s+(youtube|brave|mozilla firefox|firefox|google chrome)$/i, '')
      .trim();
  }

  private normalizeMediaIdentityText(value?: string): string {
    return this.stripBrowserMediaSuffix(value)
      ?.toLowerCase()
      .replace(/https?:\/\//g, '')
      .replace(/^www\./, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim() || '';
  }

  private computeAudioSignatureDistance(
    previous: string | null,
    next: string | null,
  ): number | null {
    if (!previous || !next || previous.length !== next.length) {
      return null;
    }

    let totalDistance = 0;
    for (let index = 0; index < previous.length; index += 1) {
      const previousValue = parseInt(previous[index], 36);
      const nextValue = parseInt(next[index], 36);
      if (
        Number.isNaN(previousValue) ||
        Number.isNaN(nextValue)
      ) {
        return null;
      }
      totalDistance += Math.abs(previousValue - nextValue) / 35;
    }

    return totalDistance / previous.length;
  }

  private describeMediaMonitorTrigger(
    triggerReason: MediaMonitorTriggerReason,
    mediaKind: 'audio' | 'video' | 'meeting' | undefined,
    taskDescription: string,
    audioStatus: DesktopAudioStatus,
    silenceDurationMs: number,
  ): string {
    const rmsText =
      audioStatus.rmsDb === null || audioStatus.rmsDb === undefined
        ? 'unknown RMS'
        : `${audioStatus.rmsDb.toFixed(1)} dB RMS`;

    if (triggerReason === 'meeting_extended_silence_check') {
      return `Audio-first monitor detected about ${Math.round(silenceDurationMs / 1000)} seconds of silence during an active meeting task: ${taskDescription}. Perform one focused screenshot-based review now and classify the visible state before taking action. Start the review summary with one exact label: MEDIA_STATE=meeting_active, MEDIA_STATE=meeting_quiet, MEDIA_STATE=meeting_waiting, MEDIA_STATE=network_issue, MEDIA_STATE=meeting_ended, or MEDIA_STATE=unknown. Distinguish between a meeting that is still joined but quiet, a waiting room or waiting-for-host state, a reconnect or internet problem, and a real ended meeting.`;
    }

    if (triggerReason === 'playback_identity_check') {
      return `Audio-first monitor detected live audio for this task and needs one focused identity check before settling into stable monitoring: ${taskDescription}. Perform one screenshot-based review now and confirm whether the currently visible player/session is the requested media or meeting. Start the review summary with one exact label: MEDIA_STATE=requested_media_active, MEDIA_STATE=requested_media_paused, MEDIA_STATE=requested_media_mismatch, MEDIA_STATE=ad_visible, MEDIA_STATE=follow_on_media, MEDIA_STATE=requested_media_ended, MEDIA_STATE=network_issue, or MEDIA_STATE=unknown. Be strict about identity: if the visible title, artist, channel, player context, or meeting session does not match the requested task, label it MEDIA_STATE=requested_media_mismatch instead of pretending playback is correct.`;
    }

    if (triggerReason === 'prolonged_silence') {
      return `Audio-first monitor detected prolonged silence while keeping this media task running: ${taskDescription}. Silence has lasted about ${Math.round(silenceDurationMs / 1000)} seconds with ${rmsText}. Perform one focused visual state check now and start the review summary with one exact label: MEDIA_STATE=requested_media_active, MEDIA_STATE=requested_media_paused, MEDIA_STATE=requested_media_mismatch, MEDIA_STATE=ad_visible, MEDIA_STATE=follow_on_media, MEDIA_STATE=requested_media_ended, MEDIA_STATE=network_issue, or MEDIA_STATE=unknown. Distinguish between the requested media ending, a short pause, an ad, a network issue, autoplay starting a different item, or the wrong media being on screen. If the requested media already finished and a different follow-on item started, pause or close that follow-on playback immediately before finalizing.`;
    }

    if (triggerReason === 'signal_returned_after_silence') {
      return `Audio-first monitor detected that audible output returned after a meaningful silent period for this task: ${taskDescription}. The current signal is ${rmsText}. Perform one focused visual state check now and start the review summary with an exact MEDIA_STATE label so we can tell whether the requested ${mediaKind === 'meeting' ? 'meeting' : 'media'} resumed correctly, an interruption ended, or a different item started.`;
    }

    if (triggerReason === 'expected_end_check') {
      return `Audio-first monitor detected that the requested media may be near its expected end for this task: ${taskDescription}. The current signal is ${rmsText}. Perform one focused visual state check now and start the review summary with one exact label: MEDIA_STATE=requested_media_active, MEDIA_STATE=requested_media_mismatch, MEDIA_STATE=ad_visible, MEDIA_STATE=follow_on_media, MEDIA_STATE=requested_media_ended, MEDIA_STATE=network_issue, or MEDIA_STATE=unknown. If the requested media already ended, finalize the task instead of continuing to monitor blindly. If autoplay or another follow-on item has already started, pause or close that follow-on playback immediately before finalizing.`;
    }

    if (triggerReason === 'periodic_progress_check') {
      return `Audio-first monitor is doing a low-frequency progress check for this task: ${taskDescription}. The current signal is ${rmsText}. Perform one focused visual state check now and start the review summary with an exact MEDIA_STATE label so we can tell whether the requested media is still active, paused, mismatched, interrupted by an ad, or already finished. If a follow-on item is already playing after the requested media finished, stop it before finalizing.`;
    }

    return `Audio-first monitor detected a strong change in the current desktop audio pattern for this task: ${taskDescription}. The current signal is ${rmsText}. Perform one focused visual state check now and start the review summary with an exact MEDIA_STATE label so we can tell whether the requested ${mediaKind === 'meeting' ? 'meeting' : 'media'} is still active, mismatched, interrupted, or a different item has started.`;
  }

  private getTaskSecurityState(task: Task): TaskSecurityState {
    const result = (task.result || {}) as Record<string, any>;
    return (result.security || {}) as TaskSecurityState;
  }

  private getTaskUsageState(task: Task): TaskUsageState | undefined {
    const result = (task.result || {}) as Record<string, any>;
    return result.usage as TaskUsageState | undefined;
  }

  private mergeTaskResult(
    task: Task,
    patch: Record<string, unknown>,
  ): Record<string, unknown> {
    const currentResult = (task.result || {}) as Record<string, unknown>;
    return {
      ...currentResult,
      ...patch,
    };
  }

  private async recordTaskUsage(
    task: Task,
    model: BytebotAgentModel,
    response: BytebotAgentResponse,
    purpose: string,
  ): Promise<void> {
    const tokenUsage = response.tokenUsage;
    if (!tokenUsage) {
      return;
    }

    const updatedResult = this.mergeTaskResult(task, {
      usage: mergeTaskUsage(this.getTaskUsageState(task), {
        provider: model.provider,
        model: model.name,
        purpose,
        inputTokens: tokenUsage.inputTokens || 0,
        outputTokens: tokenUsage.outputTokens || 0,
        totalTokens: tokenUsage.totalTokens || 0,
      }),
    });

    await this.tasksService.update(task.id, {
      result: updatedResult,
    });
    task.result = updatedResult as any;
  }

  private async restoreSavedBrowserSessionIfNeeded(
    task: Task,
    security: TaskSecurityState,
  ): Promise<void> {
    const browserSession = security.browserSession;
    if (!browserSession?.restoreLabel || browserSession.restoredAt) {
      return;
    }

    const normalizedBrowser =
      browserSession.browser === 'firefox' ? 'brave' : browserSession.browser;

    const restored = await this.browserSessionsService.restore({
      label: browserSession.restoreLabel,
      site: browserSession.site,
      browser: normalizedBrowser,
    });

    if (!restored) {
      return;
    }

    const updatedResult = this.mergeTaskResult(task, {
      security: {
        ...security,
        browserSession: {
          ...browserSession,
          ...(normalizedBrowser && { browser: normalizedBrowser }),
          restoredAt: new Date().toISOString(),
        },
      },
    });

    await this.tasksService.update(task.id, {
      result: updatedResult,
    });
    task.result = updatedResult as any;
  }

  private buildRuntimeSecurityContext(
    task: Task,
    taskId: string,
    security: TaskSecurityState,
  ): string | null {
    const instructions: string[] = [];
    const secretInstructions =
      this.taskSecretsService.buildRuntimeInstructions(taskId);
    if (secretInstructions) {
      instructions.push(secretInstructions);
    }

    if (security.session?.keepAliveUntilUserDone) {
      if (security.session?.currentTurnGoal?.trim()) {
        instructions.push(
          `The active goal for this turn is: ${security.session.currentTurnGoal.trim()}. Treat this as the main outcome to finish now, even if the original task title was broader or from an earlier turn.`,
        );
      }
      instructions.push(
        'This task uses a persistent session. When you would normally finish, fail, or ask for help, provide a concise summary of what happened and hand the task back for user follow-up instead of treating the whole task as permanently closed.',
      );
      instructions.push(
        'For resumed or follow-up work in this persistent session, inspect the current browser or app state first, but reuse it only if it directly supports the current turn goal. Do not let a stale page, old inbox, old search result, previous task form, or login screen redefine the goal for this turn. If the visible state is wrong, expired, blocked, contradictory, or clearly from a different task, navigate back to the right flow instead of forcing the current page to fit.',
      );
      instructions.push(
        'Only consider the task truly complete when the user explicitly says done, stop, complete, close, or otherwise confirms the session should end.',
      );
      instructions.push(
        'If the requested work for this turn is already done and the visible result is ready, report that outcome as completed work even if you end with a follow-up invitation like "what would you like to do next?". Do not use needs_help just because the session remains open for more instructions.',
      );
      instructions.push(
        'If desktop execution gets stuck, loops, or drifts from the goal, replan from the blocked step and current page context. Do not hand the task back to the user unless a truly sensitive irreversible action or a human-only challenge requires attention.',
      );
    }

    if ((security.execution?.suppressedContinuationPromptCount || 0) > 0) {
      instructions.push(
        'A previous low-risk "should I proceed" follow-up was suppressed automatically. Do not ask for permission again for ordinary navigation, form-filling, date selection, filtering, or search actions. Continue automatically unless the next action is genuinely sensitive, irreversible, or blocked by a human-only challenge.',
      );
    }

    if (security.browserSession?.restoreLabel) {
      instructions.push(
        `A saved browser session labeled "${security.browserSession.restoreLabel}" is available for this task${security.browserSession.restoredAt ? ' and has already been restored' : ''}. Reuse it before asking the user to sign in again.`,
      );
    }

    if (security.browserSession?.restoreReason === 'inferred_open_session') {
      instructions.push(
        'The saved browser session for this task was inferred only as a possibly helpful account surface. Reuse it only if the visible page directly supports the current turn goal. If the restored page is an unrelated inbox, account page, search result, or stale login state, ignore that stale page and continue from the user goal instead of forcing the current state to fit.',
      );
      instructions.push(
        'Do not sign in, type credentials, or continue account-specific flows just because a restored session exists. Only do that if the current turn goal explicitly requires it and the visible provider clearly matches.',
      );
    } else if (security.browserSession?.restoreReason === 'inferred_auth') {
      instructions.push(
        'The saved browser session for this task was inferred because the user goal appears account-specific. Still verify that the visible provider and page match the current turn goal before continuing any login or inbox flow.',
      );
    }

    if (security.browserSession?.restoreLabel && secretInstructions) {
      instructions.push(
        'If the restored browser session still shows a login page, treat that as an expired session and use the secure placeholders already available for this task to sign in. Do not open any external password manager for this task.',
      );
      instructions.push(
        'Do not say that login details are missing when secure placeholders are already available for this task. If the site shows a sign-in page, continue the normal login flow automatically with those placeholders unless the next action is genuinely risky like Send, payment, booking, delete, or final submit.',
      );
    } else if (security.browserSession?.restoreLabel) {
      instructions.push(
        'If the restored browser session still shows a login page and there are no secure placeholders available, explain that the saved session appears expired and ask the user for help or fresh login details. Do not open any external password manager on your own.',
      );
    }

    if (security.postConfirmationReview) {
      instructions.push(
        'A send or submit action was already approved and executed. Do not type in compose or form fields again unless the screen clearly shows the action failed. Only verify the outcome, then complete the task or ask for help.',
      );
    }

    if (security.execution?.driftCount) {
      instructions.push(
        `Recent desktop execution drift has been detected ${security.execution.driftCount} time(s). If a structured execution trace reports status "drifted", reset to a clean page or form state before retrying. Validate extracted facts against the user's exact target values.`,
      );
    }

    if (security.execution?.completedSteps?.length) {
      instructions.push(
        `Execution progress already completed: ${security.execution.completedSteps.join(' | ')}. Do not repeat those steps unless the current page clearly shows they must be redone.`,
      );
    }

    if (
      security.execution?.lastOpenedApplication &&
      security.execution?.lastApplicationOpenedAt
    ) {
      instructions.push(
        `The ${security.execution.lastOpenedApplication} application was already opened or focused recently. Do not reopen it from a desktop icon or restart it unless the current window is clearly missing or unusable.`,
      );
    }

    if (security.execution?.skippedSteps?.length) {
      instructions.push(
        `Some steps were already satisfied by useful existing context and were intentionally skipped: ${security.execution.skippedSteps.join(' | ')}. Continue from that relevant state instead of resetting unnecessarily.`,
      );
    }

    if (security.execution?.blockedStep) {
      instructions.push(
        `CU is currently blocked on "${security.execution.blockedStep.description}". Reason: ${security.execution.blockedStep.reason}. It has already retried ${security.execution.blockedStep.retries} time(s). Replan only this blocked step from the current state. Do not restart the entire task or repeat already completed steps.${security.execution.blockedStep.currentUrl ? ` Current URL: ${security.execution.blockedStep.currentUrl}.` : ''}${security.execution.blockedStep.lastVisibleSummary ? ` Latest visible state: ${security.execution.blockedStep.lastVisibleSummary}.` : ''}`,
      );
      instructions.push(
        'A watchdog detected a genuine execution issue. Provide one focused recovery step that fixes the blocked state quickly, then let the executor resume normal execution if recovery succeeds.',
      );
    }

    if (security.execution?.watchdog?.activeRecovery) {
      instructions.push(
        `Watchdog recovery is active for this task${security.execution.watchdog.lastTriggerReason ? ` because it detected ${security.execution.watchdog.lastTriggerReason.replace(/_/g, ' ')}` : ''}. Keep recovery focused to a single corrective step and return to normal execution immediately after the issue is resolved.`,
      );
    }

    if (security.preflight?.confirmedAt) {
      instructions.push(
        `The task has already passed preflight${security.preflight.plan ? ` with this plan: ${security.preflight.plan}` : ''}. Do not ask another startup question unless a new blocker appears.`,
      );
    }

    if (security.media?.selectedAt) {
      instructions.push(
        `This is a ${security.media.kind || 'media'} task. The selected mode is "${security.media.selectedModeLabel || 'default media mode'}". Always verify actual playback or meeting join state on screen before claiming success.`,
      );
      if (security.media.route && security.media.route !== 'unsupported_media') {
        const chosenPlatform =
          security.media.kind === 'meeting'
            ? security.media.platform === 'zoom'
              ? 'Zoom'
              : security.media.platform === 'teams'
                ? 'Microsoft Teams'
                : 'Google Meet'
            : this.buildSupportedVideoSurfacePhrase(task.description);
        instructions.push(
          `Route this task only through ${chosenPlatform}. If the screen is on any other site or platform during opening or recovery, treat that as wrong-surface drift and recover back to ${chosenPlatform} instead of continuing there.`,
        );
      }
      instructions.push(
        'Follow this media sequence strictly: open the correct requested media or meeting, handle ads or interstitials, confirm the requested session is actively playing or joined, and then switch into stable monitoring instead of wandering into extra UI.',
      );
      instructions.push(
        `Keep media-opening behavior concise and stateful: if ${this.buildChosenMediaSurfacePhrase(task.description)} is already open and useful, continue from that current page instead of reopening it. If the search box, relevant results, or the requested player is already visible, use that state instead of reloading the homepage.`,
      );
      instructions.push(
        `Do not repeat the same media search query, homepage navigation, or page-settle wait once it has already been tried and the current screen still shows the same ${this.buildChosenMediaSurfacePhrase(task.description)} flow. Move forward from the visible state instead of restarting the same opening action.`,
      );
      instructions.push(
        'Before starting the requested media, pause or close any unrelated audio or video that is already playing in another tab, window, or app so only the requested item remains active for recording and transcript capture.',
      );
      instructions.push(
        'A paused player, search results page, blank player, or merely visible media title is not enough. If playback is paused or not clearly started yet, resume it and confirm progress before moving on.',
      );
      instructions.push(
        'When the player shows visible timing or duration, capture that timing in your review summary or extracted facts so end-of-media detection can use the real player duration instead of guessing.',
      );
      instructions.push(
        'Once playback is confirmed and a visible or native player duration is known, use that observed duration as the real end-of-media clock. Near the expected end, do one focused check, and if autoplay or another follow-on item starts when the user did not ask for related media, stop that follow-on playback before finalizing.',
      );
      instructions.push(
        'For YouTube and other media sites, skip ads when possible. If an ad is unskippable, wait through it and continue instead of completing early.',
      );
      if (security.media.kind === 'meeting') {
        instructions.push(
          'For meetings, prolonged silence is not an automatic end. If there is about 90 seconds of silence, do one focused screenshot-based review. End the task only if the meeting visibly ended; otherwise remain in quiet monitoring.',
        );
      }

      if (security.media.keepRunningUntilDone) {
        instructions.push(
          'Keep this task running while the requested media or meeting is still active. Do not complete immediately after playback starts or after the meeting joins. Use occasional low-frequency checks, and complete only when the media or meeting has clearly ended, the user tells you to stop, or an unrecoverable error occurs.',
        );
        instructions.push(
          'When playback or attendance has already been verified and audio-first monitoring is active, do not request extra screenshots or transcript hunts just to keep checking. Wait for a monitor trigger note before doing another focused visual review.',
        );
      } else {
        instructions.push(
          'The user only asked you to start or attend the media session, not to stay for the full duration. Confirm that playback or meeting attendance actually started before completing.',
        );
      }

      if (security.media.transcriptRequested || security.media.summaryRequested) {
        instructions.push(
          'Do not hunt for transcript, captions, subtitles, or meeting-notes UI for this task. Once playback or attendance is visibly confirmed, keep the session stable so audio-first monitoring and recording can capture the source material cleanly.',
        );
        instructions.push(
          'If transcript or summary was requested, rely on recorded task audio for Gemini transcript and summary generation after the requested media or meeting ends.',
        );
        instructions.push(
          'As soon as the requested media page is open and playback has started or the meeting audio is clearly live, start recording automatically. Do not restart playback, search again, or chase autoplay after the requested item has already finished.',
        );
      }

      if (security.media.kind !== 'meeting') {
        instructions.push(
          'For song, music, podcast, or general video tasks, prefer keeping playback stable over opening extra menus. Do not derail playback by repeatedly hunting for transcript UI unless the transcript request is explicit and the control is clearly visible.',
        );
      }

      instructions.push(
        'On completed, needs_help, or failed states, always provide a short summary of what happened so far.',
      );

      if (security.media.audioMonitoring?.mode === 'audio_first') {
        instructions.push(
          'Audio-first monitoring is active for this task. Treat any audio monitor note as the only reason to do another visual check during stable playback or attendance. When such a note appears, do one focused review and start the summary with an exact MEDIA_STATE label. For media, use requested_media_active, requested_media_paused, requested_media_mismatch, ad_visible, follow_on_media, requested_media_ended, network_issue, or unknown. For meetings, use meeting_active, meeting_quiet, meeting_waiting, meeting_ended, network_issue, or unknown. When reviewing media, verify that the visible title, artist, channel, or player context still matches the requested item; if it does not, use requested_media_mismatch. Silence alone does not prove a meeting ended.',
        );
      }
    }

    const taskDescription = task.description.toLowerCase();
    const isTravelSearch =
      /(flight|flights|google flights|hotel|train|booking|trip)/i.test(
        taskDescription,
      );

    if (isTravelSearch) {
      instructions.push(
        'For travel and other stateful search forms, use larger boundary steps. First inspect the current page state. If visible route, trip type, or date values already match or partially match the user request, keep and extend them instead of resetting the form. Only clear or overwrite values that clearly contradict the requested search. Then fill route and trip type together, then set dates and launch the search together, then review results. Validate visible facts after each boundary instead of narrating every tiny click.',
      );
      instructions.push(
        'Do not summarize prices, cheapest options, or visible results until an execution trace or screenshot confirms the actual results page is on screen.',
      );
    }

    if (security.execution?.resultReview?.pending) {
      if (security.execution.resultReview.completedAt) {
        instructions.push(
          'A final on-screen result review checkpoint has already been captured. If you have not taken any additional actions since then, use that reviewed state to summarize and complete accurately.',
        );
      } else {
        instructions.push(
          'Before completing this task, execute one final result-review desktop step that inspects the current visible result or confirmation state and verifies the key facts needed for the final answer.',
        );
      }
    }

    return instructions.length > 0 ? instructions.join(' ') : null;
  }

  private async runPreflightIfNeeded(
    task: Task,
    messages: Message[],
    model: BytebotAgentModel,
  ): Promise<'continue' | 'paused'> {
    if (task.createdBy !== Role.USER) {
      return 'continue';
    }

    const security = this.getTaskSecurityState(task);
    const preflight = security.preflight || {};
    if (preflight.confirmedAt && !preflight.followUpPending) {
      return 'continue';
    }

    if (this.isMediaTask(task.description)) {
      if (!preflight.awaitingUserResponse) {
        const inferredPreferences = this.parseMediaPreferenceText(
          task,
          task.description,
          security,
        );
        if (inferredPreferences.complete) {
          const updatedResult = this.mergeTaskResult(task, {
            security: {
              ...security,
              media: inferredPreferences.preferences,
              preflight: {
                ...preflight,
                awaitingUserResponse: false,
                followUpPending: false,
                question: '',
                plan: this.buildMediaPreflightPlan(task),
                planSteps: this.plannerPlanCompiler.derivePlanStepsFromPlanText(
                  this.buildMediaPreflightPlan(task),
                ),
                guidelines:
                  preflight.guidelines?.length
                    ? preflight.guidelines
                    : this.defaultPlannerGuidelines(),
                reason: 'clarification',
                askedAt: preflight.askedAt,
                confirmedAt: new Date().toISOString(),
              },
            },
          });

          await this.tasksService.update(task.id, {
            result: updatedResult,
          });
          task.result = updatedResult as any;

          return 'continue';
        }
      }

      if (!preflight.awaitingUserResponse) {
        const mediaPlan = this.buildMediaPreflightPlan(task);
        await this.pauseForPreflight(
          task,
          'clarification',
          this.buildMediaPreflightQuestion(task),
          mediaPlan,
          this.plannerPlanCompiler.derivePlanStepsFromPlanText(mediaPlan),
          {
            media: {
              ...(security.media || {}),
              kind: this.detectMediaKind(task.description),
              route: this.detectMediaRoute(task.description),
              platform: this.detectMediaPlatform(task.description),
              askedAt: new Date().toISOString(),
              selectedAt: undefined,
            },
            session: {
              ...(security.session || {}),
              mode:
                this.detectMediaKind(task.description) === 'meeting'
                  ? 'meeting'
                  : 'media',
            },
            preflight: {
              guidelines:
                preflight.guidelines?.length
                  ? preflight.guidelines
                  : this.defaultPlannerGuidelines(),
            },
          },
        );
        return 'paused';
      }

      const mediaPreflightReply = this.parseMediaPreflightReply(task, messages);
      if (!mediaPreflightReply.complete) {
        const latestReply = this.getRealUserTextSince(
          messages,
          preflight.askedAt,
        );
        const fallbackPreferences =
          this.buildFallbackMediaPreferencesAfterSingleQuestion(
            task,
            `${task.description}\n${latestReply || ''}`,
            security,
          );

        this.logger.warn(
          `Media preflight reply stayed incomplete for task ${task.id}; applying conservative defaults instead of asking a second startup question.`,
        );

        const updatedResult = this.mergeTaskResult(task, {
          security: {
            ...security,
            media: fallbackPreferences,
            preflight: {
              ...preflight,
              awaitingUserResponse: false,
              followUpPending: false,
              question: preflight.question,
              plan: preflight.plan || this.buildMediaPreflightPlan(task),
              planSteps:
                preflight.planSteps?.length
                  ? preflight.planSteps
                  : this.plannerPlanCompiler.derivePlanStepsFromPlanText(
                      preflight.plan || this.buildMediaPreflightPlan(task),
                    ),
              guidelines:
                preflight.guidelines?.length
                  ? preflight.guidelines
                  : this.defaultPlannerGuidelines(),
              reason: preflight.reason || 'clarification',
              askedAt: preflight.askedAt,
              confirmedAt: new Date().toISOString(),
            },
          },
        });

        await this.tasksService.update(task.id, {
          result: updatedResult,
        });
        task.result = updatedResult as any;

        return 'continue';
      }

      const mediaPreferences = mediaPreflightReply.preferences;
      const updatedResult = this.mergeTaskResult(task, {
        security: {
          ...security,
          media: mediaPreferences,
          preflight: {
            ...preflight,
            awaitingUserResponse: false,
            followUpPending: false,
            question: preflight.question,
            plan: preflight.plan || this.buildMediaPreflightPlan(task),
            planSteps:
              preflight.planSteps?.length
                ? preflight.planSteps
                : this.plannerPlanCompiler.derivePlanStepsFromPlanText(
                    preflight.plan || this.buildMediaPreflightPlan(task),
                  ),
            guidelines:
              preflight.guidelines?.length
                ? preflight.guidelines
                : this.defaultPlannerGuidelines(),
            reason: preflight.reason || 'clarification',
            askedAt: preflight.askedAt,
            confirmedAt: new Date().toISOString(),
          },
        },
      });

      await this.tasksService.update(task.id, {
        result: updatedResult,
      });
      task.result = updatedResult as any;

      return 'continue';
    }

    const service = this.services[model.provider];
    if (!service) {
      return 'continue';
    }

    const phasePrompt = preflight.awaitingUserResponse
      ? 'This is a follow-up preflight pass. The assistant already asked for missing information and the user has replied. Decide whether execution can start now. If enough information is available, choose proceed.'
      : preflight.followUpPending
        ? 'This is the first preflight pass for a follow-up turn inside an already open session. Ask only if the task is missing required information or needs explicit approval for a clearly irreversible action. Otherwise choose proceed.'
        : 'This is the first preflight pass for a new task. Ask only if the task is missing required information or needs explicit approval for a clearly irreversible action. Otherwise choose proceed.';

    const preflightMessages = [
      ...messages,
      {
        id: '',
        createdAt: new Date(),
        updatedAt: new Date(),
        taskId: task.id,
        summaryId: null,
        role: Role.USER,
        content: [
          {
            type: MessageContentType.Text,
            text: phasePrompt,
          },
        ],
      } as Message,
    ];

    const preflightResponse = await service.generateMessage(
      PREFLIGHT_SYSTEM_PROMPT,
      preflightMessages,
      model.name,
      false,
      this.abortController?.signal,
    );
    await this.recordTaskUsage(task, model, preflightResponse, 'preflight');
    const preflightText = this.getCombinedTextContent(
      preflightResponse.contentBlocks,
    );
    let parsed = this.parsePreflightResponse(preflightText);

    if (!parsed) {
      if (preflight.awaitingUserResponse) {
        this.logger.warn(
          `Preflight response could not be parsed for follow-up task ${task.id}; proceeding to execution to avoid a clarification loop.`,
        );
        parsed = {
          decision: 'proceed',
          reason: preflight.reason || 'clarification',
          question: '',
          plan:
            preflight.plan ||
            'Begin executing the task with the clarified details the user already provided.',
          planSteps:
            preflight.planSteps?.length
              ? preflight.planSteps
              : this.plannerPlanCompiler.refinePlannerStepsForGoal(
                  this.getCurrentTurnGoal(task),
                  this.plannerPlanCompiler.deriveGoalOnlyPlanCandidates(this.getCurrentTurnGoal(task)),
                ),
          guidelines:
            preflight.guidelines?.length
              ? preflight.guidelines
              : this.defaultPlannerGuidelines(),
        };
      } else {
        this.logger.warn(
          `Preflight response could not be parsed for task ${task.id}; falling back to clarification pause.`,
        );
        await this.pauseForPreflight(
          task,
          'clarification',
          'I need one key detail before I start. Please clarify the exact outcome you want for this task.',
          'Start the task after the missing detail is provided.',
          this.plannerPlanCompiler.refinePlannerStepsForGoal(
            this.getCurrentTurnGoal(task),
            this.plannerPlanCompiler.deriveGoalOnlyPlanCandidates(this.getCurrentTurnGoal(task)),
          ),
          {
            preflight: {
              guidelines: this.defaultPlannerGuidelines(),
            },
          },
        );
        return 'paused';
      }
    }

    parsed = this.applyTravelPreflightDefaults(task, parsed);
    parsed = this.normalizeLowRiskPreflightDecision(task, parsed);
    parsed = this.normalizeFollowUpPreflightDecision(task, security, parsed);
    parsed = this.normalizeInSessionFollowUpPreflightDecision(
      task,
      security,
      parsed,
    );

    if (parsed.decision === 'proceed') {
      const mediaPreferences = this.resolveMediaPreferencesForProceed(
        task,
        messages,
        security,
      );
      const updatedResult = this.mergeTaskResult(task, {
        security: {
          ...security,
          ...(mediaPreferences
            ? {
                media: mediaPreferences,
                session: {
                  ...(security.session || {}),
                  mode:
                    mediaPreferences.kind === 'meeting' ? 'meeting' : 'media',
                },
              }
            : {}),
          preflight: {
            ...preflight,
            turnId:
              preflight.turnId ||
              (preflight.followUpPending ? this.createPlannerTurnId() : undefined),
            turnKind:
              preflight.turnKind ||
              (preflight.followUpPending ? 'follow_up' : 'initial'),
            questionAsked: Boolean(preflight.question),
            questionAnswered: Boolean(preflight.question),
            executionStarted: false,
            awaitingUserResponse: false,
            followUpPending: false,
            question: parsed.question || preflight.question || '',
            plan:
              parsed.plan ||
              preflight.plan ||
              'Begin executing the task with the clarified details already provided.',
            planSteps:
              parsed.planSteps?.length
                ? parsed.planSteps
                : preflight.planSteps?.length
                  ? preflight.planSteps
                  : this.plannerPlanCompiler.derivePlanStepsFromPlanText(
                      parsed.plan ||
                        preflight.plan ||
                        'Begin executing the task with the clarified details already provided.',
                    ),
            guidelines:
              parsed.guidelines?.length
                ? parsed.guidelines
                : preflight.guidelines?.length
                  ? preflight.guidelines
                  : this.defaultPlannerGuidelines(),
            reason: parsed.reason,
            askedAt: preflight.askedAt,
            confirmedAt: new Date().toISOString(),
          },
        },
      });

      await this.tasksService.update(task.id, {
        result: updatedResult,
      });
      task.result = updatedResult as any;

      return 'continue';
    }

    if (!parsed.question) {
      this.logger.warn(
        `Preflight asked for more details without a question for task ${task.id}; using clarification fallback.`,
      );
      await this.pauseForPreflight(
        task,
        'clarification',
        'I need one key detail before I start. Please clarify the most important missing detail for this task.',
        parsed.plan || 'Start the task after the missing detail is provided.',
        parsed.planSteps,
        {
          preflight: {
            guidelines:
              parsed.guidelines?.length
                ? parsed.guidelines
                : this.defaultPlannerGuidelines(),
          },
        },
      );
      return 'paused';
    }

    await this.pauseForPreflight(
      task,
      parsed.reason,
      parsed.question,
      parsed.plan || 'Start the task after the missing detail is provided.',
      parsed.planSteps,
      {
        preflight: {
          guidelines:
            parsed.guidelines?.length
              ? parsed.guidelines
              : this.defaultPlannerGuidelines(),
        },
      },
    );
    return 'paused';
  }

  private async pauseForPreflight(
    task: Task,
    reason: 'confirmation' | 'clarification',
    question: string,
    plan: string,
    planSteps?: string[],
    extraSecurityPatch?: Partial<TaskSecurityState>,
  ): Promise<void> {
    const existingSecurity = this.getTaskSecurityState(task);
    const askedAt =
      extraSecurityPatch?.preflight?.askedAt ||
      (existingSecurity.preflight?.awaitingUserResponse &&
      existingSecurity.preflight.askedAt
        ? existingSecurity.preflight.askedAt
        : new Date().toISOString());

    await this.messagesService.create({
      role: Role.ASSISTANT,
      taskId: task.id,
      content: [
        {
          type: MessageContentType.Text,
          text: question,
        },
      ],
    });

    await this.tasksService.update(task.id, {
      status: TaskStatus.NEEDS_REVIEW,
      result: this.mergeTaskResult(task, {
        security: {
          ...applySessionActiveBranch(
            {
              ...existingSecurity,
              ...extraSecurityPatch,
            },
            'preflight_wait',
            {
              keepAliveUntilUserDone: true,
              phase: 'waiting_user',
              mode:
                this.isMediaTask(task.description)
                  ? this.detectMediaKind(task.description) === 'meeting'
                    ? 'meeting'
                    : 'media'
                  : existingSecurity.session?.mode || 'normal',
              awaitingUserDecision: true,
            },
          ),
          preflight: {
            ...(existingSecurity.preflight || {}),
            ...(extraSecurityPatch?.preflight || {}),
            turnId:
              extraSecurityPatch?.preflight?.turnId ||
              existingSecurity.preflight?.turnId ||
              this.createPlannerTurnId(),
            turnKind:
              extraSecurityPatch?.preflight?.turnKind ||
              existingSecurity.preflight?.turnKind ||
              'initial',
            questionAsked: true,
            questionAnswered: false,
            executionStarted: false,
            awaitingUserResponse: true,
            followUpPending: false,
            question,
            plan,
            planSteps:
              planSteps?.length
                ? planSteps
                : extraSecurityPatch?.preflight?.planSteps ||
                  existingSecurity.preflight?.planSteps,
            guidelines:
              extraSecurityPatch?.preflight?.guidelines?.length
                ? extraSecurityPatch.preflight.guidelines
                : existingSecurity.preflight?.guidelines?.length
                  ? existingSecurity.preflight.guidelines
                  : this.defaultPlannerGuidelines(),
            reason,
            askedAt,
            confirmedAt: undefined,
          },
        },
      }),
    });
    this.releaseProcessingLease(task.id);
  }

  private async handleTerminalTaskStatus(
    task: Task,
    terminalStatus: 'completed' | 'failed' | 'needs_help',
    summaryText: string,
  ): Promise<void> {
    if (
      terminalStatus !== 'failed' &&
      this.shouldDeferImplicitActiveMediaTerminal(task, summaryText)
    ) {
      const security = this.getTaskSecurityState(task);
      const suppressedCount =
        security.execution?.suppressedContinuationPromptCount || 0;
      if (suppressedCount >= 2) {
        const recovered = await this.queueAutomaticMediaRecoveryStepIfNeeded(
          task.id,
          task,
          {
            summaryText,
            reason:
              'The planner tried to finish an active media session before a stable end state was actually visible.',
          },
        );
        if (recovered) {
          if (this.isProcessing) {
            setTimeout(() => this.runIteration(task.id), 0);
          }
          return;
        }
        terminalStatus = 'failed';
        summaryText =
          'The media session was still active, but the planner kept attempting to finish early and no safe automatic recovery remained.';
      } else {
        const updatedResult = this.mergeTaskResult(task, {
          security: {
            ...security,
            execution: {
              ...(security.execution || {}),
              suppressedContinuationPromptCount: suppressedCount + 1,
              lastSuppressedContinuationPrompt: summaryText,
              lastSuppressedContinuationAt: new Date().toISOString(),
            },
          },
        });
        await this.tasksService.update(task.id, {
          result: updatedResult,
        });
        task.result = updatedResult as any;

        this.logger.log(
          `Deferred terminal media status for task ${task.id} because the requested media session is still active`,
        );
        if (this.isProcessing) {
          setTimeout(() => this.runIteration(task.id), 1000);
        }
        return;
      }
    }

    terminalStatus = this.normalizeTerminalStatus(
      task,
      terminalStatus,
      summaryText,
    );

    const security = this.getTaskSecurityState(task);
    const session = security.session || {
      keepAliveUntilUserDone: true,
      phase: 'active',
      activeBranch: 'executing' as SessionActiveBranch,
      awaitingUserDecision: false,
    };

    let nextSecurity: TaskSecurityState = {
      ...security,
      pendingConfirmation: undefined,
      postConfirmationReview: undefined,
      execution: {
        ...(security.execution || {}),
        resultReview: {
          ...(security.execution?.resultReview || {}),
          pending: false,
        },
      },
    };

    const shouldKeepSessionOpen = session.keepAliveUntilUserDone !== false;

    if (shouldKeepSessionOpen && terminalStatus === 'completed') {
      const mediaBeforeFinalization = nextSecurity.media;
      if (
        mediaBeforeFinalization?.selectedAt &&
        mediaBeforeFinalization.kind !== 'meeting' &&
        (
          mediaBeforeFinalization.playbackVerifiedAt ||
          mediaBeforeFinalization.completionLatchedAt
        )
      ) {
        await this.pauseDesktopPlaybackIfPossible();
      }

      if (
        mediaBeforeFinalization?.selectedAt &&
        mediaBeforeFinalization.recordingStartedAt &&
        !mediaBeforeFinalization.recordingStoppedAt &&
        mediaBeforeFinalization.playbackVerifiedAt &&
        mediaBeforeFinalization.phase !== 'opening' &&
        mediaBeforeFinalization.phase !== 'transcribing' &&
        mediaBeforeFinalization.transcriptionStatus !== 'ready'
      ) {
        nextSecurity = {
          ...nextSecurity,
          media: {
            ...mediaBeforeFinalization,
            phase: 'transcribing',
            transcriptionStatus: 'transcribing',
          },
        };

        const interimResult = this.mergeTaskResult(task, {
          security: nextSecurity,
        });

        await this.tasksService.update(task.id, {
          result: interimResult,
        });
        task.result = interimResult as any;

        await this.emitMediaProgressUpdate(
          task,
          'The requested media has ended. Finalizing the recording and generating the transcript now.',
        );
      }

      const mediaFinalization = await this.mediaSessionService.finalizeMediaSession(
        task.id,
        task,
        nextSecurity,
      );

      if (mediaFinalization.media) {
        nextSecurity = {
          ...nextSecurity,
          media: mediaFinalization.media,
        };
      }

      if (
        mediaFinalization.media?.transcriptionStatus === 'ready' &&
        mediaBeforeFinalization?.transcriptionStatus !== 'ready'
      ) {
        await this.emitMediaProgressUpdate(
          task,
          'Transcript and summary are ready. Parking the task for your review now.',
        );
      } else if (
        mediaFinalization.media?.transcriptionStatus === 'failed' &&
        mediaFinalization.media?.transcriptionError
      ) {
        await this.emitMediaProgressUpdate(
          task,
          `Transcript generation failed: ${mediaFinalization.media.transcriptionError}`,
        );
      }

      const parkedSummary = this.buildSessionParkingSummary(
        task,
        terminalStatus,
        summaryText,
        mediaFinalization,
      );

      await this.messagesService.create({
        role: Role.ASSISTANT,
        taskId: task.id,
        content: [
          {
            type: MessageContentType.Text,
            text: parkedSummary,
          },
        ],
      });

      await this.tasksService.update(task.id, {
        status: TaskStatus.NEEDS_REVIEW,
        result: this.mergeTaskResult(task, {
          security: applySessionActiveBranch(nextSecurity, 'parked_result', {
            ...session,
            phase: 'waiting_user',
            awaitingUserDecision: true,
            lastTerminalStatus: terminalStatus,
            lastTerminalSummary: parkedSummary,
            parkedAt: new Date().toISOString(),
          }),
        }),
      });
      this.releaseProcessingLease(task.id);
      return;
    }

    if (terminalStatus === 'needs_help') {
      const helpSummary = this.buildSessionParkingSummary(
        task,
        'needs_help',
        summaryText,
        {},
      );

      await this.messagesService.create({
        role: Role.ASSISTANT,
        taskId: task.id,
        content: [
          {
            type: MessageContentType.Text,
            text: helpSummary,
          },
        ],
      });

      await this.tasksService.update(task.id, {
        status: TaskStatus.NEEDS_HELP,
        result: this.mergeTaskResult(task, {
          security: applySessionActiveBranch(nextSecurity, 'needs_help', {
            ...session,
            phase: 'needs_attention',
            awaitingUserDecision: true,
            lastTerminalStatus: 'needs_help',
            lastTerminalSummary: helpSummary,
            parkedAt: new Date().toISOString(),
          }),
        }),
      });
      this.releaseProcessingLease(task.id);
      return;
    }

    if (terminalStatus === 'completed') {
      await this.tasksService.update(task.id, {
        status: TaskStatus.COMPLETED,
        completedAt: new Date(),
        result: this.mergeTaskResult(task, {
          security: applySessionActiveBranch(nextSecurity, 'closed', {
            ...session,
            phase: 'closed',
            awaitingUserDecision: false,
            lastTerminalStatus: terminalStatus,
            lastTerminalSummary: summaryText,
            closedAt: new Date().toISOString(),
          }),
        }),
      });
    } else {
      const failureSummary = this.buildSessionParkingSummary(
        task,
        'failed',
        summaryText,
        {},
      );

      await this.messagesService.create({
        role: Role.ASSISTANT,
        taskId: task.id,
        content: [
          {
            type: MessageContentType.Text,
            text: failureSummary,
          },
        ],
      });

      await this.tasksService.update(task.id, {
        status: TaskStatus.FAILED,
        result: this.mergeTaskResult(task, {
          security: applySessionActiveBranch(nextSecurity, 'closed', {
            ...session,
            phase: 'closed',
            awaitingUserDecision: false,
            lastTerminalStatus: 'failed',
            lastTerminalSummary: failureSummary,
            closedAt: new Date().toISOString(),
          }),
        }),
      });
    }

    this.computerUseExecutor.forgetTaskContext(task.id);
    this.taskSecretsService.forget(task.id);
    this.releaseProcessingLease(task.id);
  }

  private buildSessionParkingSummary(
    task: Task,
    terminalStatus: 'completed' | 'failed' | 'needs_help',
    summaryText: string,
    mediaFinalization: {
      transcriptText?: string;
      conciseSummary?: string;
      detailedSummary?: string;
    },
  ): string {
    const cleanSummary = this.normalizeUserFacingSummaryText(summaryText);
    const lines: string[] = [];
    const security = this.getTaskSecurityState(task);
    const mediaState = security.media;

    if (terminalStatus === 'completed') {
      lines.push(`Task result ready: ${cleanSummary}`);
    } else if (terminalStatus === 'failed') {
      lines.push(`I hit a blocker: ${cleanSummary}`);
    } else {
      lines.push(`I need your attention: ${cleanSummary}`);
    }

    if (mediaFinalization.conciseSummary) {
      lines.push(`Concise summary: ${mediaFinalization.conciseSummary}`);
    }

    if (mediaFinalization.detailedSummary) {
      lines.push(`Detailed summary: ${mediaFinalization.detailedSummary}`);
    }

    if (mediaFinalization.transcriptText) {
      const transcript =
        mediaFinalization.transcriptText.length > 1400
          ? `${mediaFinalization.transcriptText.slice(0, 1397)}...`
          : mediaFinalization.transcriptText;
      lines.push(`Transcript: ${transcript}`);
    } else if (
      this.isMediaTask(task.description) &&
      mediaState?.transcriptRequested &&
      (
        !!mediaState.playbackVerifiedAt ||
        !!mediaState.recordingStartedAt ||
        !!mediaState.recordingStoppedAt ||
        mediaState.transcriptionStatus === 'ready' ||
        mediaState.transcriptionStatus === 'failed' ||
        mediaState.transcriptionStatus === 'transcribing'
      )
    ) {
      lines.push(
        mediaState.transcriptionError
          ? `Transcript unavailable: ${mediaState.transcriptionError}`
          : 'Transcript unavailable: no usable transcript could be captured for this media session.',
      );
    } else if (this.isMediaTask(task.description)) {
      lines.push(
        'If you want to continue in this same session, send the next instruction here. If you are done, reply with done, stop, or complete to close the task.',
      );
      return lines.join('\n\n');
    }

    lines.push(
      'This task session is still open. Send the next instruction here to continue in the same state, or reply with done, stop, or complete to close it.',
    );

    return lines.join('\n\n');
  }

  private async maybeAutoContinueLowRiskPrompt(
    taskId: string,
    task: Task,
    assistantText: string,
  ): Promise<boolean> {
    const security = this.getTaskSecurityState(task);

    if (
      !this.isLowRiskContinuationPrompt(taskId, task, assistantText, security) ||
      security.pendingConfirmation
    ) {
      return false;
    }

    if (!this.shouldUseQueuedExecution(task)) {
      const handoffSummary =
        security.preflight?.plan?.trim() ||
        'Execution handoff resumed automatically after a low-risk continuation prompt.';
      const resumedTask = await this.storePlannerExecutionSequence(
        taskId,
        task,
        handoffSummary,
        security.preflight?.planSteps,
        'initial',
      );
      task.result = resumedTask.result as any;

      this.logger.log(
        `Converted low-risk continuation prompt into an active execution handoff for task ${task.id}`,
      );

      return true;
    }

    const suppressedCount =
      security.execution?.suppressedContinuationPromptCount || 0;

    if (suppressedCount >= 2) {
      return false;
    }

    const updatedResult = this.mergeTaskResult(task, {
      security: {
        ...security,
        execution: {
          ...(security.execution || {}),
          suppressedContinuationPromptCount: suppressedCount + 1,
          lastSuppressedContinuationPrompt: assistantText,
          lastSuppressedContinuationAt: new Date().toISOString(),
        },
      },
    });

    await this.tasksService.update(task.id, {
      result: updatedResult,
    });
    task.result = updatedResult as any;

    this.logger.log(
      `Suppressing low-risk continuation prompt for task ${task.id} and continuing automatically`,
    );

    return true;
  }

  private async maybeAutoContinueExecutionNarration(
    taskId: string,
    task: Task,
    assistantText: string,
  ): Promise<boolean> {
    const security = this.getTaskSecurityState(task);

    if (
      security.pendingConfirmation ||
      !this.isNonTerminalExecutionNarration(task, assistantText)
    ) {
      return false;
    }

    if (!this.shouldUseQueuedExecution(task)) {
      const resumedTask = await this.storePlannerExecutionSequence(
        taskId,
        task,
        security.preflight?.plan?.trim() ||
          'Execution handoff synthesized from planner narration.',
        security.preflight?.planSteps,
        'initial',
      );
      task.result = resumedTask.result as any;

      this.logger.log(
        `Converted planner narration into an active execution handoff for task ${task.id}`,
      );

      return true;
    }

    const suppressedCount =
      security.execution?.suppressedExecutionNarrationCount || 0;

    if (suppressedCount >= 2) {
      const fallbackSteps = this.plannerPlanCompiler.buildQueryDerivedFallbackPlanSteps({
        currentGoal: this.getCurrentTurnGoal(task),
        taskDescription: task.description,
        security,
      });
      const recoveredTask = await this.storeNormalExecutionSequenceFromSteps(
        taskId,
        task,
        security.preflight?.plan?.trim() ||
          'Recovered the planner flow from the current task state.',
        'replan',
        fallbackSteps.map((description) => ({
          description,
          executionMode: this.inferExecutionMode(task, description),
          expectedState: undefined,
          completionCondition: undefined,
          driftCondition: undefined,
        })),
      );
      task.result = recoveredTask.result as any;
      await this.messagesService.create({
        role: Role.ASSISTANT,
        taskId,
        content: [
          {
            type: MessageContentType.Text,
            text: 'Watchdog: planner narration drifted away from executable steps. Rebuilding the task flow from the current state now.',
          },
        ],
      });
      return true;
    }

    const updatedResult = this.mergeTaskResult(task, {
      security: {
        ...security,
        execution: {
          ...(security.execution || {}),
          suppressedExecutionNarrationCount: suppressedCount + 1,
          lastSuppressedExecutionNarration: assistantText,
          lastSuppressedExecutionNarrationAt: new Date().toISOString(),
        },
      },
    });

    await this.tasksService.update(task.id, {
      result: updatedResult,
    });
    task.result = updatedResult as any;

    this.logger.log(
      `Suppressing non-terminal execution narration for task ${task.id} and retrying execution`,
    );

    return true;
  }

  private async maybeContinueRemainingPlannerSteps(
    taskId: string,
    task: Task,
    assistantText: string,
  ): Promise<boolean> {
    const security = this.getTaskSecurityState(task);
    const stepPlan = security.execution?.stepPlan;

    if (
      security.pendingConfirmation ||
      !stepPlan ||
      (stepPlan.totalSteps || 0) <= 1 ||
      (stepPlan.currentIndex || 1) >= (stepPlan.totalSteps || 0)
    ) {
      return false;
    }

    if (
      /\?$/.test(assistantText.trim()) ||
      this.isHumanOnlyAttentionNeeded(assistantText)
    ) {
      return false;
    }

    const remainingSteps = this.rebuildRemainingPlannedSteps(task, stepPlan);
    if (remainingSteps.length === 0) {
      return false;
    }

    const [nextStep, ...stillPending] = remainingSteps;
    const updatedResult = this.mergeTaskResult(task, {
      security: applySessionActiveBranch(
        {
          ...security,
          execution: {
            ...(security.execution || {}),
            activeExecution: {
              ...nextStep,
              source: stepPlan.source || 'initial',
              createdAt: new Date().toISOString(),
              startedAt: undefined,
              completedAt: undefined,
              blockedAt: undefined,
              blockReason: undefined,
            },
            pendingSteps: stillPending,
            stepPlan: {
              ...stepPlan,
              currentIndex: Math.min(
                (stepPlan.currentIndex || 1) + 1,
                stepPlan.totalSteps || (stepPlan.currentIndex || 1) + 1,
              ),
              completedAt: undefined,
            },
            blockedStep: undefined,
            currentStep: undefined,
          },
        },
        'executing',
        {
          phase: 'active',
          awaitingUserDecision: false,
        },
      ),
    });

    await this.tasksService.update(task.id, {
      result: updatedResult,
    });
    task.result = updatedResult as any;

    const progressUpdate = this.buildExecutionProgressUpdate(
      task,
      nextStep.description,
      (stepPlan.source || 'initial') === 'replan' ? 'replan' : 'initial',
    );
    if (progressUpdate) {
      await this.messagesService.create({
        role: Role.ASSISTANT,
        taskId,
        content: [{ type: MessageContentType.Text, text: progressUpdate }],
      });
    }

    this.logger.log(
      `Continuing remaining planner steps for task ${task.id} after non-terminal planner narration`,
    );

    return true;
  }

  private async maybeAutoContinueSetupStateSummary(
    taskId: string,
    task: Task,
    assistantText: string,
  ): Promise<boolean> {
    const security = this.getTaskSecurityState(task);

    if (
      security.pendingConfirmation ||
      !this.isSetupOnlyVisibleStateSummary(task, assistantText)
    ) {
      return false;
    }

    const fallbackSteps = this.plannerPlanCompiler.buildQueryDerivedFallbackPlanSteps({
      currentGoal: this.getCurrentTurnGoal(task),
      taskDescription: task.description,
      security,
    });
    if (fallbackSteps.length === 0) {
      return false;
    }

    if (!this.shouldUseQueuedExecution(task)) {
      const resumedTask = await this.storePlannerExecutionSequence(
        taskId,
        task,
        security.preflight?.plan?.trim() ||
          'The current screen only shows setup state, so continue automatically from the current turn goal.',
        security.preflight?.planSteps?.length
          ? security.preflight.planSteps
          : fallbackSteps,
        security.execution?.activeExecution ? 'replan' : 'initial',
      );
      task.result = resumedTask.result as any;
      this.logger.log(
        `Converted setup-only visible state into continued execution for task ${task.id}`,
      );
      return true;
    }

    const recoveredTask = await this.storeNormalExecutionSequenceFromSteps(
      taskId,
      task,
      security.preflight?.plan?.trim() ||
        'Recovered the task flow from a setup-only visible state.',
      'replan',
      fallbackSteps.map((description) => ({
        description,
        executionMode: this.inferExecutionMode(task, description),
        expectedState: undefined,
        completionCondition: undefined,
        driftCondition: undefined,
      })),
    );
    task.result = recoveredTask.result as any;
    await this.messagesService.create({
      role: Role.ASSISTANT,
      taskId,
      content: [
        {
          type: MessageContentType.Text,
          text: 'Watchdog: setup state detected without real progress. Continuing automatically from the current turn now.',
        },
      ],
    });
    return true;
  }

  private getCombinedTextContent(contentBlocks: MessageContentBlock[]): string {
    return contentBlocks
      .filter((block) => block.type === MessageContentType.Text)
      .map((block) => (block as TextContentBlock).text)
      .join('\n')
      .trim();
  }

  private isLowRiskContinuationPrompt(
    taskId: string,
    task: Task,
    text: string,
    security: TaskSecurityState,
  ): boolean {
    const normalizedText = text.toLowerCase();
    const normalizedTask = this.getCurrentTurnGoal(task).toLowerCase();
    const combined = `${normalizedTask} ${normalizedText}`;
    const credentialBackedOpenSessionTask =
      this.isCredentialBackedOpenSessionTask(taskId, task);

    if (!normalizedText.trim()) {
      return false;
    }

    const explicitContinuePrompt =
      /\b(shall i proceed|should i proceed|would you like me to proceed|do you want me to proceed|should i continue|would you like me to continue|do you want me to continue)\b/.test(
        normalizedText,
      );
    const openSessionFollowUpPrompt =
      /\b(what should i do next after|what would you like to do after|after i open|after that|once i open|once this step is done|when this step is done|anything else you'd like me to do|anything else would you like me to do|what else would you like me to do)\b/.test(
        normalizedText,
      );
    const optionalSuggestionChatter =
      /\b(i can also|i could also|if you'd like|such as composing|searching for a specific|organizing your folders|checking your spam folder)\b/.test(
        normalizedText,
      );
    const lowRiskNextStepPrompt =
      /\bthe next step is to\b/.test(normalizedText) &&
      /\b(proceed|continue|next step|shall i|should i|would you like)\b/.test(
        normalizedText,
      );
    const looksLikeCapacityOrFailure =
      /\b(i hit a blocker|internal error|had to stop|last error:|temporary model\/provider capacity limit|provider capacity limit|resource_exhausted|quota|rate limit)\b/.test(
        normalizedText,
      );
    const humanOnlyKeywords =
      /\b(captcha|recaptcha|i'?m not a robot|not a robot|cloudflare|turnstile|hcaptcha|cf-challenge|consent dialog|approval received)\b/.test(
        normalizedText,
      );
    const sensitiveKeywords =
      /\b(send|send email|send mail|purchase|buy|pay|payment|book|booking|checkout|delete|remove|cancel booking|transfer|wire|post|publish|confirm order|place order)\b/.test(
        combined,
      ) ||
      (/\bsubmit\b/.test(combined) &&
        /\b(email|message|application|order|booking|payment|purchase|checkout|form submission|final submit)\b/.test(
          combined,
        ));
    const lowRiskTask =
      /\b(search|find|look up|lookup|check|compare|review|show|open|inbox|mailbox|login|log in|sign in|signin|price|prices|results|flight|flights|train|trains|hotel|hotels|trip|travel|route|routes|date|dates|calendar|form|fields|filter|filters|option|options)\b/.test(
        combined,
      );
    const hasActivePlan =
      !!security.execution?.activeExecution ||
      (security.execution?.mediaPlan?.totalSteps || 0) > 0 ||
      (security.execution?.mediaQueue?.length || 0) > 0;

    if (
      looksLikeCapacityOrFailure ||
      humanOnlyKeywords ||
      sensitiveKeywords ||
      !lowRiskTask ||
      (!hasActivePlan && !credentialBackedOpenSessionTask)
    ) {
      return false;
    }

    return (
      explicitContinuePrompt ||
      lowRiskNextStepPrompt ||
      (credentialBackedOpenSessionTask &&
        (openSessionFollowUpPrompt || optionalSuggestionChatter))
    );
  }

  private isCredentialBackedOpenSessionTask(taskId: string, task: Task): boolean {
    const secrets = this.taskSecretsService.get(taskId);
    if (!secrets || (!secrets.username && !secrets.password && !secrets.otp)) {
      return false;
    }

    return /\b(open|login|log in|sign in|signin|inbox|mailbox|account)\b/i.test(
      this.getCurrentTurnGoal(task),
    );
  }

  private isNonTerminalExecutionNarration(task: Task, text: string): boolean {
    const normalizedText = (text || '').trim().toLowerCase();
    if (!normalizedText) {
      return false;
    }

    const looksLikeResult =
      /\b(i found|i opened|i have opened|i successfully opened|is open|is visible|results show|the page shows|the screen shows|task result ready|completed|done)\b/.test(
        normalizedText,
      );
    const looksLikeQuestion =
      /\?$/.test(normalizedText) ||
      /\b(should i|would you like|do you want|what would you like|what should i do next)\b/.test(
        normalizedText,
      );
    const looksLikeExecutionPromise =
      /\b(i will|i'll|i am going to|i can do that by|i will start by|i can start by|i will begin by)\b/.test(
        normalizedText,
      ) &&
      /\b(open|navigate|go to|log in|login|sign in|search|find|fill|enter|select|choose|click|continue|check|review|compare|use the secure|use the saved)\b/.test(
        normalizedText,
      );

    if (!looksLikeExecutionPromise || looksLikeResult || looksLikeQuestion) {
      return false;
    }

    return !this.isMediaTask(task.description);
  }

  private isSetupOnlyVisibleStateSummary(task: Task, text: string): boolean {
    const normalizedText = (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!normalizedText) {
      return false;
    }

    if (
      this.isHumanOnlyAttentionNeeded(normalizedText) ||
      this.isGroundedActionCompletion(task, text) ||
      this.isGroundedSummaryAnswer(task, text)
    ) {
      return false;
    }

    const setupSignals = [
      'the current screen shows a desktop',
      'a web browser needs to be opened',
      'the web browser needs to be opened',
      'browser needs to be opened',
      'the browser is not open',
      'desktop is visible',
      'ready for the search to be initiated',
      'search has not been initiated',
      'search button is not visible',
      'needs to be opened to proceed',
      'needs to be clicked',
      'has not been clicked',
    ];

    return setupSignals.some((signal) => normalizedText.includes(signal));
  }

  private inferImplicitTerminalStatus(
    task: Task,
    text: string,
  ): 'completed' | 'needs_help' | 'failed' {
    const trimmed = text.trim();
    if (!trimmed) {
      return 'completed';
    }

    const normalizedTask = this.getCurrentTurnGoal(task).toLowerCase();
    const normalizedText = trimmed.toLowerCase();
    const looksLikeRawActionOnlySummary =
      /^(clicked at \(\d+,\s*\d+\)|typed text at \(\d+,\s*\d+\)|entered sensitive text at \(\d+,\s*\d+\)|opened web browser|open application|pressed key|pressed keys|scrolled (up|down)|dragged from \(\d+,\s*\d+\) to \(\d+,\s*\d+\))\.?$/i.test(
        trimmed,
      );
    const looksLikeBlockerOrFailure =
      /\b(i hit a blocker|internal error|had to stop|last error:|temporary model\/provider capacity limit|provider capacity limit|model provider returned|resource_exhausted|resource has been exhausted|quota|rate limit)\b/.test(
        normalizedText,
      );
    const looksLikeSearchOrLookupTask =
      /\b(search|find|lookup|look up|check|compare|review|flight|flights|train|hotel|results|price|options)\b/.test(
        normalizedTask,
      );
    const looksLikeShoppingActionTask =
      /\b(add to cart|cart|buy|purchase|checkout|shopping|amazon|flipkart|book|books)\b/.test(
        normalizedTask,
      );
    const looksLikeInboxOpenTask =
      /\b(open|show|check)\b.*\b(inbox|mailbox|gmail|proton mail|outlook|mail)\b/.test(
        normalizedTask,
      );
    const looksLikeTravelResultsTask =
      /\b(flight|flights|train|trains|hotel|trip|travel|itinerary|route|routes)\b/.test(
        normalizedTask,
      ) && /\b(results|options|show|search)\b/.test(normalizedTask);
    const wantsSummary =
      /\b(summarize|summarise|summary|tell me|what do you see|latest|find|search|read|check)\b/.test(
        normalizedTask,
      );
    const looksLikeFoundResultSummary =
      /\b(i found|i have found|i successfully found|i located|i have successfully found|the article|the page|the results show|the screen displays|results page is (now )?(displayed|visible|ready)|search results (page )?is (now )?(displayed|visible|ready)|i have successfully searched|i successfully searched|the requested results are visible|the requested results are ready|i am now ready to summarize|ready to summarize|can summarize|summarizing)\b/.test(
        normalizedText,
      );
    const looksLikeSummaryOffer =
      /\b(i can (either )?summarize|i can summarize|ready to summarize|search for more information|more sources|more information)\b/.test(
        normalizedText,
      );
    const looksLikeOpenSessionFollowUp =
      /\b(what would you like to do next|send the next instruction|if you want to continue|the session is still open)\b/.test(
        normalizedText,
      );
    const looksLikeGroundedSummaryAnswer =
      this.isGroundedSummaryAnswer(task, trimmed);
    const looksLikeGroundedActionCompletion =
      this.isGroundedActionCompletion(task, trimmed);
    const looksLikeProgressButNotAnswer =
      looksLikeFoundResultSummary ||
      looksLikeSummaryOffer ||
      /\b(search results|results page|article is open|page is open|page is visible|screen shows|page shows|result is visible|ready to summarize)\b/.test(
        normalizedText,
      );

    if (looksLikeBlockerOrFailure) {
      return 'failed';
    }

    if (looksLikeRawActionOnlySummary) {
      return 'needs_help';
    }

    if (this.isNonTerminalExecutionNarration(task, trimmed)) {
      return 'needs_help';
    }

    if (looksLikeOpenSessionFollowUp) {
      return 'needs_help';
    }

    if (
      this.isMediaTask(task.description) &&
      this.mediaSummaryShowsVisibleMatchingCandidate(task, trimmed)
    ) {
      return 'needs_help';
    }

    if (
      (looksLikeShoppingActionTask ||
        looksLikeInboxOpenTask ||
        looksLikeTravelResultsTask) &&
      looksLikeGroundedActionCompletion
    ) {
      return 'completed';
    }

    if (wantsSummary && looksLikeGroundedSummaryAnswer) {
      return 'completed';
    }

    if (
      looksLikeSearchOrLookupTask &&
      looksLikeGroundedSummaryAnswer
    ) {
      return 'completed';
    }

    if (
      (looksLikeSearchOrLookupTask || wantsSummary) &&
      looksLikeProgressButNotAnswer
    ) {
      return 'needs_help';
    }

    if (looksLikeSearchOrLookupTask || wantsSummary) {
      return 'needs_help';
    }

    if (
      /\?$/.test(trimmed) ||
      /\b(reply|please provide|please clarify|would you like|do you want|let me know|which|what|can you|could you|should i)\b/i.test(
        trimmed,
      )
    ) {
      return 'needs_help';
    }

    return 'completed';
  }

  private deriveGoalSatisfiedSummary(
    task: Task,
    summary: string,
    checkpoints?: ExecutionCheckpoint[],
  ): string | null {
    const latestCheckpoint = [...(checkpoints || [])]
      .reverse()
      .find((checkpoint) => checkpoint.visibleSummary?.trim());
    const directGroundedAnswer = this.extractGroundedSummaryAnswerCandidate(task, [
      summary,
      this.extractLatestVisibleSummary(checkpoints),
      latestCheckpoint?.visibleSummary,
    ]);

    if (
      latestCheckpoint &&
      latestCheckpoint.targetVisible === true &&
      latestCheckpoint.nextActionNeeded === false &&
      latestCheckpoint.visibleSummary?.trim()
    ) {
      return latestCheckpoint.visibleSummary.trim();
    }

    if (
      latestCheckpoint &&
      latestCheckpoint.targetVisible === false &&
      latestCheckpoint.nextActionNeeded === true
    ) {
      return directGroundedAnswer;
    }

    const candidates = [
      this.extractLatestVisibleSummary(checkpoints),
      summary,
    ].filter((entry): entry is string => !!entry && !!entry.trim());

    for (const candidate of candidates) {
      if (
        this.isPlaceholderExecutionSummary(candidate) ||
        this.isRawActionOnlySummary(candidate) ||
        this.isSetupOnlyVisibleStateSummary(task, candidate)
      ) {
        continue;
      }
      if (
        this.isMediaTask(task.description) &&
        (this.isRequestedMediaMismatchSummary(candidate) ||
          this.mediaSummaryShowsVisibleMatchingCandidate(task, candidate))
      ) {
        continue;
      }
      if (this.isGroundedSummaryAnswer(task, candidate)) {
        return candidate.trim();
      }
      if (this.inferImplicitTerminalStatus(task, candidate) === 'completed') {
        return candidate.trim();
      }
    }

    return directGroundedAnswer;
  }

  private inferRequestedMaxDurationMs(description: string): number | null {
    const normalized = description.toLowerCase();
    const minuteMatch = normalized.match(
      /\b(?:under|less than|within|max(?:imum)?(?: of)?|no more than)\s+(\d+)\s*(minute|minutes|min)\b/,
    );
    if (minuteMatch) {
      return Number(minuteMatch[1]) * 60 * 1000;
    }

    const secondMatch = normalized.match(
      /\b(?:under|less than|within|max(?:imum)?(?: of)?|no more than)\s+(\d+)\s*(second|seconds|sec)\b/,
    );
    if (secondMatch) {
      return Number(secondMatch[1]) * 1000;
    }

    return null;
  }

  private containsDirtyMediaSourceBias(text: string): boolean {
    const normalized = text.toLowerCase();
    if (!normalized.trim()) {
      return false;
    }

    return /\b(search ted\b|search on ted\b|search the ted\b|relevant ted\b|ted website|ted site|ted\.com|official ted|official source|prioritize .*source|prioritize .*ted|first relevant result|first video result|open the first .*video|pick the next video|try the next video)\b/i.test(
      normalized,
    );
  }

  private buildMediaVisibleConstraintInstruction(taskDescription: string): string {
    const maxDurationMs = this.inferRequestedMaxDurationMs(taskDescription);
    const durationInstruction =
      maxDurationMs !== null
        ? ' If a visible result or current player exceeds the requested duration limit, do not open it and do not treat it as good progress.'
        : '';

    return `Choose the best visible candidate that satisfies the user's visible constraints instead of blindly opening the first result.${durationInstruction} If the current player or visible result does not satisfy the request, treat that as a mismatch and continue selecting a better visible candidate automatically instead of stopping or asking the user.`;
  }

  private buildPlannerTarget(goal: string): string | null {
    const cleaned = (goal || '')
      .replace(/\b(?:please\s+)?(?:open|play|watch|find|search(?:\s+for)?|show|start|listen to)\b/gi, '')
      .replace(/\b(?:join|attend|enter|go to|navigate to|resume|continue)\b/gi, '')
      .replace(/\b(?:on|in)\s+(?:youtube|google meet|zoom|teams|spotify|soundcloud|apple music)\b/gi, '')
      .replace(/\b(?:youtube|google meet|zoom|teams|spotify|soundcloud|apple music)\b/gi, '')
      .replace(/\babout\b/gi, '')
      .replace(/\b(?:and|then|at last|finally)\b[\s\S]*$/i, '')
      .replace(/\b(?:give|provide|create|make|prepare)\b[\s\S]*\b(?:transcript|summary|recap|notes?)\b[\s\S]*$/i, '')
      .replace(/\b(?:keep it running|let it play|play it|listen to it|watch it|until it ends|after it ends|after it finishes)\b[\s\S]*$/i, '')
      .replace(/\b(?:for this turn:)\b/gi, '')
      .replace(/\b(?:the requested|requested)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^["']|["']$/g, '');

    if (!cleaned) {
      return null;
    }

    const normalized = cleaned.toLowerCase();
    if (
      normalized === 'video' ||
      normalized === 'song' ||
      normalized === 'audio' ||
      normalized === 'podcast' ||
      normalized === 'ted talk'
    ) {
      return cleaned;
    }

    return cleaned;
  }

  private buildMediaSearchTarget(goal: string): string | null {
    return this.buildPlannerTarget(goal);
  }

  private parseDurationFromText(text: string): number | null {
    const normalized = (text || '').trim();
    if (!normalized) {
      return null;
    }

    const match = normalized.match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/);
    if (!match) {
      return null;
    }

    if (match[3]) {
      return (
        Number(match[1]) * 60 * 60 * 1000 +
        Number(match[2]) * 60 * 1000 +
        Number(match[3]) * 1000
      );
    }

    return Number(match[1]) * 60 * 1000 + Number(match[2]) * 1000;
  }

  private mediaSummaryShowsVisibleMatchingCandidate(
    task: Task,
    text: string,
  ): boolean {
    if (!this.isMediaTask(task.description)) {
      return false;
    }

    const normalized = (text || '').toLowerCase();
    if (!normalized.trim()) {
      return false;
    }

    if (!/\b(youtube|results|search results|visible|selected|candidate|suitable|relevant)\b/.test(normalized)) {
      return false;
    }

    if (this.isRequestedMediaMismatchSummary(normalized)) {
      return false;
    }

    const mentionsCandidate =
      /\b(suitable|relevant|matching|visible|selected)\s+(video|result|candidate|short|clip|talk|song|item)\b/.test(
        normalized,
      ) ||
      /\b(video titled|result titled|candidate titled|short .* is visible|is visible and selected)\b/.test(
        normalized,
      );
    if (!mentionsCandidate) {
      return false;
    }

    const maxDurationMs = this.inferRequestedMaxDurationMs(task.description);
    if (maxDurationMs === null) {
      return true;
    }

    const visibleDurationMs = this.parseDurationFromText(text);
    return visibleDurationMs !== null && visibleDurationMs <= maxDurationMs;
  }

  private shouldEmitUserVisibleExecutionTrace(
    task: Task,
    summary: {
      status: 'in_progress' | 'completed' | 'drifted' | 'failed';
      mode: ExecutionMode;
      requiresConfirmation?: unknown;
      summaryText?: string;
    },
  ): boolean {
    return this.isMediaTask(task.description);
  }

  private isGroundedSummaryAnswer(task: Task, text: string): boolean {
    const normalizedText = text.toLowerCase().trim();
    if (!normalizedText) {
      return false;
    }

    if (
      /\b(ready to summarize|can summarize|i can summarize|search results are visible|results page is visible|results page is ready|the requested results are visible|the requested results are ready)\b/.test(
        normalizedText,
      )
    ) {
      return false;
    }

    const wantsSummary =
      /\b(summarize|summarise|summary|tell me|what do you see|latest|find|search|read|check)\b/.test(
        this.getCurrentTurnGoal(task).toLowerCase(),
      );
    if (!wantsSummary) {
      return false;
    }

    const hasAnswerLead =
      /\b(summary of|here(?:'s| is) (?:a )?summary|in summary|key points|latest advancements|based on the visible|based on the article|recent advancements)\b/.test(
        normalizedText,
      );
    const hasStructuredContent =
      /\b1\.\s|\b2\.\s|:\s|\*\*/.test(text) ||
      /(?:^|\n)-\s/.test(text);
    const hasSubstantiveLength = text.trim().length >= 180;
    const looksLikeConciseExplanatoryAnswer =
      !this.isPlaceholderExecutionSummary(text) &&
      !this.isRawActionOnlySummary(text) &&
      !this.isSetupOnlyVisibleStateSummary(task, text) &&
      !this.summaryIndicatesStaleOrContradictoryContext(text) &&
      this.summarySupportsCurrentTurnGoal(task, text) &&
      text.trim().length >= 70 &&
      /\b(is|are|means|does|lets|allows|helps|optimizes|enables|eliminates|provides|supports|handles|explains|describes|uses|automates|improves)\b/.test(
        normalizedText,
      ) &&
      !/\b(search results|results page|page is open|page is visible|screen shows|page shows|result is visible|ready to summarize|current screen shows|browser needs to be opened)\b/.test(
        normalizedText,
      );

    return (
      (hasAnswerLead && hasSubstantiveLength) ||
      hasStructuredContent ||
      looksLikeConciseExplanatoryAnswer
    );
  }

  private extractGroundedSummaryAnswerCandidate(
    task: Task,
    candidates: Array<string | null | undefined>,
  ): string | null {
    for (const candidate of candidates) {
      if (!candidate?.trim()) {
        continue;
      }
      if (
        this.isPlaceholderExecutionSummary(candidate) ||
        this.isRawActionOnlySummary(candidate) ||
        this.isSetupOnlyVisibleStateSummary(task, candidate) ||
        this.summaryIndicatesStaleOrContradictoryContext(candidate)
      ) {
        continue;
      }
      if (this.isGroundedSummaryAnswer(task, candidate)) {
        return candidate.trim();
      }
    }

    return null;
  }

  private shouldDeferImplicitActiveMediaTerminal(
    task: Task,
    text: string,
  ): boolean {
    if (!this.isMediaTask(task.description)) {
      return false;
    }

    const security = this.getTaskSecurityState(task);
    const media = security.media;
    if (!media?.selectedAt) {
      return false;
    }

    const stillNeedsExecution =
      !media.playbackVerifiedAt ||
      media.keepRunningUntilDone ||
      media.transcriptRequested ||
      media.summaryRequested;
    if (!stillNeedsExecution) {
      return false;
    }

    if (this.mediaReviewIndicatesEnded(text, media)) {
      return false;
    }

    if (this.isProviderCapacityFailure(text)) {
      return false;
    }

    const normalizedText = text.toLowerCase();
    if (
      /\b(captcha|recaptcha|i'?m not a robot|not a robot|cloudflare|turnstile|hcaptcha|cf-challenge|approval received)\b/.test(
        normalizedText,
      )
    ) {
      return false;
    }

    return true;
  }

  private normalizeTerminalStatus(
    task: Task,
    terminalStatus: 'completed' | 'failed' | 'needs_help',
    summaryText: string,
  ): 'completed' | 'failed' | 'needs_help' {
    if (this.isProviderCapacityFailure(summaryText)) {
      return 'failed';
    }

    if (
      terminalStatus === 'needs_help' &&
      !this.isHumanOnlyAttentionNeeded(summaryText)
    ) {
      return 'failed';
    }

    const inferred = this.inferImplicitTerminalStatus(task, summaryText);
    if (terminalStatus === 'completed' && inferred !== 'completed') {
      if (this.isHumanOnlyAttentionNeeded(summaryText)) {
        return 'needs_help';
      }

      if (this.isGroundedActionCompletion(task, summaryText)) {
        return 'completed';
      }

      if (this.isGroundedSummaryAnswer(task, summaryText)) {
        return 'completed';
      }

      if (inferred === 'failed') {
        return 'failed';
      }

      return 'failed';
    }

    if (terminalStatus === 'needs_help' && inferred === 'completed') {
      return 'completed';
    }

    if (terminalStatus === 'needs_help' && inferred === 'failed') {
      return 'failed';
    }

    return terminalStatus;
  }

  private normalizeLowRiskPreflightDecision(
    task: Task,
    parsed: {
      decision: 'ask_user' | 'proceed';
      reason: 'confirmation' | 'clarification';
      question: string;
      plan: string;
      planSteps: string[];
      guidelines: string[];
    },
  ): {
    decision: 'ask_user' | 'proceed';
    reason: 'confirmation' | 'clarification';
    question: string;
    plan: string;
    planSteps: string[];
    guidelines: string[];
  } {
    if (
      this.isMediaTask(task.description) ||
      this.requiresExplicitStartupConfirmation(task)
    ) {
      return parsed;
    }

    if (!this.isGenericStartupQuestion(parsed.question)) {
      return parsed;
    }

    return {
      ...parsed,
      decision: 'ask_user',
      reason: 'clarification',
      question:
        'I understand the task. Should I execute it now, or do you want to add any more info first?',
      plan:
        parsed.plan ||
        'Begin executing the task once the user either confirms to start or adds any last details.',
    };
  }

  private normalizeFollowUpPreflightDecision(
    task: Task,
    security: TaskSecurityState,
    parsed: {
      decision: 'ask_user' | 'proceed';
      reason: 'confirmation' | 'clarification';
      question: string;
      plan: string;
      planSteps: string[];
      guidelines: string[];
    },
  ): {
    decision: 'ask_user' | 'proceed';
    reason: 'confirmation' | 'clarification';
    question: string;
    plan: string;
    planSteps: string[];
    guidelines: string[];
  } {
    if (!security.preflight?.awaitingUserResponse) {
      return parsed;
    }

    if (
      parsed.decision === 'ask_user' &&
      this.isGenericStartupQuestion(parsed.question) &&
      !this.requiresExplicitStartupConfirmation(task)
    ) {
      return {
        ...parsed,
        decision: 'proceed',
        question: '',
        plan:
          parsed.plan ||
          security.preflight.plan ||
          'Begin executing the task now using the details the user already provided.',
      };
    }

    return parsed;
  }

  private isOptionalSearchPreferenceQuestion(
    task: Task,
    parsed: {
      decision: 'ask_user' | 'proceed';
      reason: 'confirmation' | 'clarification';
      question: string;
      plan: string;
      planSteps: string[];
      guidelines: string[];
    },
  ): boolean {
    if (parsed.decision !== 'ask_user') {
      return false;
    }

    const taskText = task.description.toLowerCase();
    const questionText = parsed.question.toLowerCase();
    const isSearchLikeTask =
      /\b(search|find|lookup|look up|check|compare|review|flight|flights|train|trains|hotel|hotels|trip|travel|route|routes|results|options|fare|fares|price|prices)\b/.test(
        taskText,
      );
    const preferenceOnlyQuestion =
      /\b(cheapest|lowest|lowest price|best price|fastest|quickest|something else|sort by|preference|prefer|what kind of option|which option)\b/.test(
        questionText,
      );

    return isSearchLikeTask && preferenceOnlyQuestion;
  }

  private isOptionalSearchScopeQuestion(
    task: Task,
    parsed: {
      decision: 'ask_user' | 'proceed';
      reason: 'confirmation' | 'clarification';
      question: string;
      plan: string;
      planSteps: string[];
      guidelines: string[];
    },
  ): boolean {
    if (parsed.decision !== 'ask_user') {
      return false;
    }

    const taskText = task.description.toLowerCase();
    const questionText = parsed.question.toLowerCase();
    const isSearchLikeTask =
      /\b(search|find|lookup|look up|check|research|review|read about|summary|summarize|summarise|latest|news|page|results)\b/.test(
        taskText,
      );
    const optionalScopeQuestion =
      /\b(source|sources|website|websites|site|sites|timeframe|timeframes|date range|date-range|format|formatting)\b/.test(
        questionText,
      );

    return isSearchLikeTask && optionalScopeQuestion;
  }

  private isOptionalMediaPreferenceQuestion(
    task: Task,
    parsed: {
      decision: 'ask_user' | 'proceed';
      reason: 'confirmation' | 'clarification';
      question: string;
      plan: string;
      planSteps: string[];
      guidelines: string[];
    },
  ): boolean {
    if (parsed.decision !== 'ask_user' || !this.isMediaTask(task.description)) {
      return false;
    }

    const questionText = parsed.question.toLowerCase();
    const optionalPreferenceQuestion =
      /\b(topic|genre|theme|subject|category|style|mood|speaker|ted talk .* about|video .* about|song .* about)\b/.test(
        questionText,
      );
    const userAlreadyAllowedAnyChoice =
      /\b(any|anything|whatever|whichever|surprise me|random)\b/i.test(
        task.description,
      );
    const taskHasExplicitContentConstraint =
      /\b(about|on|regarding|topic|subject|genre|theme|mood|specific|exact|named|called|titled|by)\b/i.test(
        task.description,
      );

    return (
      optionalPreferenceQuestion &&
      (userAlreadyAllowedAnyChoice || !taskHasExplicitContentConstraint)
    );
  }

  private normalizeMediaTranscriptPreflightDecision(
    task: Task,
    parsed: {
      decision: 'ask_user' | 'proceed';
      reason: 'confirmation' | 'clarification';
      question: string;
      plan: string;
      planSteps: string[];
      guidelines: string[];
    },
  ): {
    decision: 'ask_user' | 'proceed';
    reason: 'confirmation' | 'clarification';
    question: string;
    plan: string;
    planSteps: string[];
    guidelines: string[];
  } {
    if (!this.isMediaTask(task.description)) {
      return parsed;
    }

    const normalizedGoal = task.description.toLowerCase();
    const wantsTranscript =
      /\b(transcript|transcribe|transcription|captions?|subtitles?)\b/.test(
        normalizedGoal,
      );
    const wantsSummary =
      wantsTranscript || /\b(summary|summarize|summarise|recap|notes?)\b/.test(normalizedGoal);

    const recordingFinalStep =
      'Keep the media stable until it ends, then prepare the requested transcript and summary from recorded audio.';
    const sanitizedPlan =
      !parsed.plan.trim() || this.containsDirtyMediaSourceBias(parsed.plan)
        ? wantsTranscript || wantsSummary
          ? `Open the requested media on ${this.buildChosenMediaSurfacePhrase(task.description)}, verify playback, keep it stable until it ends, then prepare the requested transcript and summary from recorded audio.`
          : this.buildMediaPreflightPlan(task)
        : parsed.plan;
    const normalizedPlan =
      wantsTranscript || wantsSummary
        ? /recorded audio/i.test(sanitizedPlan) ||
          !/(transcript|captions?|subtitles?|summary)/i.test(sanitizedPlan)
          ? sanitizedPlan
          : `Open the requested media on ${this.buildChosenMediaSurfacePhrase(task.description)}, verify playback, keep it stable until it ends, then prepare the requested transcript and summary from recorded audio.`
        : sanitizedPlan;
    const normalizedPlanSteps = (parsed.planSteps || []).map((step) => {
      if ((wantsTranscript || wantsSummary) && /(transcript|captions?|subtitles?|lyrics)/i.test(step)) {
        return recordingFinalStep;
      }

      if (
        this.containsDirtyMediaSourceBias(step) ||
        /(open .*first .*result|search .* and open .*result|from ted\b|from ted\.com\b)/i.test(
          step,
        )
      ) {
        return this.isMediaOpeningLikeStep(task.description, step)
          ? this.buildMediaOpeningPlannerStep(task.description)
          : this.buildMediaPlaybackPlannerStep(task.description);
      }

      if (this.isMediaOpeningLikeStep(task.description, step)) {
        return this.buildMediaOpeningPlannerStep(task.description);
      }

      if (this.isMediaPlaybackLikeStep(task.description, step)) {
        return this.buildMediaPlaybackPlannerStep(task.description);
      }

      return step;
    });
    const filteredGuidelines = (parsed.guidelines || []).filter(
      (guideline) =>
        !/(first .*transcript|lacks? a transcript|transcript.*try the next|captions?.*try the next|subtitles?.*try the next|official .*source|source .*official|prioritize .*source|prioritize .*ted|official ted|ted\.com|ted website|ted site|relevant ted|search ted)/i.test(
          guideline,
        ),
    );
    const normalizedGuidelines = [
      ...filteredGuidelines,
      ...(wantsTranscript || wantsSummary
        ? [
            'Do not open transcript, captions, or subtitles UI during playback.',
            'Use recorded audio for transcript and summary generation after the requested media ends.',
          ]
        : []),
      'Choose visible media candidates that satisfy the requested constraints instead of blindly opening the first result.',
    ].filter((value, index, values) => values.indexOf(value) === index);

    return {
      ...parsed,
      plan: normalizedPlan,
      planSteps:
        normalizedPlanSteps.length > 0
          ? normalizedPlanSteps
          : [
              this.buildMediaOpeningPlannerStep(task.description),
              this.buildMediaPlaybackPlannerStep(task.description),
              recordingFinalStep,
            ],
      guidelines: normalizedGuidelines,
    };
  }

  private normalizeUnsupportedMediaPreflightDecision(
    task: Task,
    parsed: {
      decision: 'ask_user' | 'proceed';
      reason: 'confirmation' | 'clarification';
      question: string;
      plan: string;
      planSteps: string[];
      guidelines: string[];
    },
  ) {
    if (!this.isMediaTask(task.description)) {
      return parsed;
    }

    if (this.getMediaRoute(task.description) !== 'unsupported_media') {
      return parsed;
    }

    return {
      ...parsed,
      decision: 'ask_user' as const,
      reason: 'clarification' as const,
      question:
        'This media flow currently supports YouTube for video/media tasks and Google Meet, Zoom, or Teams for meetings. Use one of those instead?',
      plan:
        'Pause before execution because the requested media surface is unsupported by default. Wait for the user to switch to a supported media or meeting surface.',
      planSteps: [
        'Do not open the unsupported surface yet.',
        'Wait for the user to confirm YouTube for video/media work or Google Meet, Zoom, or Teams for meetings.',
      ],
      guidelines: [
        'Do not route unsupported media requests onto Netflix, Prime Video, Hulu, or other unsupported content sites by default.',
        'For video-like tasks, default to YouTube instead of article or content sites.',
      ],
    };
  }

  private normalizeInSessionFollowUpPreflightDecision(
    task: Task,
    security: TaskSecurityState,
    parsed: {
      decision: 'ask_user' | 'proceed';
      reason: 'confirmation' | 'clarification';
      question: string;
      plan: string;
      planSteps: string[];
      guidelines: string[];
    },
  ): {
    decision: 'ask_user' | 'proceed';
    reason: 'confirmation' | 'clarification';
    question: string;
    plan: string;
    planSteps: string[];
    guidelines: string[];
  } {
    if (
      !security.preflight?.followUpPending ||
      security.preflight.awaitingUserResponse
    ) {
      return parsed;
    }

    if (
      parsed.decision === 'ask_user' &&
      this.isGenericStartupQuestion(parsed.question) &&
      !this.requiresExplicitStartupConfirmation(task)
    ) {
      return {
        ...parsed,
        decision: 'proceed',
        question: '',
        plan:
          parsed.plan ||
          'Begin executing the follow-up request now using the details the user already provided.',
      };
    }

    return parsed;
  }

  private isGenericStartupQuestion(question: string): boolean {
    const normalizedQuestion = (question || '').trim().toLowerCase();
    if (!normalizedQuestion) {
      return false;
    }

    return (
      /^ready to\b/.test(normalizedQuestion) ||
      /^got it\b/.test(normalizedQuestion) ||
      /^i understand the task\b/.test(normalizedQuestion) ||
      /^understood\b/.test(normalizedQuestion) ||
      /^okay\b/.test(normalizedQuestion) ||
      /^ok\b/.test(normalizedQuestion) ||
      /^i can do that\b/.test(normalizedQuestion) ||
      /^i will\b/.test(normalizedQuestion) ||
      /^before i start\b/.test(normalizedQuestion) ||
      /proceed as[- ]is/.test(normalizedQuestion) ||
      /\badd one detail first\b/.test(normalizedQuestion) ||
      /reply with proceed/.test(normalizedQuestion) ||
      /ready to proceed/.test(normalizedQuestion) ||
      /should i proceed/.test(normalizedQuestion) ||
      /\bwant me to begin\b/.test(normalizedQuestion) ||
      /\bwant me to start\b/.test(normalizedQuestion) ||
      /\bshould i start\b/.test(normalizedQuestion) ||
      /\bshould i execute it now\b/.test(normalizedQuestion) ||
      /\badd any more info first\b/.test(normalizedQuestion) ||
      /confirm to begin/.test(normalizedQuestion)
    );
  }

  private isHumanOnlyAttentionNeeded(observedText: string): boolean {
    const corpus = (observedText || '').toLowerCase();
    if (
      /\b(no|not|without)\s+(captcha|recaptcha|robot check|human verification|challenge)\b/.test(
        corpus,
      ) ||
      /\b(captcha|challenge)\s+text\s+is\s+not\s+visible\b/.test(corpus)
    ) {
      return false;
    }

    return /\b(captcha|recaptcha|i'?m not a robot|not a robot|cloudflare|turnstile|hcaptcha|cf-challenge)\b/.test(
      corpus,
    );
  }

  private isProviderCapacityFailure(summary: string): boolean {
    const normalized = (summary || '').toLowerCase();
    if (!normalized.trim()) {
      return false;
    }

    return (
      normalized.includes('resource_exhausted') ||
      normalized.includes('resource has been exhausted') ||
      normalized.includes('quota') ||
      normalized.includes('rate limit') ||
      normalized.includes('429') ||
      normalized.includes('empty content payload') ||
      normalized.includes('provider returned an empty candidate response') ||
      normalized.includes('model provider returned')
    );
  }

  private isInfrastructureExecutionFailure(summary: string): boolean {
    const normalized = (summary || '').toLowerCase();
    if (!normalized.trim()) {
      return false;
    }

    return (
      normalized.includes('invalid_argument') ||
      normalized.includes(
        'computer use model requires function response to contain the url',
      ) ||
      normalized.includes('desktop api') ||
      normalized.includes('screenshot failed') ||
      normalized.includes('screenshot returned no image data')
    );
  }

  private requiresExplicitStartupConfirmation(task: Task): boolean {
    const goal = this.getCurrentTurnGoal(task);
    const riskyCommitAction =
      /\b(send|purchase|buy|pay|payment|book|booking|checkout|delete|remove|cancel booking|confirm order|place order|transfer|wire|post|publish)\b/i.test(
        goal,
      );
    const submitLikeCommit =
      /\bsubmit\b/i.test(goal) &&
      /\b(email|message|application|order|booking|payment|purchase|checkout|form submission|final submit)\b/i.test(
        goal,
      );

    return riskyCommitAction || submitLikeCommit;
  }

  private shouldPreserveSessionState(task: Task): boolean {
    const security = this.getTaskSecurityState(task);
    return (
      (task.status === TaskStatus.NEEDS_REVIEW ||
        task.status === TaskStatus.NEEDS_HELP) &&
      security.session?.keepAliveUntilUserDone === true
    );
  }

  private releaseProcessingLease(taskId: string): void {
    if (this.currentTaskId !== taskId) {
      return;
    }

    this.abortController = null;
    this.isProcessing = false;
    this.currentTaskId = null;
  }

  private buildDesktopStepInput(
    task: Task,
    toolBlock: ToolUseContentBlock,
  ): {
    description: string;
    executionMode: ExecutionMode;
    expectedState?: Record<string, string>;
    completionCondition?: string;
    driftCondition?: string;
  } {
    const input = (toolBlock.input || {}) as Record<string, unknown>;
    const rawExpectedState =
      input.expected_state && typeof input.expected_state === 'object'
        ? Object.fromEntries(
            Object.entries(input.expected_state as Record<string, unknown>)
              .filter(([, value]) => typeof value === 'string')
              .map(([key, value]) => [key, value as string]),
          )
        : undefined;

    const rawDescription = String(input.description || '');
    const rewrittenDescription = rawDescription.trim();
    const requestedMode =
      typeof input.execution_mode === 'string'
        ? (input.execution_mode as ExecutionMode)
        : undefined;
    const expectedState = this.normalizeExpectedStateForStep(
      task,
      rewrittenDescription,
      rawExpectedState,
    );
    const preservePlannerMediaConstraints = !this.shouldRelaxMediaStartupStep(
      task,
      rewrittenDescription,
    );

    return {
      description: rewrittenDescription,
      executionMode: this.inferExecutionMode(
        task,
        rewrittenDescription,
        requestedMode,
        expectedState,
      ),
      expectedState,
      completionCondition:
        preservePlannerMediaConstraints &&
        typeof input.completion_condition === 'string'
          ? input.completion_condition
          : this.inferCompletionCondition(
              task,
              rewrittenDescription,
              expectedState,
            ),
      driftCondition:
        preservePlannerMediaConstraints &&
        typeof input.drift_condition === 'string'
          ? input.drift_condition
          : this.inferDriftCondition(
              task,
              rewrittenDescription,
              expectedState,
      ),
    };
  }

  private isStructuredExecutionBrief(description: string): boolean {
    return /^(?:planner execution brief|recovery brief):/i.test(
      description.trim(),
    );
  }

  private shouldRelaxMediaStartupStep(task: Task, description: string): boolean {
    if (!this.isMediaTask(task.description)) {
      return false;
    }

    return /(navigate to youtube\.com|open youtube|go to youtube|youtube homepage|open or reuse youtube|open google meet|open zoom|open microsoft teams|open or reuse google meet|open or reuse zoom|open or reuse microsoft teams)/i.test(
      description,
    );
  }

  private normalizeExpectedStateForStep(
    task: Task,
    description: string,
    expectedState?: Record<string, string>,
  ): Record<string, string> | undefined {
    if (!expectedState) {
      return expectedState;
    }

    if (this.isMediaTask(task.description)) {
      return expectedState;
    }

    if (!this.shouldRelaxMediaStartupStep(task, description)) {
      return expectedState;
    }

    return Object.fromEntries(
      Object.entries(expectedState).filter(
        ([key, value]) =>
          !(
            key.toLowerCase() === 'url' &&
            /^https?:\/\/(www\.)?(youtube\.com|meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com)\/?$/i.test(
              value,
            )
          ),
      ),
    );
  }

  private buildQueuedPlanInput(
    task: Task,
    toolBlock: ToolUseContentBlock,
  ): {
    summary: string;
    source: 'initial' | 'replan';
    steps: Array<{
      description: string;
      executionMode: ExecutionMode;
      expectedState?: Record<string, string>;
      completionCondition?: string;
      driftCondition?: string;
    }>;
  } {
    const input = (toolBlock.input || {}) as Record<string, unknown>;
    const rawSteps = Array.isArray(input.steps) ? input.steps : [];
    const source = input.source === 'replan' ? 'replan' : 'initial';
    const isMediaTask = this.isMediaTask(task.description);
    const security = this.getTaskSecurityState(task);
    const expandedSteps = rawSteps.flatMap((step) =>
      this.expandCredentialEntryStep(step as Record<string, unknown>, source),
    );
    const filteredSteps = expandedSteps
      .filter(
        (step) =>
          step &&
          typeof step === 'object' &&
          typeof (step as Record<string, unknown>).description === 'string' &&
          !this.isRedundantApplicationLaunchStep(
            String((step as Record<string, unknown>).description || ''),
            security.execution?.lastOpenedApplication,
            security.execution?.lastApplicationOpenedAt,
          ) &&
          !(
            isMediaTask &&
            /(show transcript|transcript|captions|subtitles|meeting notes|lyrics)/i.test(
              String((step as Record<string, unknown>).description || ''),
            )
          ),
      );
    const steps = filteredSteps
      .slice(0, 5)
      .map((step, index) =>
        this.buildDesktopStepInput(task, {
          id: `${toolBlock.id}-queued-${index}`,
          type: MessageContentType.ToolUse,
          name: 'execute_desktop_step',
          input: {
            ...(step as Record<string, unknown>),
            execution_mode:
              typeof (step as Record<string, unknown>).execution_mode ===
              'string'
                ? ((step as Record<string, unknown>).execution_mode as string)
                : source === 'replan' && index === 0
                  ? 'guarded'
                  : undefined,
          },
        } as ToolUseContentBlock),
      );

    return {
      summary:
        typeof input.summary === 'string' && input.summary.trim()
          ? input.summary.trim()
          : 'Queued desktop execution plan ready.',
      source,
      steps,
    };
  }

  private buildQueuedSummaryFromStep(description: string): string {
    const trimmed = description.trim();
    if (!trimmed) {
      return 'Queued desktop execution plan ready.';
    }

    return trimmed.length <= 160
      ? trimmed
      : `${trimmed.slice(0, 157).trimEnd()}...`;
  }

  private isRedundantApplicationLaunchStep(
    description: string,
    lastOpenedApplication?: string,
    lastOpenedAt?: string,
  ): boolean {
    if (!lastOpenedApplication || !lastOpenedAt) {
      return false;
    }

    const openedAtMs = Date.parse(lastOpenedAt);
    if (!Number.isFinite(openedAtMs) || Date.now() - openedAtMs > 30_000) {
      return false;
    }

    const normalizedDescription = description.toLowerCase();
    const normalizedApp = lastOpenedApplication.toLowerCase();
    const appMatches =
      (normalizedApp === 'brave' &&
        /\b(brave|browser|chrome)\b/.test(normalizedDescription)) ||
      normalizedDescription.includes(normalizedApp);

    if (!appMatches) {
      return false;
    }

    return (
      /\b(double-?click|launch|start|reopen)\b/i.test(normalizedDescription) ||
      /\bclick .*icon\b/i.test(normalizedDescription) ||
      /\bdesktop icon\b/i.test(normalizedDescription) ||
      /\bopen\b.{0,40}\b(brave|browser|chrome)\b/i.test(normalizedDescription)
    );
  }

  private expandCredentialEntryStep(
    step: Record<string, unknown>,
    source: 'initial' | 'replan',
  ): Record<string, unknown>[] {
    const description = String(step.description || '').trim();
    if (!description) {
      return [step];
    }

    const hasUsername = /\[\[secure:username\]\]/i.test(description);
    const hasPassword = /\[\[secure:password\]\]/i.test(description);
    const hasOtp = /\[\[secure:otp\]\]/i.test(description);
    const placeholderCount = [hasUsername, hasPassword, hasOtp].filter(Boolean).length;

    if (placeholderCount <= 1) {
      return [step];
    }

    const baseExecutionMode =
      typeof step.execution_mode === 'string'
        ? step.execution_mode
        : source === 'replan'
          ? 'guarded'
          : undefined;
    const shared = {
      execution_mode: baseExecutionMode,
      drift_condition:
        typeof step.drift_condition === 'string'
          ? step.drift_condition
          : undefined,
    };
    const prefix = this.buildCredentialStepPrefix(description);
    const results: Record<string, unknown>[] = [];

    if (hasUsername) {
      results.push({
        ...shared,
        description: `${prefix}Enter username [[secure:username]] in the email or username field. Do not submit yet.`,
        completion_condition:
          'Complete only when the email or username field is visibly populated with the saved username and the password field remains available.',
      });
    }

    if (hasPassword) {
      results.push({
        ...shared,
        description: `${prefix}Enter password [[secure:password]] in the password field and continue the sign-in flow.`,
        completion_condition:
          'Complete only when the password field has been populated and the sign-in flow has advanced or is ready for the next visible login boundary.',
        expected_state:
          !hasOtp && step.expected_state && typeof step.expected_state === 'object'
            ? step.expected_state
            : undefined,
      });
    }

    if (hasOtp) {
      results.push({
        ...shared,
        description: `${prefix}Enter verification code [[secure:otp]] if the site asks for it, then continue to the logged-in state.`,
        completion_condition:
          'Complete only when the verification code has been entered into the visible code field and the logged-in page is loading or open.',
        expected_state:
          step.expected_state && typeof step.expected_state === 'object'
            ? step.expected_state
            : undefined,
      });
    }

    return results.length > 0 ? results : [step];
  }

  private buildCredentialStepPrefix(description: string): string {
    const normalized = description.replace(/\s+/g, ' ').trim();
    const match = normalized.match(
      /^(.*?\b(?:navigate to|open|go to|return to)\b.*?)(?:\.\s+|\s+enter\b|$)/i,
    );

    return match?.[1] ? `${match[1].trim()} ` : '';
  }

  private buildGuardedRecoveryBrief(
    task: Task,
    rawStepDescriptions: string[],
    plannerSummary?: string,
  ): string {
    const cleanedSteps = rawStepDescriptions
      .map((step) => step.trim())
      .filter(Boolean)
      .slice(0, 6);
    const checklist = cleanedSteps.length
      ? `Recovery checklist:\n- ${cleanedSteps.join('\n- ')}`
      : '';
    const summaryLine =
      plannerSummary && plannerSummary.trim()
        ? `Planner recovery summary: ${plannerSummary.trim()}\n\n`
        : '';
    const routeLine =
      this.isMediaTask(task.description) &&
      this.getMediaRoute(task) !== 'unsupported_media'
        ? `Media route: stay on ${this.detectMediaKind(task.description) === 'meeting' ? this.buildMeetingSurfacePhrase(task.description) : this.buildSupportedVideoSurfacePhrase(task.description)} and recover back to that chosen platform if the current page is on the wrong surface.\n\n`
        : '';

    return `Recovery brief: fix the current blocked state for the user's task from the current visible screen without restarting healthy progress.\n\nUser goal: ${this.getCurrentTurnGoal(task)}\n\n${summaryLine}${routeLine}Recover only the specific issue that is blocking progress right now. Reuse the current page if it is still useful. Do not reopen already useful pages, do not re-enter already correct values, and do not restart from scratch unless the visible state clearly contradicts the task. If the blocked issue is resolved and the requested result is now clearly visible, stop immediately and summarize it. Otherwise fix the blocker cleanly, then stop so normal execution can resume.\n\n${checklist ? `${checklist}\n\n` : ''}Do not guess. If the page is still genuinely blocked after one careful recovery attempt, summarize the exact blocker instead of improvising.`;
  }

  private extractSearchQueryFromGoal(goal: string): string | null {
    const normalized = goal.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return null;
    }

    const explicitMatch = normalized.match(
      /\b(?:search (?:for|about)?|look up|lookup|find|check|research|read about)\s+(.+?)(?:\s+(?:and|then)\s+(?:give|provide|create|write|summari[sz]e|tell me)|$)/i,
    );
    const candidate = explicitMatch?.[1]?.trim();
    if (candidate) {
      return candidate.replace(/^for\s+/i, '').trim();
    }

    if (/\b(latest|search|find|lookup|look up|research|summary|summari[sz]e)\b/i.test(normalized)) {
      return normalized;
    }

    return null;
  }

  private shouldUseActiveFastHandoff(
    task: Task,
    steps: Array<{
      description: string;
      executionMode?: ExecutionMode;
    }>,
  ): boolean {
    if (steps.length !== 1) {
      return false;
    }

    if (this.shouldUseQueuedExecution(task)) {
      return false;
    }

    return steps.length === 1;
  }

  private shouldUseQueuedExecution(task: Task): boolean {
    return false;
  }

  private async storeActiveExecutionHandoff(
    taskId: string,
    task: Task,
    handoff: {
      summary: string;
      source: 'initial' | 'replan';
      step: {
        description: string;
        executionMode: ExecutionMode;
        expectedState?: Record<string, string>;
        completionCondition?: string;
        driftCondition?: string;
      };
    },
  ): Promise<Task> {
    const security = this.getTaskSecurityState(task);
    const updatedResult = this.mergeTaskResult(task, {
      security: applySessionActiveBranch(
        {
          ...security,
          ...(security.preflight && {
            preflight: {
              ...security.preflight,
              executionStarted: true,
            },
          }),
          execution: {
            ...(security.execution || {}),
            activeExecution: {
              ...handoff.step,
              source: handoff.source,
              createdAt: new Date().toISOString(),
              startedAt: undefined,
              completedAt: undefined,
              blockedAt: undefined,
              blockReason: undefined,
            },
            blockedStep: undefined,
            currentStep: undefined,
            mediaQueue: [],
            mediaPlan: undefined,
          },
        },
        'executing',
        {
          phase: 'active',
          awaitingUserDecision: false,
        },
      ),
    });

    await this.tasksService.update(taskId, {
      result: updatedResult,
    });
    task.result = updatedResult as any;
    return task;
  }

  private async markResultReviewPending(
    taskId: string,
    task: Task,
  ): Promise<Task> {
    const security = this.getTaskSecurityState(task);
    const updatedResult = this.mergeTaskResult(task, {
      security: {
        ...security,
        execution: {
          ...(security.execution || {}),
          resultReview: {
            ...(security.execution?.resultReview || {}),
            pending: true,
            requestedAt: new Date().toISOString(),
            completedAt: undefined,
            lastDescription: undefined,
            lastSummary: undefined,
            followUpCount: security.execution?.resultReview?.followUpCount || 0,
          },
        },
      },
    });

    await this.tasksService.update(taskId, {
      result: updatedResult,
    });
    task.result = updatedResult as any;
    return task;
  }

  private async maybeLaunchDirectTurnExecution(
    taskId: string,
    task: Task,
  ): Promise<{ task: Task; halted: boolean }> {
    if (this.shouldUseQueuedExecution(task)) {
      return { task, halted: false };
    }

    const security = this.getTaskSecurityState(task);
    if (this.shouldHoldForMediaMonitoring(task, security)) {
      return { task, halted: false };
    }
    if (
      task.createdBy !== Role.USER ||
      !security.preflight?.confirmedAt ||
      security.preflight?.awaitingUserResponse ||
      security.preflight?.followUpPending ||
      security.pendingConfirmation ||
      security.execution?.activeExecution ||
      security.execution?.mediaQueue?.length ||
      (security.execution?.mediaPlan?.totalSteps || 0) > 0 ||
      security.execution?.resultReview?.pending ||
      security.execution?.blockedStep
    ) {
      return { task, halted: false };
    }

    const turnPlan =
      security.preflight?.plan?.trim() ||
      `Complete the current turn goal from the current on-screen state: ${this.getCurrentTurnGoal(task)}`;
    const directTask = await this.storePlannerExecutionSequence(
      taskId,
      task,
      turnPlan,
      security.preflight?.planSteps,
      'initial',
    );

    return this.executeActiveHandoffIfPresent(taskId, directTask);
  }

  private async storePlannerExecutionSequence(
    taskId: string,
    task: Task,
    planSummary: string,
    planSteps: string[] | undefined,
    source: 'initial' | 'replan',
  ): Promise<Task> {
    let effectivePlanSummary = planSummary;
    let plannerGuidelines =
      this.getTaskSecurityState(task).preflight?.guidelines?.length
        ? this.getTaskSecurityState(task).preflight?.guidelines
        : this.defaultPlannerGuidelines();
    let normalizedSteps = this.plannerPlanCompiler.refinePlannerStepsForGoal(
      this.getCurrentTurnGoal(task),
      planSteps?.length
        ? planSteps
        : this.plannerPlanCompiler.derivePlanStepsFromPlanText(planSummary)
    );

    if (normalizedSteps.length === 0) {
      normalizedSteps = this.plannerPlanCompiler.refinePlannerStepsForGoal(
        this.getCurrentTurnGoal(task),
        this.plannerPlanCompiler.deriveGoalOnlyPlanCandidates(
          this.getCurrentTurnGoal(task),
        ),
      );
    }

    const quality = this.plannerPlanCompiler.scorePlannerStepQuality(
      this.getCurrentTurnGoal(task),
      normalizedSteps,
    );

    if (quality.weak) {
      const directGoalSteps = this.plannerPlanCompiler.refinePlannerStepsForGoal(
        this.getCurrentTurnGoal(task),
        this.plannerPlanCompiler.deriveGoalOnlyPlanCandidates(
          this.getCurrentTurnGoal(task),
        ),
      );
      if (directGoalSteps.length > 0) {
        normalizedSteps = directGoalSteps;
        effectivePlanSummary =
          effectivePlanSummary ||
          `Execute the current turn goal step by step: ${this.getCurrentTurnGoal(task)}`;
      }
    }

    if (normalizedSteps.length <= 1) {
      const executorPlan = this.normalizePlannerExecutionBrief(
        task,
        normalizedSteps[0] || effectivePlanSummary,
      );
      const expectedState = this.buildChosenPlatformExpectedState(
        task,
        normalizedSteps[0] || effectivePlanSummary,
      );
      return this.storeActiveExecutionHandoff(taskId, task, {
        summary: executorPlan,
        source,
        step: {
          description: this.appendPlannerGuidelines(executorPlan, plannerGuidelines || []),
          executionMode: this.inferExecutionMode(
            task,
            normalizedSteps[0] || effectivePlanSummary,
            source === 'replan' ? 'guarded' : undefined,
            expectedState,
          ),
          expectedState,
          completionCondition:
            'Only mark this step complete when the requested visible result, answer-ready state, or confirmation is on screen.',
          driftCondition:
            'Drift exists only if the visible page is clearly the wrong page, a login wall, a CAPTCHA wall, a blank or unusable page, or another blocker that prevents reaching the requested visible result.',
        },
      });
    }

    const builtSteps = normalizedSteps.map((step, index) =>
      this.buildPlannerExecutionStep(
        task,
        step,
        index,
        normalizedSteps.length,
        source,
        plannerGuidelines || [],
      ),
    );

    const [firstStep, ...remainingSteps] = builtSteps;
    const security = this.getTaskSecurityState(task);
    const updatedResult = this.mergeTaskResult(task, {
      security: applySessionActiveBranch(
        {
          ...security,
          ...(security.preflight && {
            preflight: {
              ...security.preflight,
              executionStarted: true,
            },
          }),
          execution: {
            ...(security.execution || {}),
            activeExecution: {
              ...firstStep,
              source,
              createdAt: new Date().toISOString(),
              startedAt: undefined,
              completedAt: undefined,
              blockedAt: undefined,
              blockReason: undefined,
            },
            pendingSteps: remainingSteps,
            stepPlan: {
              summary: effectivePlanSummary,
              guidelines: plannerGuidelines || [],
              source,
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              currentIndex: 1,
              totalSteps: builtSteps.length,
              completedAt: undefined,
            },
            blockedStep: undefined,
            currentStep: undefined,
            mediaQueue: [],
            mediaPlan: undefined,
          },
        },
        'executing',
        {
          phase: 'active',
          awaitingUserDecision: false,
        },
      ),
    });

    await this.tasksService.update(taskId, {
      result: updatedResult,
    });
    task.result = updatedResult as any;
    const planPreview = this.buildUserVisiblePlannerPlan(task, normalizedSteps);
    if (planPreview) {
      await this.messagesService.create({
        role: Role.ASSISTANT,
        taskId,
        content: [
          {
            type: MessageContentType.Text,
            text: planPreview,
          },
        ],
      });
    }
    const progressUpdate = planPreview
      ? null
      : this.buildExecutionProgressUpdate(task, firstStep.description, source);
    if (progressUpdate) {
      await this.messagesService.create({
        role: Role.ASSISTANT,
        taskId,
        content: [
          {
            type: MessageContentType.Text,
            text: progressUpdate,
          },
        ],
      });
    }
    return task;
  }

  private buildUserVisiblePlannerPlan(
    task: Task,
    steps: string[],
  ): string | null {
    if (steps.length === 0) {
      return null;
    }

    const compactSteps = steps
      .map((step) => this.toUserFacingPlannerStep(step))
      .filter(Boolean)
      .slice(0, 5);

    if (compactSteps.length === 0) {
      return null;
    }

    return `Plan:\n${compactSteps
      .map((step, index) => `${index + 1}. ${step}`)
      .join('\n')}`;
  }

  private rebuildRemainingPlannedSteps(
    task: Task,
    stepPlan:
      | (NonNullable<TaskSecurityState['execution']>['stepPlan'] & {
          totalSteps?: number;
          currentIndex?: number;
        })
      | undefined,
  ): Array<{
    description: string;
    executionMode: ExecutionMode;
    expectedState?: Record<string, string>;
    completionCondition?: string;
    driftCondition?: string;
  }> {
    if (!stepPlan || (stepPlan.totalSteps || 0) <= 1) {
      return [];
    }

    const currentIndex = Math.max(1, stepPlan.currentIndex || 1);
    if (currentIndex >= (stepPlan.totalSteps || 0)) {
      return [];
    }

    const security = this.getTaskSecurityState(task);
    const source = stepPlan.source || 'initial';
    const guidelines = stepPlan.guidelines?.length
      ? stepPlan.guidelines
      : security.preflight?.guidelines?.length
        ? security.preflight.guidelines
        : this.defaultPlannerGuidelines();
    const seedSteps =
      security.preflight?.planSteps?.length
        ? security.preflight.planSteps
        : this.plannerPlanCompiler.derivePlanStepsFromPlanText(
            stepPlan.summary || this.getCurrentTurnGoal(task),
          );
    const normalizedSteps = this.plannerPlanCompiler.refinePlannerStepsForGoal(
      this.getCurrentTurnGoal(task),
      seedSteps,
    );

    if (normalizedSteps.length === 0) {
      return [];
    }

    const builtSteps = normalizedSteps.map((step, index) =>
      this.buildPlannerExecutionStep(
        task,
        step,
        index,
        normalizedSteps.length,
        source,
        guidelines || [],
      ),
    );

    return builtSteps.slice(currentIndex);
  }

  private toUserFacingPlannerStep(description: string): string {
    const firstLine = (description || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);

    return (firstLine || description || '')
      .replace(/^planner execution brief:\s*/i, '')
      .replace(/^recovery brief:\s*/i, '')
      .replace(/^step\s+\d+\s+of\s+\d+\.\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private buildExecutionProgressUpdate(
    task: Task,
    description: string,
    source: 'initial' | 'replan',
  ): string | null {
    const visibleStep = this.toUserFacingPlannerStep(description);
    if (!visibleStep) {
      return source === 'replan'
        ? 'Planner: recovering from the current state.'
        : 'Planner: continuing with the next planned step.';
    }

    const lower = visibleStep.toLowerCase();
    const stepPrefix = /^step\s+\d+\s+of\s+\d+\./i.test(description)
      ? description.match(/^.*?(step\s+\d+\s+of\s+\d+\.)/i)?.[1]
      : null;
    const normalizedStepPrefix = stepPrefix
      ? stepPrefix.replace(/\s+/g, ' ').trim()
      : null;

    if (!this.isMediaTask(task.description)) {
      return `Planner: ${normalizedStepPrefix ? `${normalizedStepPrefix} ` : ''}${visibleStep}`;
    }

    const media = this.getTaskSecurityState(task).media;
    if (this.detectMediaKind(task.description) === 'meeting') {
      return `Planner: ${normalizedStepPrefix ? `${normalizedStepPrefix} ` : ''}${visibleStep}`;
    }

    if (
      !media?.playbackVerifiedAt &&
      (this.isMediaOpeningLikeStep(task.description, lower) ||
        /requested item|player/.test(lower))
    ) {
      return `Planner: ${normalizedStepPrefix ? `${normalizedStepPrefix} ` : ''}${visibleStep || `Open ${this.buildChosenMediaSurfacePhrase(task.description)} and search for the requested item.`}`;
    }

    if (/playback actually starts|actively playing|resume|paused/.test(lower)) {
      return 'Verification: checking that the requested media is actually playing.';
    }

    if (/until it ends|finalize the requested transcript|requested media has already finished|continue monitoring/.test(lower)) {
      return `Planner: ${normalizedStepPrefix ? `${normalizedStepPrefix} ` : ''}${visibleStep || 'Let the requested media finish, then prepare the requested output.'}`;
    }

    return source === 'replan'
      ? `Planner: recovering from the current page${visibleStep ? ` to ${visibleStep.toLowerCase()}` : '.'}`
      : `Planner: ${visibleStep || 'working through the media flow.'}`;
  }

  private async emitMediaProgressUpdate(
    task: Task,
    text: string | null | undefined,
  ): Promise<void> {
    if (!text?.trim()) {
      return;
    }

    await this.messagesService.create({
      role: Role.ASSISTANT,
      taskId: task.id,
      content: [
        {
          type: MessageContentType.Text,
          text: text.trim(),
        },
      ],
    });
  }

  private buildMediaStateProgressUpdate(
    task: Task,
    previousMedia: NonNullable<TaskSecurityState['media']> | undefined,
    nextMedia: NonNullable<TaskSecurityState['media']>,
    watchdogSignal: ExecutionWatchdogReason | null,
  ): string | null {
    const updates: string[] = [];

    if (watchdogSignal === 'wrong_surface') {
      return `Verification: wrong site detected. Returning to ${this.buildChosenMediaSurfacePhrase(task.description)} now.`;
    }

    if (watchdogSignal === 'media_mismatch') {
      return `Verification: the current media does not satisfy the request. Choosing a better visible match on ${this.buildChosenMediaSurfacePhrase(task.description)} now.`;
    }

    if (
      !previousMedia?.playbackVerifiedAt &&
      nextMedia.playbackVerifiedAt &&
      nextMedia.kind !== 'meeting'
    ) {
      updates.push(
        `Verification: playback is confirmed on ${this.buildChosenMediaSurfacePhrase(task.description)}.`,
      );
    }

    if (
      !previousMedia?.playbackVerifiedAt &&
      previousMedia?.phase !== 'playback_verification' &&
      nextMedia.phase === 'playback_verification'
    ) {
      updates.push(
        nextMedia.kind === 'meeting'
          ? 'Verification: checking that the meeting is visibly joined.'
          : `Verification: checking that the requested media is actually playing on ${this.buildChosenMediaSurfacePhrase(task.description)}.`,
      );
    }

    if (
      previousMedia?.phase !== 'monitoring' &&
      nextMedia.phase === 'monitoring' &&
      nextMedia.kind === 'meeting'
    ) {
      updates.push('Verification: meeting join looks good. Monitoring quietly now.');
    }

    if (!previousMedia?.recordingStartedAt && nextMedia.recordingStartedAt) {
      updates.push(
        nextMedia.kind === 'meeting'
          ? 'Progress: recording started for this meeting and will continue until it clearly ends.'
          : 'Progress: recording started for the requested media and will continue until it clearly finishes.',
      );
    }

    if (
      !previousMedia?.completionLatchedAt &&
      nextMedia.completionLatchedAt
    ) {
      updates.push(
        nextMedia.kind === 'meeting'
          ? 'Progress: the meeting has clearly ended. Stopping work on the live session and finalizing now.'
          : 'Progress: the requested media has clearly finished. Stopping playback and finalizing now.',
      );
    }

    if (
      previousMedia?.transcriptionStatus !== 'failed' &&
      nextMedia.transcriptionStatus === 'failed' &&
      nextMedia.transcriptionError
    ) {
      updates.push(`Issue: recording or transcript capture hit a problem: ${nextMedia.transcriptionError}`);
    }

    if (
      previousMedia?.phase !== 'transcribing' &&
      nextMedia.phase === 'transcribing'
    ) {
      updates.push('Progress: the requested media ended. Finalizing the recording and generating the transcript now.');
    }

    if (
      previousMedia?.phase !== 'summarizing' &&
      nextMedia.phase === 'summarizing'
    ) {
      updates.push('Progress: transcript ready. Generating the summary now.');
    }

    if (
      previousMedia?.transcriptionStatus !== 'ready' &&
      nextMedia.transcriptionStatus === 'ready'
    ) {
      updates.push('Completed: transcript and summary are ready.');
    }

    return updates.length > 0 ? updates.join(' ') : null;
  }

  private shouldAutoContinueMediaConfirmation(
    task: Task,
    summary: {
      prompt: string;
      actionName: string;
      stepDescription: string;
    },
    currentUrl?: string,
  ): boolean {
    if (!this.isMediaTask(task.description)) {
      return false;
    }

    if (this.isHumanOnlyAttentionNeeded(summary.prompt)) {
      return false;
    }

    const media = this.getTaskSecurityState(task).media;
    if (!media) {
      return false;
    }

    if (
      media.phase !== 'opening' &&
      media.phase !== 'playback_verification' &&
      media.phase !== 'network_recovery'
    ) {
      return false;
    }

    const normalizedUrl = (currentUrl || '').toLowerCase();
    const normalizedContext = `${summary.prompt}\n${summary.stepDescription}`.toLowerCase();
    const likelyYouTubePlaybackContext =
      /(youtube|watch page|video player|ready for playback|player is visible|search results|filters button|filter results|tedx talk|ted talk)/i.test(
        normalizedContext,
      );
    const likelyMeetingContext =
      /(google meet|zoom|teams|meeting is visible|meeting page|join state|attendance)/i.test(
        normalizedContext,
      );
    if (
      media.kind === 'meeting' &&
      !(
        /(meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com)/i.test(
          normalizedUrl,
        ) || likelyMeetingContext
      )
    ) {
      return false;
    }

    if (
      media.kind !== 'meeting' &&
      !(
        /(youtube\.com|youtu\.be)/i.test(normalizedUrl) ||
        likelyYouTubePlaybackContext
      )
    ) {
      return false;
    }

    if (
      !['click', 'click_at', 'type_text_at', 'type_text', 'press_key'].includes(
        summary.actionName,
      )
    ) {
      return false;
    }

    return true;
  }

  private isSensitiveTaskConfirmation(
    task: Task,
    summary: {
      prompt: string;
      actionName: string;
      stepDescription: string;
    },
  ): boolean {
    const combined = [
      task.description,
      summary.prompt,
      summary.stepDescription,
      summary.actionName,
    ]
      .filter(Boolean)
      .join('\n')
      .toLowerCase();

    const riskyCommitAction =
      /\b(send|purchase|buy|pay|payment|book|booking|checkout|delete|remove|cancel booking|confirm order|place order|transfer|wire|post|publish)\b/i.test(
        combined,
      );
    const submitLikeCommit =
      /\bsubmit\b/i.test(combined) &&
      /\b(email|message|application|order|booking|payment|purchase|checkout|form submission|final submit)\b/i.test(
        combined,
      );

    return riskyCommitAction || submitLikeCommit;
  }

  private shouldAutoContinueTaskConfirmation(
    task: Task,
    summary: {
      prompt: string;
      actionName: string;
      stepDescription: string;
    },
    currentUrl?: string,
  ): boolean {
    if (summary.actionName === 'human_attention_needed') {
      return false;
    }

    if (this.isHumanOnlyAttentionNeeded(summary.prompt)) {
      return false;
    }

    if (this.isSensitiveTaskConfirmation(task, summary)) {
      return false;
    }

    if (
      this.shouldAutoContinueMediaConfirmation(task, summary, currentUrl)
    ) {
      return true;
    }

    return true;
  }

  private normalizePlannerExecutionBrief(task: Task, plan: string): string {
    const trimmed = plan.trim();
    if (!trimmed) {
      return `Planner execution brief: complete the current turn goal from the current state: ${this.getCurrentTurnGoal(task)}`;
    }

    if (this.isStructuredExecutionBrief(trimmed)) {
      return trimmed;
    }

    return `Planner execution brief: ${trimmed.replace(/\s+/g, ' ').trim()}`;
  }

  private buildPlannerExecutionStep(
    task: Task,
    step: string,
    index: number,
    totalSteps: number,
    source: 'initial' | 'replan',
    guidelines: string[],
  ): {
    description: string;
    executionMode: ExecutionMode;
    expectedState?: Record<string, string>;
    completionCondition?: string;
    driftCondition?: string;
  } {
    const goal = this.getCurrentTurnGoal(task);
    const normalizedStep = step.replace(/\s+/g, ' ').trim();
    const stopCondition = this.buildPlannerStepCompletionCondition(
      goal,
      normalizedStep,
    );

    return {
      description: this.appendPlannerGuidelines(
        this.normalizePlannerExecutionBrief(
          task,
          `Step ${index + 1} of ${totalSteps}. ${normalizedStep}`,
        ),
        guidelines,
      ),
      executionMode: this.inferExecutionMode(
        task,
        normalizedStep,
        source === 'replan' && index === 0 ? 'guarded' : undefined,
        this.buildChosenPlatformExpectedState(task, normalizedStep),
      ),
      expectedState: this.buildChosenPlatformExpectedState(task, normalizedStep),
      completionCondition: stopCondition,
      driftCondition:
        'Drift exists only if the visible page is clearly unrelated, blocked by login or CAPTCHA, or contradicts the current step target.',
    };
  }

  private appendPlannerGuidelines(
    description: string,
    guidelines: string[],
  ): string {
    void guidelines;
    return description;
  }

  private async storeQueuedExecutionPlan(
    taskId: string,
    task: Task,
    queuedPlan: {
      summary: string;
      source: 'initial' | 'replan';
      steps: Array<{
        description: string;
        executionMode: ExecutionMode;
        expectedState?: Record<string, string>;
        completionCondition?: string;
        driftCondition?: string;
      }>;
    },
  ): Promise<Task> {
    const security = this.getTaskSecurityState(task);
    const updatedResult = this.mergeTaskResult(task, {
      security: {
        ...security,
          execution: {
            ...(security.execution || {}),
            activeExecution: undefined,
            blockedStep: undefined,
            currentStep: undefined,
            mediaQueue: queuedPlan.steps,
            mediaPlan: {
            summary: queuedPlan.summary,
            source: queuedPlan.source,
            createdAt: new Date().toISOString(),
            currentIndex: 0,
            totalSteps: queuedPlan.steps.length,
            blockedAt: undefined,
            blockReason: undefined,
            completedAt: undefined,
          },
        },
      },
    });

    await this.tasksService.update(taskId, {
      result: updatedResult,
    });
    task.result = updatedResult as any;
    return task;
  }

  private async storeNormalExecutionSequenceFromSteps(
    taskId: string,
    task: Task,
    summary: string,
    source: 'initial' | 'replan',
    steps: Array<{
      description: string;
      executionMode: ExecutionMode;
      expectedState?: Record<string, string>;
      completionCondition?: string;
      driftCondition?: string;
    }>,
  ): Promise<Task> {
    if (steps.length === 0) {
      return task;
    }

    const [firstStep, ...remainingSteps] = steps;
    const security = this.getTaskSecurityState(task);
    const plannerGuidelines =
      security.preflight?.guidelines?.length
        ? security.preflight.guidelines
        : this.defaultPlannerGuidelines();
    const updatedResult = this.mergeTaskResult(task, {
      security: applySessionActiveBranch(
        {
          ...security,
          ...(security.preflight && {
            preflight: {
              ...security.preflight,
              executionStarted: true,
            },
          }),
          execution: {
            ...(security.execution || {}),
            activeExecution: {
              ...firstStep,
              source,
              createdAt: new Date().toISOString(),
              startedAt: undefined,
              completedAt: undefined,
              blockedAt: undefined,
              blockReason: undefined,
            },
            pendingSteps: remainingSteps,
            stepPlan: {
              summary,
              guidelines: plannerGuidelines,
              source,
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              currentIndex: 1,
              totalSteps: steps.length,
              completedAt: undefined,
            },
            blockedStep: undefined,
            currentStep: undefined,
            mediaQueue: [],
            mediaPlan: undefined,
          },
        },
        'executing',
        {
          phase: 'active',
          awaitingUserDecision: false,
        },
      ),
    });

    await this.tasksService.update(taskId, {
      result: updatedResult,
    });
    task.result = updatedResult as any;
    const progressUpdate = this.buildExecutionProgressUpdate(
      task,
      firstStep.description,
      source,
    );
    if (progressUpdate) {
      await this.messagesService.create({
        role: Role.ASSISTANT,
        taskId,
        content: [
          {
            type: MessageContentType.Text,
            text: progressUpdate,
          },
        ],
      });
    }
    return task;
  }

  private buildExecutionStartToolText(task: Task, summary: string): string {
    const normalizedSummary = summary?.trim() || 'Execution started.';
    return `${normalizedSummary} Allyra is now working from the current visible state and will continue until the requested result is ready or a real blocker appears.`;
  }

  private buildMediaPlanStartToolText(summary: string, stepCount: number): string {
    const normalizedSummary = summary?.trim() || 'Media execution started.';
    return `${normalizedSummary} The media or meeting flow is running in ${stepCount} step${stepCount === 1 ? '' : 's'}.`;
  }

  private buildPublicExecutionTraceDescription(
    task: Task,
    description: string,
    taskGoal: string,
  ): string {
    const trimmed = (description || '').trim();
    if (!trimmed) {
      return taskGoal;
    }

    if (/^(?:planner execution brief):/i.test(trimmed)) {
      return taskGoal;
    }

    if (/^recovery brief:/i.test(trimmed)) {
      const reason =
        this.getTaskSecurityState(task).execution?.watchdog?.lastTriggerReason;
      return reason
        ? `Recovery step (${reason.replace(/_/g, ' ')})`
        : 'Recovery step';
    }

    return trimmed.length > 160 ? taskGoal : trimmed;
  }

  private buildCompactStepProgressText(
    currentIndex: number | undefined,
    totalSteps: number | undefined,
    summaryText: string,
  ): string | null {
    const normalizedSummary = this.normalizeUserFacingSummaryText(summaryText)
      .replace(/\s+/g, ' ')
      .trim();
    if (
      !normalizedSummary ||
      this.isPlaceholderExecutionSummary(normalizedSummary) ||
      this.isRawActionOnlySummary(normalizedSummary)
    ) {
      return null;
    }
    const conciseSummary =
      normalizedSummary.length > 220
        ? `${normalizedSummary.slice(0, 217).trimEnd()}...`
        : normalizedSummary;
    const prefix =
      currentIndex && totalSteps
        ? `Verification: step ${currentIndex}/${totalSteps} is complete`
        : 'Verification: step complete';

    return conciseSummary ? `${prefix}. ${conciseSummary}` : null;
  }

  private buildCompactRecoveryText(
    currentIndex: number | undefined,
    totalSteps: number | undefined,
    reasonText: string,
  ): string {
    const normalizedReason = this.normalizeUserFacingSummaryText(reasonText)
      .replace(/\s+/g, ' ')
      .trim();
    const conciseReason =
      normalizedReason.length > 220
        ? `${normalizedReason.slice(0, 217).trimEnd()}...`
        : normalizedReason;
    const prefix =
      currentIndex && totalSteps
        ? `Watchdog: issue detected on step ${currentIndex}/${totalSteps}`
        : 'Watchdog: issue detected';

    return conciseReason
      ? `${prefix}. ${conciseReason} Recovering from the current state.`
      : `${prefix}. Recovering from the current state.`;
  }

  private async executeQueuedPlanIfPresent(
    taskId: string,
    task: Task,
  ): Promise<{ task: Task; halted: boolean }> {
    const security = this.getTaskSecurityState(task);
    const execution = security.execution;
    const mediaQueue = [...(execution?.mediaQueue || [])];

    if (mediaQueue.length === 0) {
      return { task, halted: false };
    }

    if (!this.shouldUseQueuedExecution(task)) {
      const source =
        execution?.mediaPlan?.source === 'replan' || execution?.blockedStep
          ? 'replan'
          : 'initial';
      const promotedTask = await this.storeNormalExecutionSequenceFromSteps(
        taskId,
        task,
        execution?.mediaPlan?.summary ||
          (source === 'replan'
            ? 'Recovery handoff ready.'
            : 'Execution handoff ready.'),
        source,
        mediaQueue.map((step) => ({
          ...step,
          executionMode: step.executionMode || 'fast',
          expectedState:
            (step.expectedState as Record<string, string> | undefined) ||
            undefined,
        })),
      );

      return { task: promotedTask, halted: false };
    }

    let currentTask = task;
    let remainingQueue = mediaQueue;
    const totalSteps =
      execution?.mediaPlan?.totalSteps || execution?.mediaQueue?.length || mediaQueue.length;
    let currentIndex = execution?.mediaPlan?.currentIndex || 0;
    let mediaPlan = {
      ...(execution?.mediaPlan || {}),
      startedAt:
        execution?.mediaPlan?.startedAt || new Date().toISOString(),
      totalSteps,
    };

    while (remainingQueue.length > 0) {
      const nextStep = remainingQueue[0];
      const turnGoal = this.getCurrentTurnGoal(currentTask);
      this.logger.log(
        `Executing queued plan step ${currentIndex + 1}/${totalSteps} for task ${taskId}: "${nextStep.description}"`,
      );

      const summary = await this.computerUseExecutor.runStep(
        taskId,
        nextStep,
        turnGoal,
        this.abortController!.signal,
      );

      const immediateHumanOnlyPrompt = this.getImmediateHumanOnlyAttentionPrompt(
        nextStep.description,
        summary.summary,
        summary.checkpoints,
        summary.currentUrl,
      );
      if (immediateHumanOnlyPrompt) {
        await this.tasksService.update(taskId, {
          status: TaskStatus.NEEDS_HELP,
          result: this.mergeTaskResult(currentTask, {
            security: {
              ...this.getTaskSecurityState(currentTask),
              execution: {
                ...(this.getTaskSecurityState(currentTask).execution || {}),
                mediaQueue: [],
                mediaPlan: {
                  ...mediaPlan,
                  currentIndex,
                  blockedAt: new Date().toISOString(),
                  blockReason: immediateHumanOnlyPrompt,
                },
              },
              session: {
                ...(this.getTaskSecurityState(currentTask).session || {}),
                keepAliveUntilUserDone: true,
                phase: 'needs_attention',
                activeBranch: 'needs_help',
                awaitingUserDecision: true,
              },
              pendingConfirmation: undefined,
            },
          }),
        });
        await this.messagesService.create({
          role: Role.ASSISTANT,
          taskId,
          content: [{ type: MessageContentType.Text, text: immediateHumanOnlyPrompt }],
        });
        this.releaseProcessingLease(taskId);
        return { task: currentTask, halted: true };
      }

      const screenshotData = this.shouldAttachTraceScreenshot(
        summary.mode,
        summary.status,
      )
        ? await this.getTraceScreenshotData(summary.screenshotBase64)
        : null;

      const traceText = buildExecutionTraceText({
        type: 'allyra_execution_trace',
        version: 1,
        mode: summary.mode,
        description: this.buildPublicExecutionTraceDescription(
          currentTask,
          nextStep.description,
          turnGoal,
        ),
        taskGoal: turnGoal,
        status: summary.status,
        summary: summary.summary,
        currentUrl: summary.currentUrl,
        expectedState: summary.expectedState,
        completionCondition: summary.completionCondition,
        driftCondition: summary.driftCondition,
        checkpoints: summary.checkpoints,
      });

      const resultContent: MessageContentBlock[] = [
        { type: MessageContentType.Text, text: traceText },
      ];
      if (screenshotData) {
        resultContent.push({
          type: MessageContentType.Image,
          source: {
            media_type: 'image/png',
            type: 'base64',
            data: screenshotData,
          },
        } as any);
      }
      await this.messagesService.create({
        content: [
          {
            type: MessageContentType.ToolResult,
            tool_use_id: `queued-plan-step-${Date.now()}`,
            content: resultContent,
          },
        ],
        role: Role.USER,
        taskId,
      });

      const executionUpdate = await this.updateExecutionState(
        currentTask,
        nextStep,
        {
          status: summary.status,
          summary: summary.summary,
          outcome: summary.outcome,
          checkpoints: summary.checkpoints,
          currentUrl: summary.currentUrl,
        },
      );
      currentTask.result = executionUpdate.result as any;
      const updatedSecurity = this.getTaskSecurityState(currentTask);
      const mediaEndedAfterStep =
        !!updatedSecurity.media?.selectedAt &&
        this.mediaReviewIndicatesEnded(
          updatedSecurity.media.lastSummary || summary.summary,
          updatedSecurity.media,
        );

      if (
        summary.outcome.kind === 'step_failed' &&
        summary.outcome.failureKind === 'provider_capacity'
      ) {
        if (
          await this.queueAutomaticMediaRecoveryStepIfNeeded(taskId, currentTask, {
            providerFailure: true,
            summaryText: summary.summary,
            reason: 'provider_capacity_failure',
          })
        ) {
          return { task: currentTask, halted: true };
        }
        await this.handleTerminalTaskStatus(
          currentTask,
          'needs_help',
          'I hit a temporary model/provider capacity limit while working on this task. Please retry in a moment, and I will continue from the same task state.',
        );
        this.releaseProcessingLease(taskId);
        return { task: currentTask, halted: true };
      }

      if (summary.requiresConfirmation) {
        if (
          this.shouldAutoContinueTaskConfirmation(
            currentTask,
            {
              prompt: summary.requiresConfirmation.prompt,
              actionName: summary.requiresConfirmation.actionName,
              stepDescription: summary.requiresConfirmation.stepDescription,
            },
            summary.currentUrl,
          )
        ) {
          const approvedAction = await this.computerUseExecutor.executeApprovedAction(
            taskId,
            summary.requiresConfirmation.actionName,
            summary.requiresConfirmation.actionArgs,
          );
          await this.emitMediaProgressUpdate(
            currentTask,
            'A clear next media action was available, so I continued automatically from the current page.',
          );
          const continuedUpdate = await this.updateExecutionState(
            currentTask,
            nextStep,
            {
              status: approvedAction.status,
              summary: approvedAction.summary,
              outcome: approvedAction.outcome,
              checkpoints: approvedAction.checkpoints,
              currentUrl: approvedAction.currentUrl,
            },
          );
          currentTask.result = continuedUpdate.result as any;
          continue;
        }

        const prompt = this.isHumanOnlyAttentionNeeded(
          summary.requiresConfirmation.prompt,
        )
          ? 'A CAPTCHA or human verification step is blocking progress. Please complete it in the desktop view, then send the next instruction here to continue.'
          : summary.requiresConfirmation.prompt;

        await this.tasksService.update(taskId, {
          status: this.isHumanOnlyAttentionNeeded(
            summary.requiresConfirmation.prompt,
          )
            ? TaskStatus.NEEDS_HELP
            : TaskStatus.NEEDS_REVIEW,
          result: this.mergeTaskResult(currentTask, {
            security: {
              ...this.getTaskSecurityState(currentTask),
              execution: {
                ...(this.getTaskSecurityState(currentTask).execution || {}),
                mediaQueue: [],
                mediaPlan: {
                  ...mediaPlan,
                  currentIndex,
                  blockedAt: new Date().toISOString(),
                  blockReason: prompt,
                },
              },
              session: {
                ...(this.getTaskSecurityState(currentTask).session || {}),
                keepAliveUntilUserDone: true,
                phase: 'needs_attention',
                activeBranch: this.isHumanOnlyAttentionNeeded(
                  summary.requiresConfirmation.prompt,
                )
                  ? 'needs_help'
                  : 'awaiting_confirmation',
                awaitingUserDecision: true,
              },
              pendingConfirmation: this.isHumanOnlyAttentionNeeded(
                summary.requiresConfirmation.prompt,
              )
                ? undefined
                : {
                    actionName: summary.requiresConfirmation.actionName,
                    actionArgs: summary.requiresConfirmation.actionArgs,
                    stepDescription: summary.requiresConfirmation.stepDescription,
                    prompt: summary.requiresConfirmation.prompt,
                    requestedAt: new Date().toISOString(),
                  },
            },
          }),
        });
        await this.messagesService.create({
          role: Role.ASSISTANT,
          taskId,
          content: [{ type: MessageContentType.Text, text: prompt }],
        });
        this.releaseProcessingLease(taskId);
        return { task: currentTask, halted: true };
      }

      if (summary.outcome.kind === 'needs_human_attention') {
        await this.tasksService.update(taskId, {
          status: TaskStatus.NEEDS_HELP,
          result: this.mergeTaskResult(currentTask, {
            security: {
              ...this.getTaskSecurityState(currentTask),
              execution: {
                ...(this.getTaskSecurityState(currentTask).execution || {}),
                mediaQueue: [],
                mediaPlan: {
                  ...mediaPlan,
                  currentIndex,
                  blockedAt: new Date().toISOString(),
                  blockReason: summary.summary,
                },
              },
              session: {
                ...(this.getTaskSecurityState(currentTask).session || {}),
                keepAliveUntilUserDone: true,
                phase: 'needs_attention',
                activeBranch: 'needs_help',
                awaitingUserDecision: true,
              },
              pendingConfirmation: undefined,
            },
          }),
        });
        await this.messagesService.create({
          role: Role.ASSISTANT,
          taskId,
          content: [
            {
              type: MessageContentType.Text,
              text: 'A CAPTCHA or human verification step is blocking progress. Please complete it in the desktop view, then send the next instruction here to continue.',
            },
          ],
        });
        this.releaseProcessingLease(taskId);
        return { task: currentTask, halted: true };
      }

      if (summary.status !== 'completed' && !mediaEndedAfterStep) {
        const updatedResult = this.mergeTaskResult(currentTask, {
          security: {
            ...this.getTaskSecurityState(currentTask),
            execution: {
              ...(this.getTaskSecurityState(currentTask).execution || {}),
              mediaQueue: [],
              mediaPlan: {
                ...mediaPlan,
                currentIndex,
                blockedAt: new Date().toISOString(),
                blockReason: summary.summary,
              },
            },
          },
        });
        await this.tasksService.update(taskId, {
          result: updatedResult,
        });
        currentTask.result = updatedResult as any;
        return { task: currentTask, halted: false };
      }

      if (mediaEndedAfterStep) {
        remainingQueue = [];
        currentIndex = totalSteps;
      } else {
        remainingQueue = remainingQueue.slice(1);
        currentIndex += 1;
      }
      mediaPlan = {
        ...mediaPlan,
        currentIndex,
        completedAt:
          remainingQueue.length === 0 ? new Date().toISOString() : undefined,
        blockReason: undefined,
        blockedAt: undefined,
      };

      const updatedResult = this.mergeTaskResult(currentTask, {
        security: {
          ...this.getTaskSecurityState(currentTask),
          execution: {
            ...(this.getTaskSecurityState(currentTask).execution || {}),
            mediaQueue: remainingQueue,
            mediaPlan,
          },
        },
      });
      await this.tasksService.update(taskId, {
        result: updatedResult,
      });
      currentTask.result = updatedResult as any;
      const upcomingStep = remainingQueue[0];
      if (upcomingStep) {
        const nextStepUpdate = this.buildExecutionProgressUpdate(
          currentTask,
          upcomingStep.description,
          mediaPlan.source === 'replan' ? 'replan' : 'initial',
        );
        if (nextStepUpdate) {
          await this.messagesService.create({
            role: Role.ASSISTANT,
            taskId,
            content: [{ type: MessageContentType.Text, text: nextStepUpdate }],
          });
        }
      }
    }

      if (totalSteps > 0) {
      await this.messagesService.create({
        role: Role.USER,
        taskId,
        content: [
          {
            type: MessageContentType.ToolResult,
            tool_use_id: `queued-plan-finished-${Date.now()}`,
            content: [
              {
                type: MessageContentType.Text,
                text: `Media or meeting execution finished after ${totalSteps} step${totalSteps === 1 ? '' : 's'}.`,
              },
            ],
          },
        ],
      });
    }

    return { task: currentTask, halted: false };
  }

  private async executeActiveHandoffIfPresent(
    taskId: string,
    task: Task,
  ): Promise<{ task: Task; halted: boolean }> {
    const security = this.getTaskSecurityState(task);
    const activeExecution = security.execution?.activeExecution;

    if (!activeExecution?.description) {
      return { task, halted: false };
    }

    let currentTask = task;
    const handoffStep = {
      description: activeExecution.description,
      executionMode: activeExecution.executionMode,
      expectedState: activeExecution.expectedState as Record<string, string> | undefined,
      completionCondition: activeExecution.completionCondition,
      driftCondition: activeExecution.driftCondition,
    };
    const turnGoal = this.getCurrentTurnGoal(currentTask);

    const summary = await this.computerUseExecutor.runStep(
      taskId,
      handoffStep,
      turnGoal,
      this.abortController!.signal,
    );

    const immediateHumanOnlyPrompt = this.getImmediateHumanOnlyAttentionPrompt(
      handoffStep.description,
      summary.summary,
      summary.checkpoints,
      summary.currentUrl,
    );
    if (immediateHumanOnlyPrompt) {
      await this.tasksService.update(taskId, {
        status: TaskStatus.NEEDS_HELP,
        result: this.mergeTaskResult(currentTask, {
          security: {
            ...this.getTaskSecurityState(currentTask),
            execution: {
              ...(this.getTaskSecurityState(currentTask).execution || {}),
              activeExecution: {
                ...activeExecution,
                blockedAt: new Date().toISOString(),
                blockReason: immediateHumanOnlyPrompt,
              },
            },
            session: {
              ...(this.getTaskSecurityState(currentTask).session || {}),
              keepAliveUntilUserDone: true,
              phase: 'needs_attention',
              activeBranch: 'needs_help',
              awaitingUserDecision: true,
            },
            pendingConfirmation: undefined,
          },
        }),
      });
      await this.messagesService.create({
        role: Role.ASSISTANT,
        taskId,
        content: [{ type: MessageContentType.Text, text: immediateHumanOnlyPrompt }],
      });
      this.releaseProcessingLease(taskId);
      return { task: currentTask, halted: true };
    }

    const stepSatisfiedSummary = this.deriveStepSatisfiedSummary(
      currentTask,
      handoffStep,
      summary,
    );

    if (
      this.shouldEmitUserVisibleExecutionTrace(currentTask, {
        ...summary,
        summaryText: summary.summary,
      }) &&
      !stepSatisfiedSummary
    ) {
      const screenshotData = this.shouldAttachTraceScreenshot(
        summary.mode,
        summary.status,
      )
        ? await this.getTraceScreenshotData(summary.screenshotBase64)
        : null;

      const traceText = buildExecutionTraceText({
        type: 'allyra_execution_trace',
        version: 1,
        mode: summary.mode,
        description: this.buildPublicExecutionTraceDescription(
          currentTask,
          handoffStep.description,
          turnGoal,
        ),
        taskGoal: turnGoal,
        status: summary.status,
        summary: summary.summary,
        currentUrl: summary.currentUrl,
        expectedState: summary.expectedState,
        completionCondition: summary.completionCondition,
        driftCondition: summary.driftCondition,
        checkpoints: summary.checkpoints,
      });

      const resultContent: MessageContentBlock[] = [
        { type: MessageContentType.Text, text: traceText },
      ];
      if (screenshotData) {
        resultContent.push({
          type: MessageContentType.Image,
          source: {
            media_type: 'image/png',
            type: 'base64',
            data: screenshotData,
          },
        } as any);
      }

      await this.messagesService.create({
        content: [
          {
            type: MessageContentType.ToolResult,
            tool_use_id: `active-handoff-${Date.now()}`,
            content: resultContent,
          },
        ],
        role: Role.USER,
        taskId,
      });
    }

    const executionUpdate = await this.updateExecutionState(currentTask, handoffStep, {
      status: summary.status,
      summary: summary.summary,
      outcome: summary.outcome,
      checkpoints: summary.checkpoints,
      currentUrl: summary.currentUrl,
    });
    currentTask.result = executionUpdate.result as any;
    const updatedSecurity = this.getTaskSecurityState(currentTask);
    const mediaEndedAfterStep =
      !!updatedSecurity.media?.selectedAt &&
      this.mediaReviewIndicatesEnded(
        updatedSecurity.media.lastSummary || summary.summary,
        updatedSecurity.media,
      );
    const shouldHandOffMediaMonitoring =
      !!updatedSecurity.media?.selectedAt &&
      !!updatedSecurity.media?.playbackVerifiedAt &&
      !mediaEndedAfterStep &&
      !updatedSecurity.execution?.blockedStep &&
      (
        !!updatedSecurity.media?.keepRunningUntilDone ||
        !!updatedSecurity.media?.transcriptRequested ||
        !!updatedSecurity.media?.summaryRequested
      ) &&
      (
        summary.status === 'completed' ||
        !!stepSatisfiedSummary
      );

    if (shouldHandOffMediaMonitoring) {
      const progressText =
        this.buildCompactStepProgressText(
          updatedSecurity.execution?.stepPlan?.currentIndex || 1,
          updatedSecurity.execution?.stepPlan?.totalSteps || 3,
          updatedSecurity.media?.kind === 'meeting'
            ? 'Meeting attendance is confirmed. Monitoring will continue until the session ends or a real blocker appears.'
            : 'Playback is confirmed. Monitoring will continue until the requested media ends or a real blocker appears.',
        ) ||
        (
          updatedSecurity.media?.kind === 'meeting'
            ? 'Step complete: Meeting attendance is confirmed. Monitoring continues until the session ends.'
            : 'Step complete: Playback is confirmed. Monitoring continues until the requested media ends.'
        );

      const monitoringResult = this.mergeTaskResult(currentTask, {
        security: {
          ...updatedSecurity,
          execution: {
            ...(updatedSecurity.execution || {}),
            activeExecution: undefined,
            pendingSteps: [],
            mediaQueue: [],
            mediaPlan: undefined,
          },
        },
      });
      await this.tasksService.update(taskId, {
        result: monitoringResult,
      });
      currentTask.result = monitoringResult as any;

      await this.messagesService.create({
        role: Role.ASSISTANT,
        taskId,
        content: [{ type: MessageContentType.Text, text: progressText }],
      });

      if (this.isProcessing) {
        setTimeout(() => this.runIteration(taskId), 0);
      }
      return { task: currentTask, halted: true };
    }

    if (
      summary.outcome.kind === 'step_failed' &&
      summary.outcome.failureKind === 'provider_capacity'
    ) {
      if (
        await this.queueAutomaticMediaRecoveryStepIfNeeded(taskId, currentTask, {
          providerFailure: true,
          summaryText: summary.summary,
          reason: 'provider_capacity_failure',
        })
      ) {
        return { task: currentTask, halted: true };
      }
      await this.handleTerminalTaskStatus(
        currentTask,
        'needs_help',
        'I hit a temporary model/provider capacity limit while working on this task. Please retry in a moment, and I will continue from the same task state.',
      );
      this.releaseProcessingLease(taskId);
      return { task: currentTask, halted: true };
    }

    if (
      summary.outcome.kind === 'step_failed' &&
      summary.outcome.failureKind === 'infrastructure'
    ) {
      await this.handleTerminalTaskStatus(
        currentTask,
        'needs_help',
        'I hit an internal computer-use/runtime error before the normal browser flow could continue. Please retry after the agent stack is refreshed, and I will continue from the same task state.',
      );
      this.releaseProcessingLease(taskId);
      return { task: currentTask, halted: true };
    }

    if (summary.requiresConfirmation) {
      if (
        this.shouldAutoContinueTaskConfirmation(
          currentTask,
          {
            prompt: summary.requiresConfirmation.prompt,
            actionName: summary.requiresConfirmation.actionName,
            stepDescription: summary.requiresConfirmation.stepDescription,
          },
          summary.currentUrl,
        )
      ) {
        const approvedAction = await this.computerUseExecutor.executeApprovedAction(
          taskId,
          summary.requiresConfirmation.actionName,
          summary.requiresConfirmation.actionArgs,
        );
        await this.emitMediaProgressUpdate(
          currentTask,
          'A clear next media action was available, so I continued automatically from the current page.',
        );
        const continuedUpdate = await this.updateExecutionState(
          currentTask,
          activeExecution,
          {
            status: approvedAction.status,
            summary: approvedAction.summary,
            outcome: approvedAction.outcome,
            checkpoints: approvedAction.checkpoints,
            currentUrl: approvedAction.currentUrl,
          },
        );
        currentTask.result = continuedUpdate.result as any;
        return { task: currentTask, halted: false };
      }

      const prompt = this.isHumanOnlyAttentionNeeded(
        summary.requiresConfirmation.prompt,
      )
        ? 'A CAPTCHA or human verification step is blocking progress. Please complete it in the desktop view, then send the next instruction here to continue.'
        : summary.requiresConfirmation.prompt;

      await this.tasksService.update(taskId, {
        status: this.isHumanOnlyAttentionNeeded(
          summary.requiresConfirmation.prompt,
        )
          ? TaskStatus.NEEDS_HELP
          : TaskStatus.NEEDS_REVIEW,
        result: this.mergeTaskResult(currentTask, {
          security: {
            ...updatedSecurity,
            execution: {
              ...(updatedSecurity.execution || {}),
              activeExecution: {
                ...activeExecution,
                blockedAt: new Date().toISOString(),
                blockReason: prompt,
              },
            },
            session: {
              ...(updatedSecurity.session || {}),
              keepAliveUntilUserDone: true,
              phase: this.isHumanOnlyAttentionNeeded(
                summary.requiresConfirmation.prompt,
              )
                ? 'needs_attention'
                : 'waiting_user',
              activeBranch: this.isHumanOnlyAttentionNeeded(
                summary.requiresConfirmation.prompt,
              )
                ? 'needs_help'
                : 'awaiting_confirmation',
              awaitingUserDecision: true,
            },
            pendingConfirmation: this.isHumanOnlyAttentionNeeded(
              summary.requiresConfirmation.prompt,
            )
              ? undefined
              : {
                  actionName: summary.requiresConfirmation.actionName,
                  actionArgs: summary.requiresConfirmation.actionArgs,
                  stepDescription: summary.requiresConfirmation.stepDescription,
                  prompt: summary.requiresConfirmation.prompt,
                  requestedAt: new Date().toISOString(),
                },
          },
        }),
      });
      await this.messagesService.create({
        role: Role.ASSISTANT,
        taskId,
        content: [{ type: MessageContentType.Text, text: prompt }],
      });
      this.releaseProcessingLease(taskId);
      return { task: currentTask, halted: true };
    }

    if (summary.outcome.kind === 'needs_human_attention') {
      await this.tasksService.update(taskId, {
        status: TaskStatus.NEEDS_HELP,
        result: this.mergeTaskResult(currentTask, {
          security: {
            ...updatedSecurity,
            execution: {
              ...(updatedSecurity.execution || {}),
              activeExecution: {
                ...activeExecution,
                blockedAt: new Date().toISOString(),
                blockReason: summary.summary,
              },
            },
            session: {
              ...(updatedSecurity.session || {}),
              keepAliveUntilUserDone: true,
              phase: 'needs_attention',
              activeBranch: 'needs_help',
              awaitingUserDecision: true,
            },
            pendingConfirmation: undefined,
          },
        }),
      });
      await this.messagesService.create({
        role: Role.ASSISTANT,
        taskId,
        content: [
          {
            type: MessageContentType.Text,
            text: 'A CAPTCHA or human verification step is blocking progress. Please complete it in the desktop view, then send the next instruction here to continue.',
          },
        ],
      });
      this.releaseProcessingLease(taskId);
      return { task: currentTask, halted: true };
    }

    const blockedStep = this.getTaskSecurityState(currentTask).execution?.blockedStep;
    const isNormalFastFlow = !this.shouldUseQueuedExecution(currentTask);
    const pendingSteps =
      this.getTaskSecurityState(currentTask).execution?.pendingSteps || [];
    const stepPlan = this.getTaskSecurityState(currentTask).execution?.stepPlan;
    const recoveredPendingSteps =
      pendingSteps.length > 0
        ? pendingSteps
        : summary.status === 'completed' && !mediaEndedAfterStep
          ? this.rebuildRemainingPlannedSteps(currentTask, stepPlan)
          : [];
    const canFinalizeWholeGoal =
      recoveredPendingSteps.length === 0 ||
      this.isFinalResultReviewDescription(handoffStep.description);
    const goalSatisfiedSummary =
      summary.status === 'completed' && canFinalizeWholeGoal
        ? this.deriveGoalSatisfiedSummary(
            currentTask,
            summary.summary,
            summary.checkpoints,
          ) || stepSatisfiedSummary
        : null;
    const lastStepGroundedSummary =
      summary.status === 'completed' && recoveredPendingSteps.length === 0
        ? this.extractGroundedSummaryAnswerCandidate(currentTask, [
            goalSatisfiedSummary,
            stepSatisfiedSummary,
            summary.summary,
            this.extractLatestVisibleSummary(summary.checkpoints),
          ])
        : null;
    const effectiveSatisfiedSummary =
      goalSatisfiedSummary || lastStepGroundedSummary;

    if (
      !summary.requiresConfirmation &&
      !(
        summary.outcome.kind === 'step_failed' &&
        (
          summary.outcome.failureKind === 'provider_capacity' ||
          summary.outcome.failureKind === 'infrastructure'
          )
        ) &&
      effectiveSatisfiedSummary
    ) {
      const finalizedResult = this.mergeTaskResult(currentTask, {
        security: {
          ...this.getTaskSecurityState(currentTask),
          execution: {
            ...(this.getTaskSecurityState(currentTask).execution || {}),
            activeExecution: undefined,
            pendingSteps: [],
            stepPlan:
              stepPlan && (stepPlan.totalSteps || 0) > 0
                ? {
                    ...stepPlan,
                    currentIndex: stepPlan.totalSteps,
                    completedAt: new Date().toISOString(),
                  }
                : undefined,
          },
        },
      });
      await this.tasksService.update(taskId, {
        result: finalizedResult,
      });
      currentTask.result = finalizedResult as any;
      await this.handleTerminalTaskStatus(
        currentTask,
        'completed',
        effectiveSatisfiedSummary,
      );
      return { task: currentTask, halted: true };
    }
    if ((summary.status === 'completed' || mediaEndedAfterStep) && !blockedStep) {
      if (!mediaEndedAfterStep && recoveredPendingSteps.length > 0) {
        const progressText = this.buildCompactStepProgressText(
          stepPlan?.currentIndex || 1,
          stepPlan?.totalSteps || recoveredPendingSteps.length + 1,
          this.extractLatestVisibleSummary(summary.checkpoints) || summary.summary,
        );
        if (progressText) {
          await this.messagesService.create({
            role: Role.ASSISTANT,
            taskId,
            content: [{ type: MessageContentType.Text, text: progressText }],
          });
        }
        const [nextStep, ...remainingSteps] = recoveredPendingSteps;
        const updatedResult = this.mergeTaskResult(currentTask, {
          security: {
            ...this.getTaskSecurityState(currentTask),
            execution: {
              ...(this.getTaskSecurityState(currentTask).execution || {}),
              activeExecution: {
                ...nextStep,
                source: stepPlan?.source || activeExecution.source || 'initial',
                createdAt: new Date().toISOString(),
                startedAt: undefined,
                completedAt: undefined,
                blockedAt: undefined,
                blockReason: undefined,
              },
              pendingSteps: remainingSteps,
              stepPlan: {
                ...(stepPlan || {}),
                summary:
                  stepPlan?.summary ||
                  this.getTaskSecurityState(currentTask).preflight?.plan ||
                  handoffStep.description,
                source: stepPlan?.source || activeExecution.source || 'initial',
                startedAt: stepPlan?.startedAt || new Date().toISOString(),
                currentIndex: (stepPlan?.currentIndex || 1) + 1,
                totalSteps:
                  stepPlan?.totalSteps || recoveredPendingSteps.length + 1,
                completedAt: undefined,
              },
            },
          },
        });
        await this.tasksService.update(taskId, {
          result: updatedResult,
        });
        currentTask.result = updatedResult as any;
        const nextStepUpdate = this.buildExecutionProgressUpdate(
          currentTask,
          nextStep.description,
          (stepPlan?.source || activeExecution.source || 'initial') === 'replan'
            ? 'replan'
            : 'initial',
        );
        if (nextStepUpdate) {
          await this.messagesService.create({
            role: Role.ASSISTANT,
            taskId,
            content: [{ type: MessageContentType.Text, text: nextStepUpdate }],
          });
        }
        if (this.isProcessing) {
          setTimeout(() => this.runIteration(taskId), 0);
        }
        return { task: currentTask, halted: true };
      }

      const updatedResult = this.mergeTaskResult(currentTask, {
        security: {
          ...this.getTaskSecurityState(currentTask),
          execution: {
            ...(this.getTaskSecurityState(currentTask).execution || {}),
            activeExecution: undefined,
            pendingSteps: [],
            stepPlan:
              stepPlan && (stepPlan.totalSteps || 0) > 0
                ? {
                    ...stepPlan,
                    currentIndex: stepPlan.totalSteps,
                    completedAt: new Date().toISOString(),
                  }
                : undefined,
          },
        },
      });
      await this.tasksService.update(taskId, {
        result: updatedResult,
      });
      currentTask.result = updatedResult as any;

      if (summary.status === 'completed' && isNormalFastFlow) {
        if (
          this.requiresFinalResultReview(currentTask) &&
          !this.isFinalResultReviewDescription(handoffStep.description) &&
          !this.getTaskSecurityState(currentTask).execution?.resultReview?.completedAt
        ) {
          const reviewPendingTask = await this.markResultReviewPending(
            taskId,
            currentTask,
          );
          const reviewTask = await this.storeActiveExecutionHandoff(
            taskId,
            reviewPendingTask,
            {
              summary:
                'Execution reached an apparent endpoint; verify the visible final result before completing.',
              source: 'initial',
              step: {
                description: this.buildFinalResultReviewStep(reviewPendingTask),
                executionMode: 'fast',
                completionCondition:
                  'The actual result, confirmation, or final state requested by the user is visibly on screen and the key facts needed for the final answer are visible.',
                driftCondition:
                  'The current page does not yet show the real result, confirmation, or final state needed to answer the user reliably.',
              },
            },
          );
          if (this.isProcessing) {
            setTimeout(() => this.runIteration(taskId), 0);
          }
          return { task: reviewTask, halted: true };
        }

        const recoveryReason =
          this.extractLatestVisibleSummary(summary.checkpoints) ||
          summary.summary ||
          'The planned steps ended before the requested final result was clearly visible.';
        const recoverySignal =
          this.detectMediaWatchdogSignal(
            currentTask,
            recoveryReason,
            summary.currentUrl,
          ) || 'stuck';
        const recoveryResult = this.mergeTaskResult(currentTask, {
          security: {
            ...this.getTaskSecurityState(currentTask),
            execution: {
              ...(this.getTaskSecurityState(currentTask).execution || {}),
              activeExecution: undefined,
              blockedStep: {
                description: handoffStep.description,
                reason: recoveryReason,
                retries: 1,
                lastSeenAt: new Date().toISOString(),
                recoveryStrategy: this.determineRecoveryStrategy(
                  currentTask,
                  recoverySignal,
                ),
                currentUrl: summary.currentUrl || undefined,
                lastVisibleSummary:
                  this.extractLatestVisibleSummary(summary.checkpoints) ||
                  recoveryReason,
                watchdogReason: recoverySignal,
              },
            },
          },
        });
        await this.tasksService.update(taskId, {
          result: recoveryResult,
        });
        currentTask.result = recoveryResult as any;
        await this.messagesService.create({
          role: Role.ASSISTANT,
          taskId,
          content: [
            {
              type: MessageContentType.Text,
              text: this.buildCompactRecoveryText(
                stepPlan?.currentIndex || stepPlan?.totalSteps || 1,
                stepPlan?.totalSteps || 1,
                recoveryReason,
              ),
            },
          ],
        });
        return { task: currentTask, halted: false };
      }

      return { task: currentTask, halted: false };
    }

    if (blockedStep) {
      const mediaRecoveryTask = await this.maybeQueueMediaRecoveryFromBlockedStep(
        taskId,
        currentTask,
        blockedStep,
      );
      if (mediaRecoveryTask) {
        currentTask = mediaRecoveryTask;
        if (this.isProcessing) {
          setTimeout(() => this.runIteration(taskId), 0);
        }
        return { task: currentTask, halted: true };
      }
      await this.messagesService.create({
        role: Role.ASSISTANT,
        taskId,
        content: [
          {
            type: MessageContentType.Text,
            text: this.buildCompactRecoveryText(
              stepPlan?.currentIndex || 1,
              stepPlan?.totalSteps || 1,
              blockedStep.reason || summary.summary,
            ),
          },
        ],
      });
      const updatedResult = this.mergeTaskResult(currentTask, {
        security: {
          ...this.getTaskSecurityState(currentTask),
          execution: {
            ...(this.getTaskSecurityState(currentTask).execution || {}),
            activeExecution: undefined,
          },
        },
      });
      await this.tasksService.update(taskId, {
        result: updatedResult,
      });
      currentTask.result = updatedResult as any;
      return { task: currentTask, halted: false };
    }

    const refreshedResult = this.mergeTaskResult(currentTask, {
      security: {
        ...this.getTaskSecurityState(currentTask),
        execution: {
          ...(this.getTaskSecurityState(currentTask).execution || {}),
          activeExecution: {
            ...activeExecution,
            startedAt:
              activeExecution.startedAt || new Date().toISOString(),
            blockReason: undefined,
            blockedAt: undefined,
          },
        },
      },
    });
    await this.tasksService.update(taskId, {
      result: refreshedResult,
    });
    currentTask.result = refreshedResult as any;

    if (this.isProcessing) {
      setTimeout(() => this.runIteration(taskId), 0);
    }

    return { task: currentTask, halted: true };
  }

  private rewriteDesktopStepDescription(task: Task, description: string): string {
    const taskDescription = task.description.toLowerCase();
    const stepDescription = description.trim();
    const lowerStep = stepDescription.toLowerCase();
    const isFlightTask = /(flight|flights|google flights|trip type|one-way|round trip)/i.test(
      taskDescription,
    );
    const isMediaTask = this.isMediaTask(task.description);
    const mediaKind = isMediaTask ? this.detectMediaKind(task.description) : null;
    const isResultReview = this.isFinalResultReviewDescription(stepDescription);

    if (isResultReview) {
      return `Read-only result review for this task: inspect the current visible page, form, or results and verify the key facts needed to answer the user accurately for "${this.getCurrentTurnGoal(task)}". Do not keep searching, editing fields, clicking Search, changing dates, or restarting the flow unless the screen clearly does not show the final result yet. Extract only what is visibly confirmed on screen and summarize any mismatch precisely.`;
    }

    if (isMediaTask) {
      if (/\blyrics\b/i.test(lowerStep)) {
        return mediaKind === 'meeting'
          ? 'Do not search for lyrics, transcript, captions, subtitles, or meeting notes for this task. Stay inside the current requested meeting flow, verify the meeting remains visibly joined and active, and preserve stable audio capture for later Gemini transcript and summary generation.'
          : 'Do not search for lyrics, transcript, captions, or subtitles for this task. Stay inside the current requested media playback flow, confirm the requested media is visibly playing, and preserve stable audio capture for later Gemini transcript and summary generation.';
      }

      if (this.isMediaOpeningLikeStep(task.description, lowerStep)) {
        const visibleConstraintInstruction = this.buildMediaVisibleConstraintInstruction(
          task.description,
        );
        return `${stepDescription} Stay on the requested media flow. Use ${this.buildSupportedVideoSurfacePhrase(task.description)} for this task. Continue from the current ${this.buildSupportedVideoSurfacePhrase(task.description)} page if it already shows the search box, relevant results, or the requested player instead of reopening the same site. Before starting the requested item, pause or close any unrelated audio or video already playing in another tab, window, or app so only the requested media remains active. If the same search query has already been typed and relevant results are visible, do not type it again. If search results are shown, ${visibleConstraintInstruction.charAt(0).toLowerCase()}${visibleConstraintInstruction.slice(1)} If a matching player page is already open, reuse it instead of forcing a homepage first. Do not stop on search results, a blank player, a paused player, or any non-${this.buildSupportedVideoSurfacePhrase(task.description)} page.`;
      }

      if (/(skip ad|ad to finish|wait for the ad)/i.test(lowerStep)) {
        return `${stepDescription} After the ad is skipped or ends, make sure the requested media is actually playing. If the player is paused, click Play or press Space and confirm playback before stopping.`;
      }

      if (/(show transcript|transcript|captions|subtitles|meeting notes)/i.test(lowerStep)) {
        return mediaKind === 'meeting'
          ? 'Do not open transcript, captions, subtitles, or meeting-notes UI for this task. Keep the current meeting active, verify it remains visibly joined, and preserve stable audio capture for later Gemini transcript and summary generation.'
          : 'Do not open transcript, captions, or subtitles UI for this task. Keep the requested media actively playing, avoid disruptive clicks, and preserve stable audio capture for later Gemini transcript and summary generation.';
      }

      if (
        mediaKind !== 'meeting' &&
        /(play|resume|unpause|listen|watch|keep it playing|keep it running)/i.test(
          lowerStep,
        )
      ) {
        return `${stepDescription} Confirm the requested media is actively playing and not paused before stopping.`;
      }

      if (
        mediaKind !== 'meeting' &&
        /(wait .*finish|wait .*ends|wait until .*ends|wait until .*finishes|finish playing|until the video ends|until the song ends)/i.test(
          lowerStep,
        )
      ) {
        return `${stepDescription} Do one focused state check only. If the requested media is already playing, leave it alone and stop acting. If the current short, reel, or video has looped back to the beginning, replayed, shown a replay/end screen, or autoplay moved to a different item after one playthrough, treat that as the requested media having finished instead of reopening or replaying it.`;
      }

      if (
        mediaKind === 'meeting' &&
        /(join|attend|stay in|monitor|continue monitoring)/i.test(lowerStep)
      ) {
        return `${stepDescription} Confirm the meeting is visibly joined and active before stopping.`;
      }
    }

    if (!isFlightTask) {
      if (
        /\b(search|find|look up|lookup|browse|review|compare|inspect|check|select|choose|pick|finali[sz]e)\b/.test(
          lowerStep,
        )
      ) {
        return `${stepDescription} First inspect the current browser page and continue from it if it already shows the requested site, search surface, results list, or product candidates for this task. Do not reopen the same site, re-navigate to the homepage, or retype the same query if the current visible page is already useful. If relevant search results or candidate items are already visible, treat that as useful progress for this step and move forward from that visible state instead of restarting it.`;
      }

      if (/\b(open|go to|navigate to|visit|return to|reuse)\b/.test(lowerStep)) {
        return `${stepDescription} First inspect the current browser page. If the requested site or a directly useful page for this task is already visible, reuse it instead of reopening or navigating again. A matching open site, results page, or candidate page counts as useful state and should be continued from rather than reset.`;
      }

      return stepDescription;
    }

    if (/planner execution brief:/i.test(lowerStep)) {
      return stepDescription;
    }

    if (
      /google\.com\/flights|google flights homepage|navigate to https:\/\/www\.google\.com\/flights/i.test(
        lowerStep,
      )
    ) {
      return `${stepDescription} First inspect the current Google Flights state. If route, trip-type, or date values already visible on screen match or help with the requested search, reuse them. Only clear or overwrite values that clearly contradict the user's request.`;
    }

    if (
      /(departure|origin|destination|where to|trip type|one-way|round trip)/i.test(
        lowerStep,
      ) &&
      !/(calendar|date|search button|results)/i.test(lowerStep)
    ) {
      return `${stepDescription} Treat this as one route-setting section and finish the field flow before stopping. Stop only when the visible route and trip-type values on screen match the user's request.`;
    }

    if (/(calendar|date|march|april|may|june|july|august|september|october|november|december|search button|click search)/i.test(lowerStep)) {
      return `${stepDescription} Treat this as one date-and-search section. Finish selecting the requested travel dates and click Search if the page is ready, then stop only once the search results page or a ready-to-search state is clearly visible.`;
    }

    return stepDescription;
  }

  private inferCompletionCondition(
    task: Task,
    description: string,
    expectedState?: Record<string, string>,
  ): string | undefined {
    if (Object.keys(expectedState || {}).length > 0) {
      return undefined;
    }

    const taskDescription = task.description.toLowerCase();
    const lowerStep = description.toLowerCase();
    const isFlightTask = /(flight|flights|google flights)/i.test(taskDescription);
    const mediaKind = this.isMediaTask(task.description)
      ? this.detectMediaKind(task.description)
      : null;

    if (this.isFinalResultReviewDescription(description)) {
      return 'This review is complete only when you have inspected the visible screen and summarized whether the final result is on screen and which key facts are visibly confirmed, without continuing execution.';
    }

    if (mediaKind) {
      if (/\blyrics\b/i.test(lowerStep)) {
        return mediaKind === 'meeting'
          ? 'This step is complete only when the requested meeting remains visibly joined and stable, without leaving the meeting flow for lyrics or transcript searches, so audio recording can continue cleanly.'
          : 'This step is complete only when the requested media remains visibly playing and stable, without leaving playback for lyrics or transcript searches, so audio recording can continue cleanly.';
      }

      if (this.isMediaOpeningLikeStep(task.description, lowerStep)) {
        return mediaKind === 'meeting'
          ? `This step is complete only when the correct requested ${this.buildMeetingSurfacePhrase(task.description)} page or session is visibly open, not just a landing page or search result.`
          : `This step is complete only when the current screen is on ${this.buildSupportedVideoSurfacePhrase(task.description)} and is already useful for the requested item: a matching player page, a relevant search box state, or relevant visible results ready to open. An already-open matching player page counts as complete; a blank player or any non-${this.buildSupportedVideoSurfacePhrase(task.description)} page does not.`;
      }

      if (/(skip ad|ad to finish|wait for the ad)/i.test(lowerStep)) {
        return 'This step is complete only when any ad is gone and the requested media is visibly playing. A paused player is not complete.';
      }

      if (/(show transcript|transcript|captions|subtitles|meeting notes)/i.test(lowerStep)) {
        return mediaKind === 'meeting'
          ? 'This step is complete only when the meeting remains visibly joined and stable, without opening transcript or notes UI, so audio recording can continue cleanly.'
          : 'This step is complete only when the requested media remains visibly playing and stable, without opening transcript UI, so audio recording can continue cleanly.';
      }

      if (mediaKind === 'meeting') {
        if (/(join|attend|stay in|monitor|continue monitoring)/i.test(lowerStep)) {
          return 'This step is complete only when the meeting is visibly joined and active, or when the meeting has clearly ended.';
        }
      } else if (
        /(wait .*finish|wait .*ends|wait until .*ends|wait until .*finishes|finish playing|until the video ends|until the song ends)/i.test(
          lowerStep,
        )
      ) {
        return 'This step is complete only when the requested media is visibly playing and stable, or the player clearly shows replay, looped back to the start, or moved into follow-on autoplay after one completed playthrough.';
      } else if (/(play|resume|unpause|listen|watch|keep it playing|keep it running)/i.test(lowerStep)) {
        return 'This step is complete only when the requested media is visibly playing and not paused.';
      }
    }

    if (!isFlightTask) {
      return undefined;
    }

    if (/(departure|origin|destination|where to|trip type|one-way|round trip)/i.test(lowerStep)) {
      return 'The route section is complete only when the visible origin, destination, and trip-type values match the user request.';
    }

    if (/(calendar|date|search)/i.test(lowerStep)) {
      return 'This section is complete only when the requested date is visibly selected and the search results page is visible, or the page is clearly ready for the search to be launched next.';
    }

    return undefined;
  }

  private inferDriftCondition(
    task: Task,
    description: string,
    expectedState?: Record<string, string>,
  ): string | undefined {
    if (Object.keys(expectedState || {}).length > 0) {
      return undefined;
    }

    const taskDescription = task.description.toLowerCase();
    const lowerStep = description.toLowerCase();
    const isFlightTask = /(flight|flights|google flights)/i.test(taskDescription);
    const mediaKind = this.isMediaTask(task.description)
      ? this.detectMediaKind(task.description)
      : null;

    if (this.isFinalResultReviewDescription(description)) {
      return 'Drift exists only if the visible screen is clearly not the intended result page, final confirmation state, or relevant current context needed for this read-only review.';
    }

    if (mediaKind) {
      if (/\blyrics\b/i.test(lowerStep)) {
        return mediaKind === 'meeting'
          ? 'Drift is present only if the meeting is clearly no longer the requested one, a login wall or error page is visible, or an unrelated app or site is in front. Do not leave the meeting flow for lyrics or transcript searches.'
          : 'Drift is present only if the visible page clearly contradicts the requested media, a login wall or error page is visible, or an unrelated app or site is in front. Do not leave the playback flow for lyrics or transcript searches.';
      }

      if (/(show transcript|transcript|captions|subtitles|meeting notes)/i.test(lowerStep)) {
        return mediaKind === 'meeting'
          ? 'Drift is present only if the meeting is clearly no longer the requested one, a login wall or error page is visible, or an unrelated app or site is in front. Do not mark drift just because transcript UI was not opened.'
          : 'Drift is present only if the visible page clearly contradicts the requested media, a login wall or error page is visible, or an unrelated app or site is in front. Do not mark drift just because transcript UI was not opened.';
      }

      if (
        mediaKind !== 'meeting' &&
        /(wait .*finish|wait .*ends|wait until .*ends|wait until .*finishes|finish playing|until the video ends|until the song ends)/i.test(
          lowerStep,
        )
      ) {
        return 'Drift is present only if the visible page clearly contradicts the requested media title, shows an unrelated app or browser chrome, or a blocker such as login, network failure, or wrong media is visible. A replayed short, replay button, or follow-on autoplay after one playthrough is an end condition, not drift.';
      }

      return mediaKind === 'meeting'
        ? 'Drift is present only if the visible page clearly contradicts the requested meeting, shows an unrelated app or browser chrome, or a blocker such as login, network failure, or wrong session is visible.'
        : 'Drift is present only if the visible page clearly contradicts the requested media title, shows an unrelated app or browser chrome, or a blocker such as login, network failure, or wrong video is visible. An already-open matching YouTube video page or Shorts page is not drift.';
    }

    if (!isFlightTask) {
      return undefined;
    }

    if (/(departure|origin|destination|where to|trip type|one-way|round trip|calendar|date|search)/i.test(lowerStep)) {
      return 'Drift is present only if the visible route, trip type, or date values clearly contradict the user request, or if stale state from a previous search remains active.';
    }

    return undefined;
  }

  private inferExecutionMode(
    task: Task,
    description: string,
    requestedMode?: ExecutionMode,
    _expectedState?: Record<string, string>,
  ): ExecutionMode {
    const security = this.getTaskSecurityState(task);
    const currentStepKey = description.trim().toLowerCase();
    const blockedOnThisStep =
      security.execution?.blockedStep?.description?.trim().toLowerCase() ===
      currentStepKey;
    const hasUnresolvedStruggleHistory = this.hasUnresolvedRecoveryHistory(
      security.execution?.recoveryHistory,
      currentStepKey,
    );
    const haystack = `${task.description} ${description}`.toLowerCase();
    const mediaTask = this.isMediaTask(task.description);
    const risky = /(book|booking|checkout|payment|pay|purchase|submit|send|delete|order|place order|confirm (?:purchase|payment|booking|reservation|order))/i.test(
      haystack,
    );
    const requiresGuardedRecovery =
      blockedOnThisStep || hasUnresolvedStruggleHistory;

    if (risky && !mediaTask) {
      return 'strict';
    }

    if (
      risky &&
      mediaTask &&
      !/(send|submit|delete)/i.test(description)
    ) {
      return 'fast';
    }

    if (risky) {
      return 'strict';
    }

    if (requiresGuardedRecovery) {
      return 'guarded';
    }

    if (
      mediaTask &&
      !security.media?.playbackVerifiedAt &&
      this.isMediaOpeningLikeStep(task.description, description)
    ) {
      return 'guarded';
    }

    if (requestedMode === 'guarded') {
      return 'guarded';
    }

    if (requestedMode === 'strict') {
      return 'fast';
    }

    if (requestedMode === 'fast') {
      return 'fast';
    }

    return 'fast';
  }

  private hasUnresolvedRecoveryHistory(
    history:
      | Array<{
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
        }>
      | undefined,
    currentStepKey: string,
  ): boolean {
    const matchingEntries = (history || [])
      .filter(
        (entry) => entry.description.trim().toLowerCase() === currentStepKey,
      )
      .sort((left, right) =>
        left.recordedAt < right.recordedAt ? 1 : left.recordedAt > right.recordedAt ? -1 : 0,
      );

    if (matchingEntries.length === 0) {
      return false;
    }

    return matchingEntries[0].outcome !== 'resolved';
  }

  private applyTravelPreflightDefaults(
    task: Task,
    parsed: {
      decision: 'ask_user' | 'proceed';
      reason: 'confirmation' | 'clarification';
      question: string;
      plan: string;
      planSteps: string[];
      guidelines: string[];
    },
  ): {
    decision: 'ask_user' | 'proceed';
    reason: 'confirmation' | 'clarification';
    question: string;
    plan: string;
    planSteps: string[];
    guidelines: string[];
  } {
    if (parsed.decision !== 'ask_user') {
      return parsed;
    }

    const taskDescription = task.description.toLowerCase();
    const question = parsed.question.toLowerCase();
    const isTravelSearch =
      /(flight|flights|train|trains|hotel|hotels|trip|travel)/i.test(
        taskDescription,
      );

    if (!isTravelSearch) {
      return parsed;
    }

    const asksYear =
      /(what year|which year|year should i use|year should be used)/i.test(
        question,
      );
    const asksPassengers =
      /(how many passengers|how many travellers|how many travelers|number of passengers|number of travellers|number of travelers)/i.test(
        question,
      );

    if (!asksYear && !asksPassengers) {
      return parsed;
    }

    const inferredYear = asksYear
      ? this.inferMissingTravelYear(task.description)
      : null;
    const inferredPassengers = asksPassengers
      ? this.inferDefaultPassengerCount(task.description)
      : null;

    if ((asksYear && !inferredYear) || (asksPassengers && !inferredPassengers)) {
      return parsed;
    }

    const assumptions: string[] = [];
    if (inferredYear) {
      assumptions.push(`year ${inferredYear}`);
    }
    if (inferredPassengers) {
      assumptions.push(inferredPassengers);
    }

    this.logger.log(
      `Applying travel preflight defaults for task ${task.id}: ${assumptions.join(', ')}`,
    );

    return {
      decision: 'proceed',
      reason: 'clarification',
      question: '',
      plan: `${parsed.plan || 'Begin executing the task.'} Assume ${assumptions.join(' and ')} unless the user later says otherwise.`,
      planSteps:
        parsed.planSteps?.length
          ? parsed.planSteps
          : this.plannerPlanCompiler.derivePlanStepsFromPlanText(
              `${parsed.plan || 'Begin executing the task.'} Assume ${assumptions.join(' and ')} unless the user later says otherwise.`,
            ),
      guidelines: parsed.guidelines?.length
        ? parsed.guidelines
        : this.defaultPlannerGuidelines(),
    };
  }

  private inferMissingTravelYear(description: string): number | null {
    if (/\b20\d{2}\b/.test(description)) {
      return null;
    }

    const monthNames =
      'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec';
    const hasMonthAndDay = new RegExp(
      `\\b(?:${monthNames})\\b[^\\n\\r,.]*?\\b\\d{1,2}(?:st|nd|rd|th)?\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\b[^\\n\\r,.]*?\\b(?:${monthNames})\\b`,
      'i',
    ).test(description);

    if (!hasMonthAndDay) {
      return null;
    }

    return new Date().getFullYear();
  }

  private inferDefaultPassengerCount(description: string): string | null {
    if (
      /\b\d+\s*(adult|adults|passenger|passengers|traveller|travellers|traveler|travelers)\b/i.test(
        description,
      )
    ) {
      return null;
    }

    return '1 adult';
  }

  private summaryIndicatesUsefulExistingContext(task: Task, summary: string): boolean {
    const normalized = summary.toLowerCase();
    if (!normalized.trim()) {
      return false;
    }

    const visiblyReadyOrPresent =
      /\balready\b/.test(normalized) &&
      /\b(show|shows|display|displays|entered|selected|visible|open|loaded|on the page|on screen)\b/.test(
        normalized,
      );

    if (!visiblyReadyOrPresent) {
      return false;
    }

    if (this.summaryIndicatesStaleOrContradictoryContext(summary)) {
      return false;
    }

    return this.summarySupportsCurrentTurnGoal(task, summary);
  }

  private summaryIndicatesStaleOrContradictoryContext(summary: string): boolean {
    const normalized = summary.toLowerCase();
    if (!normalized.trim()) {
      return false;
    }

    return /\b(stale state|wrong page|wrong account|wrong inbox|wrong result|wrong search|unrelated|different task|expired session|session expired|captcha|recaptcha|consent prompt|blocked page|login wall|does not match|mismatch|contradict|not relevant)\b/.test(
      normalized,
    );
  }

  private summarySupportsCurrentTurnGoal(task: Task, summary: string): boolean {
    const goal = this.getCurrentTurnGoal(task).toLowerCase().trim();
    const normalizedSummary = summary.toLowerCase();
    if (!goal || !normalizedSummary.trim()) {
      return false;
    }

    const searchQuery = this.extractSearchQueryFromGoal(goal);
    if (searchQuery) {
      const queryTokens = this.extractGoalSignalTokens(searchQuery);
      const overlap = queryTokens.filter((token) =>
        normalizedSummary.includes(token),
      ).length;
      if (
        overlap > 0 ||
        /\b(search results|results page|article|page|result)\b/.test(
          normalizedSummary,
        )
      ) {
        return true;
      }
    }

    const goalTokens = this.extractGoalSignalTokens(goal);
    if (goalTokens.length === 0) {
      return false;
    }

    const overlap = goalTokens.filter((token) =>
      normalizedSummary.includes(token),
    ).length;

    if (overlap >= 2) {
      return true;
    }

    if (
      overlap >= 1 &&
      /\b(inbox|mailbox|gmail|outlook|teams|meet|calendar|drive|github|account|message|chat|search|results|article|page)\b/.test(
        normalizedSummary,
      )
    ) {
      return true;
    }

    return false;
  }

  private extractGoalSignalTokens(text: string): string[] {
    const ignored = new Set([
      'open',
      'browser',
      'search',
      'about',
      'latest',
      'give',
      'summary',
      'summarize',
      'summarise',
      'check',
      'look',
      'lookup',
      'find',
      'read',
      'review',
      'please',
      'this',
      'that',
      'with',
      'from',
      'into',
      'then',
      'turn',
      'page',
      'result',
      'results',
      'current',
    ]);

    return Array.from(
      new Set(
        text
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .map((token) => token.trim())
          .filter((token) => token.length >= 3 && !ignored.has(token)),
      ),
    );
  }

  private isMediaTask(description: string): boolean {
    return (
      /\b(youtube|spotify|soundcloud|netflix|hulu|prime video|apple music|video|audio|song|music|listen|playlist|podcast|talk|ted talk|speech|presentation|clip|meeting|meet|zoom|teams|webinar|call|conference|attend|playback)\b/i.test(
        description,
      ) || this.looksLikeNamedMediaRequest(description)
    );
  }

  private detectMediaKind(description: string): 'audio' | 'video' | 'meeting' {
    if (/\b(meeting|meet|zoom|teams|webinar|call|conference)\b/i.test(description)) {
      return 'meeting';
    }

    if (
      /\b(song|music|audio|playlist|podcast|listen|spotify|apple music|soundcloud)\b/i.test(
        description,
      ) ||
      this.looksLikeNamedAudioRequest(description)
    ) {
      return 'audio';
    }

    return 'video';
  }

  private isSupportedAudioSurfaceMention(description: string): boolean {
    return /\b(youtube|spotify|soundcloud|apple music)\b/i.test(description);
  }

  private isUnsupportedDefaultVideoSurfaceMention(description: string): boolean {
    return /\b(netflix|hulu|prime video|disney\+?)\b/i.test(
      description,
    );
  }

  private detectMeetingPlatform(description: string): MediaPlatform {
    if (/\bzoom\b/i.test(description)) {
      return 'zoom';
    }

    if (/\bteams\b/i.test(description)) {
      return 'teams';
    }

    return 'google_meet';
  }

  private detectMediaPlatform(description: string): MediaPlatform {
    const kind = this.detectMediaKind(description);

    if (kind === 'meeting') {
      return this.detectMeetingPlatform(description);
    }

    if (kind === 'audio') {
      if (/\bspotify\b/i.test(description)) {
        return 'spotify';
      }

      if (/\bsoundcloud\b/i.test(description)) {
        return 'soundcloud';
      }

      if (/\bapple music\b/i.test(description)) {
        return 'apple_music';
      }
    }

    return 'youtube';
  }

  private detectMediaRoute(description: string): MediaRoute {
    const kind = this.detectMediaKind(description);

    if (kind === 'meeting') {
      return 'supported_meeting';
    }

    if (this.isUnsupportedDefaultVideoSurfaceMention(description)) {
      return 'unsupported_media';
    }

    if (kind === 'audio') {
      return this.isSupportedAudioSurfaceMention(description)
        ? 'supported_audio'
        : 'supported_audio';
    }

    return 'supported_video';
  }

  private isSupportedMediaUrlForRoute(
    route: MediaRoute | undefined,
    currentUrl?: string,
    platform?: MediaPlatform,
  ): boolean {
    const normalizedUrl = (currentUrl || '').toLowerCase();
    if (!normalizedUrl) {
      return true;
    }

    switch (platform) {
      case 'youtube':
        return /(youtube\.com|youtu\.be)/i.test(normalizedUrl);
      case 'spotify':
        return /spotify\.com/i.test(normalizedUrl);
      case 'soundcloud':
        return /soundcloud\.com/i.test(normalizedUrl);
      case 'apple_music':
        return /music\.apple\.com/i.test(normalizedUrl);
      case 'google_meet':
        return /meet\.google\.com/i.test(normalizedUrl);
      case 'zoom':
        return /zoom\.us/i.test(normalizedUrl);
      case 'teams':
        return /(teams\.microsoft\.com|teams\.live\.com)/i.test(normalizedUrl);
      default:
        break;
    }

    switch (route) {
      case 'supported_meeting':
        return /(meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com)/i.test(
          normalizedUrl,
        );
      case 'supported_audio':
        return /(youtube\.com|spotify\.com|soundcloud\.com|music\.apple\.com)/i.test(
          normalizedUrl,
        );
      case 'supported_video':
        return /(youtube\.com|youtu\.be)/i.test(normalizedUrl);
      case 'unsupported_media':
      default:
        return true;
    }
  }

  private getMediaRoute(taskOrDescription: Task | string): MediaRoute {
    const description =
      typeof taskOrDescription === 'string'
        ? taskOrDescription
        : taskOrDescription.description;
    if (typeof taskOrDescription !== 'string') {
      return (
        this.getTaskSecurityState(taskOrDescription).media?.route ||
        this.detectMediaRoute(description)
      );
    }

    return this.detectMediaRoute(description);
  }

  private getMediaPlatform(taskOrDescription: Task | string): MediaPlatform {
    const description =
      typeof taskOrDescription === 'string'
        ? taskOrDescription
        : taskOrDescription.description;
    if (typeof taskOrDescription !== 'string') {
      return (
        this.getTaskSecurityState(taskOrDescription).media?.platform ||
        this.detectMediaPlatform(description)
      );
    }

    return this.detectMediaPlatform(description);
  }

  private buildMeetingSurfacePhrase(description: string): string {
    switch (this.detectMeetingPlatform(description)) {
      case 'zoom':
        return 'Zoom';
      case 'teams':
        return 'Microsoft Teams';
      case 'google_meet':
      default:
        return 'Google Meet';
    }
  }

  private buildChosenMediaSurfacePhrase(description: string): string {
    return this.detectMediaKind(description) === 'meeting'
      ? this.buildMeetingSurfacePhrase(description)
      : this.buildSupportedVideoSurfacePhrase(description);
  }

  private buildSupportedVideoSurfacePhrase(description: string): string {
    const platform = this.detectMediaPlatform(description);
    if (platform === 'spotify') {
      return 'Spotify';
    }

    if (platform === 'soundcloud') {
      return 'SoundCloud';
    }

    if (platform === 'apple_music') {
      return 'Apple Music';
    }

    return 'YouTube';
  }

  private buildMediaOpeningPlannerStep(goal: string): string {
    if (this.detectMediaKind(goal) === 'meeting') {
      return `Open ${this.buildMeetingSurfacePhrase(goal)} and get to the requested meeting join page for this turn.`;
    }

    const searchTarget = this.buildMediaSearchTarget(goal);
    return searchTarget
      ? `Open ${this.buildSupportedVideoSurfacePhrase(goal)} and search for "${searchTarget}".`
      : `Open ${this.buildSupportedVideoSurfacePhrase(goal)} and search for the requested item.`;
  }

  private buildMediaPlaybackPlannerStep(goal: string): string {
    if (this.detectMediaKind(goal) === 'meeting') {
      return 'Join the meeting and verify that attendance is visibly confirmed.';
    }

    const searchTarget = this.buildMediaSearchTarget(goal);
    return searchTarget
      ? `Choose a visible ${this.buildSupportedVideoSurfacePhrase(goal)} result that matches "${searchTarget}", open it, and verify that playback starts.`
      : `Choose the best visible match on ${this.buildSupportedVideoSurfacePhrase(goal)}, open it, and verify that playback starts.`;
  }

  private buildChosenPlatformExpectedState(
    task: Task,
    stepDescription: string,
  ): Record<string, string> | undefined {
    if (!this.isMediaTask(task.description)) {
      return undefined;
    }

    if (!this.isMediaOpeningLikeStep(task.description, stepDescription)) {
      return undefined;
    }

    switch (this.getMediaPlatform(task)) {
      case 'youtube':
        return { url: 'https://www.youtube.com' };
      case 'spotify':
        return { url: 'https://open.spotify.com' };
      case 'soundcloud':
        return { url: 'https://soundcloud.com' };
      case 'apple_music':
        return { url: 'https://music.apple.com' };
      case 'google_meet':
        return { url: 'https://meet.google.com' };
      case 'zoom':
        return { url: 'https://zoom.us' };
      case 'teams':
        return { url: 'https://teams.microsoft.com' };
      default:
        return undefined;
    }
  }

  private isMediaOpeningLikeStep(goal: string, step: string): boolean {
    if (this.detectMediaKind(goal) === 'meeting') {
      return /(meeting surface|join state|join .*meeting|open .*meeting|navigate .*meeting)/i.test(
        step,
      );
    }

    return /\b(open ted\b|navigate to ted|ted\.com|search ted\b|relevant ted\b|video platform|media surface|video surface|requested item or player|search, results, or player state|browser and search|search icon|search bar|first video result|open the requested media|navigate .*youtube|youtube homepage|open or reuse youtube|open or reuse google meet|open or reuse zoom|open or reuse microsoft teams|search .*youtube|search .*video|search .*talk|search .*podcast)\b/i.test(
      step,
    );
  }

  private isMediaPlaybackLikeStep(goal: string, step: string): boolean {
    if (this.detectMediaKind(goal) === 'meeting') {
      return /(join the meeting|attendance|visibly joined|meeting active)/i.test(step);
    }

    return /\b(open the first video result|play a suitable video|select a popular talk|allow it to play|start playing|confirm it is a valid talk|make sure playback actually starts|visibly playing)\b/i.test(
      step,
    );
  }

  private isShortFormMediaRequest(description: string): boolean {
    return /\b(shorts?|youtube short|reels?|instagram reel|tiktok|clip)\b/i.test(
      description,
    );
  }

  private looksLikeNamedMediaRequest(description: string): boolean {
    return (
      this.looksLikeNamedAudioRequest(description) ||
      (/\b(play|watch|open|start)\b/i.test(description) &&
        /\b(trailer|episode|movie|film|talk|ted talk|speech|presentation|music video|lyric video|official video|official audio)\b/i.test(
          description,
        ))
    );
  }

  private looksLikeNamedAudioRequest(description: string): boolean {
    return (
      /\b(play|listen(?:\s+to)?|open|start|put on)\b/i.test(description) &&
        (/\bby\s+[a-z0-9]/i.test(description) ||
          /["'][^"']+["']/.test(description) ||
          /\b(official audio|lyric video|music video)\b/i.test(description))
    );
  }

  private buildMediaPreflightQuestion(task: Task): string {
    const kind = this.detectMediaKind(task.description);

    if (kind === 'meeting') {
      return 'Before I start, answer these in one reply: should I just join and confirm or stay until it ends, and do you want transcript and summary generated from the recorded meeting audio after it ends?';
    }

    return 'Before I start, answer these in one reply: should I just start and confirm playback or keep it running until it ends, should I stop after the requested media or continue with related autoplay, and do you want transcript and summary generated from the recorded audio after it ends?';
  }

  private buildMediaPreflightPlan(task: Task): string {
    const kind = this.detectMediaKind(task.description);
    return kind === 'meeting'
      ? 'Join the requested meeting, verify attendance, follow the selected monitoring mode, and return a summary of what happened.'
      : 'Open the requested media, verify playback, follow the selected monitoring mode, and return a summary of what happened.';
  }

  private buildGenericStartupQuestion(task: Task, plan?: string): string {
    const goal = this.summarizeTurnGoalForQuestion(this.getCurrentTurnGoal(task));
    return `For this turn: ${goal}. Proceed as-is, or add one detail first?`;
  }

  private buildFollowUpTurnPreflight(
    task: Task,
    messages: Message[],
  ): { question: string; plan: string } {
    const latestUserText = this.getLatestRealUserText(messages).trim();
    const turnGoal = this.summarizeTurnGoalForQuestion(
      latestUserText || this.getCurrentTurnGoal(task),
    );

    return {
      question: `For this turn: ${turnGoal}. Proceed as-is, or add one detail first?`,
      plan:
        'Plan the user’s latest turn from the current session state, then execute it once the user confirms or adds any final detail.',
    };
  }

  private getCurrentTurnGoal(task: Task): string {
    const security = this.getTaskSecurityState(task);
    return (
      security.session?.currentTurnGoal?.trim() ||
      task.description?.trim() ||
      'Continue the current task'
    );
  }

  private summarizeTurnGoalForQuestion(goal: string): string {
    const normalized = (goal || '').replace(/\s+/g, ' ').trim();
    if (normalized.length <= 100) {
      return normalized;
    }

    return `${normalized.slice(0, 97).trimEnd()}...`;
  }

  private buildAmbiguousFollowUpClarification(
    messages: Message[],
  ): { question: string; plan: string } | null {
    const latestUserText = this.getLatestRealUserText(messages);
    const normalized = latestUserText.trim();
    if (!normalized) {
      return null;
    }

    if (
      /\b(subject|body|message body|email body|cc|bcc|draft|reply|forward)\b/i.test(
        normalized,
      )
    ) {
      return null;
    }

    const shorthandEmailMatch = normalized.match(
      /^(?:mail|email|send mail to|send email to)\s+([^\s]+@[^\s]+)\s+(.+)$/i,
    );
    if (!shorthandEmailMatch) {
      return null;
    }

    const trailingText = shorthandEmailMatch[2].trim();
    if (!trailingText || trailingText.length > 80 || /\n/.test(trailingText)) {
      return null;
    }

    return {
      question: `Before I send it, where should "${trailingText}" go: the body, the subject, or both?`,
      plan:
        'Compose the email using the user\'s clarified subject/body intent, then continue the send flow from the current open session state.',
    };
  }

  private parseMediaPreflightReply(
    task: Task,
    messages: Message[],
  ):
    | {
        complete: true;
        preferences: NonNullable<TaskSecurityState['media']>;
      }
    | {
        complete: false;
        question: string;
      } {
    const security = this.getTaskSecurityState(task);
    const latestUserReply = this.getRealUserTextSince(
      messages,
      security.preflight?.askedAt,
    );
    return this.parseMediaPreferenceText(task, latestUserReply, security);
  }

  private buildFallbackMediaPreferencesAfterSingleQuestion(
    task: Task,
    sourceText: string,
    security: TaskSecurityState,
  ): NonNullable<TaskSecurityState['media']> {
    const normalizedText = (sourceText || '').toLowerCase();
    const kind = this.detectMediaKind(task.description);
    const shortForm =
      kind === 'video' &&
      this.isShortFormMediaRequest(`${task.description} ${sourceText}`);
    const transcriptRequested =
      /\b(transcript|transcribe|transcription|captions?|subtitles?)\b/i.test(
        normalizedText,
      ) || /\btransc[a-z]*\b/i.test(normalizedText);
    const summaryRequested =
      transcriptRequested ||
      /\b(summary|summarize|summarise|recap|notes?)\b/i.test(normalizedText);
    const keepRunningUntilDone =
      kind === 'meeting' ||
      transcriptRequested ||
      summaryRequested ||
      /\b(keep .* running|keep .* going|keep .* active|until .* ends|until .* is done|until .* finishes|stay in|stay there|attend until|listen until|watch until|through the end|till it ends)\b/i.test(
        normalizedText,
      );
    const continueWithRelatedMedia =
      kind !== 'meeting' &&
      /\b(similar music|similar songs|autoplay|keep playing|play more like this|continue playing|next songs|similar videos|keep the playlist going)\b/i.test(
        normalizedText,
      );

    const selectedModes: string[] = [];
    selectedModes.push(keepRunningUntilDone ? 'keep running until done' : 'start and confirm');
    if (kind !== 'meeting') {
      selectedModes.push(
        continueWithRelatedMedia
          ? 'continue with related media'
          : 'stop after the requested media',
      );
    }
    if (transcriptRequested) {
      selectedModes.push('capture transcript');
    }
    if (summaryRequested) {
      selectedModes.push('return summary');
    }

    return {
      ...(security.media || {}),
      kind,
      route: this.detectMediaRoute(task.description),
      platform: this.detectMediaPlatform(task.description),
      shortForm,
      keepRunningUntilDone,
      continueWithRelatedMedia,
      transcriptRequested,
      summaryRequested,
      selectedModeLabel: selectedModes.join(', '),
      askedAt: security.media?.askedAt,
      selectedAt: new Date().toISOString(),
      phase: 'opening',
      playbackPrimedAt: undefined,
      playbackVerifiedAt: undefined,
      lastSummary: undefined,
      continuationCount: 0,
      transcriptAttemptCount: 0,
      audioMonitoring: undefined,
    };
  }

  private resolveMediaPreferencesForProceed(
    task: Task,
    messages: Message[],
    security: TaskSecurityState,
  ): NonNullable<TaskSecurityState['media']> | null {
    if (!this.isMediaTask(task.description)) {
      return null;
    }

    const latestReply = this.getRealUserTextSince(
      messages,
      security.preflight?.askedAt,
    );
    const sourceText = [task.description, latestReply].filter(Boolean).join('\n');
    const parsed = this.parseMediaPreferenceText(task, sourceText, security);

    if (parsed.complete) {
      return parsed.preferences;
    }

    return this.buildFallbackMediaPreferencesAfterSingleQuestion(
      task,
      sourceText || task.description,
      security,
    );
  }

  private parseMediaPreferenceText(
    task: Task,
    sourceText: string,
    security: TaskSecurityState,
  ):
    | {
        complete: true;
        preferences: NonNullable<TaskSecurityState['media']>;
      }
    | {
        complete: false;
        question: string;
      } {
    const normalizedText = (sourceText || '').toLowerCase();
    const kind = this.detectMediaKind(task.description);
    const shortForm =
      kind === 'video' &&
      this.isShortFormMediaRequest(`${task.description} ${sourceText}`);
    const taskRequiresEndAwareFlow =
      /\b(after it ends|after the video ends|after the song ends|after it finishes|when it ends|when the video ends|when the song ends|until it ends|until it finishes|through the end|till it ends)\b/i.test(
        task.description,
      );
    const wantsAllMediaOptions =
      /\b(do all|everything|both|all (?:of it|of that|of those|three)|all three|full thing|full experience)\b/i.test(
        normalizedText,
      );
    const isBareAffirmative =
      /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|proceed|continue)$/i.test(
        normalizedText.trim(),
      );
    const wantsTranscript =
      /\b(transcript|transcribe|transcription|captions?|subtitles?)\b/i.test(
        normalizedText,
      ) ||
      /\btransc[a-z]*\b/i.test(normalizedText) ||
      /\bsubtit[a-z]*\b/i.test(normalizedText) ||
      /\bcaption[a-z]*\b/i.test(normalizedText);
    const wantsSummary =
      /\b(summary|summarize|summarise|recap|notes?)\b/i.test(normalizedText);
    const rejectsTranscript =
      /\b(no transcript|don'?t need transcript|do not need transcript|without transcript|no captions|without captions|summary only|just summary|no need for transcript|no transcript needed)\b/i.test(
        normalizedText,
      ) ||
      (/\b(just|only)\b/i.test(normalizedText) && !wantsTranscript);
    const rejectsSummary =
      /\b(no summary|don'?t need summary|do not need summary|without summary|no recap|no notes?)\b/i.test(
        normalizedText,
      );

    const explicitlyShortMode =
      /\b(just play|just join|just attend|just start|only play|only join|only attend|confirm playback|confirm it starts|start it and stop|start and stop|join and confirm|play and confirm)\b/i.test(
        normalizedText,
      );
    const explicitlyLongMode =
      /\b(keep .* running|keep .* going|keep .* active|until .* ends|until .* is done|until .* finishes|stay in|stay there|attend until|listen until|watch until|while it is going on|till it ends|till the song ends|till the video ends|through the end)\b/i.test(
        normalizedText,
      );
    const implicitLongMode =
      kind !== 'meeting' &&
      !explicitlyShortMode &&
      ((wantsTranscript || wantsSummary) ||
        (/\b(listen|watch|let it play|play it|play)\b/i.test(normalizedText) &&
          !/\b(just|only)\b/i.test(normalizedText)));

    const inferredTranscriptChoice = isBareAffirmative || wantsAllMediaOptions
      ? true
      : wantsTranscript && !rejectsTranscript;
    const inferredLongMode =
      isBareAffirmative || wantsAllMediaOptions
        ? true
        : explicitlyLongMode || implicitLongMode;
    const inferredShortMode = explicitlyShortMode;

    const missing: Array<'mode' | 'transcript'> = [];
    if (!inferredShortMode && !inferredLongMode) {
      missing.push('mode');
    }
    if (!inferredTranscriptChoice && !rejectsTranscript) {
      missing.push('transcript');
    }

    if (missing.length > 0) {
      return {
        complete: false,
        question: this.buildIncompleteMediaPreflightQuestion(task, missing),
      };
    }

    const transcriptRequested = inferredTranscriptChoice;
    const summaryRequested =
      transcriptRequested ||
      wantsAllMediaOptions ||
      isBareAffirmative ||
      (wantsSummary && !rejectsSummary);

    let keepRunningUntilDone =
      inferredLongMode ||
      taskRequiresEndAwareFlow ||
      (kind === 'meeting' && !/\b(just|only|confirm)\b/i.test(normalizedText));

    if (inferredShortMode && !taskRequiresEndAwareFlow) {
      keepRunningUntilDone = false;
    }

    if (kind !== 'meeting' && implicitLongMode) {
      keepRunningUntilDone = true;
    }

    let continueWithRelatedMedia =
      /\b(similar music|similar songs|autoplay|keep playing|play more like this|continue playing|next songs|similar videos|keep the playlist going)\b/i.test(
        normalizedText,
      );

    if (
      /\b(stop after the song|stop after the video|stop after it ends|stop after it is done|once the song ends|once it ends|when the song ends|when it ends|only this song|only this video)\b/i.test(
        normalizedText,
      )
    ) {
      continueWithRelatedMedia = false;
    }

    const selectedModes: string[] = [];
    selectedModes.push(keepRunningUntilDone ? 'keep running until done' : 'start and confirm');
    if (kind !== 'meeting') {
      selectedModes.push(
        continueWithRelatedMedia
          ? 'continue with related media'
          : 'stop after the requested media',
      );
    }
    if (transcriptRequested) {
      selectedModes.push('capture transcript');
    }
    if (summaryRequested) {
      selectedModes.push('return summary');
    }

    return {
      complete: true,
      preferences: {
        kind,
        route: this.detectMediaRoute(task.description),
        platform: this.detectMediaPlatform(task.description),
        shortForm,
        keepRunningUntilDone,
        continueWithRelatedMedia,
        transcriptRequested,
        summaryRequested,
        selectedModeLabel: selectedModes.join(', '),
        askedAt: security.media?.askedAt,
        selectedAt: new Date().toISOString(),
        phase: 'opening',
        playbackPrimedAt: undefined,
        playbackVerifiedAt: undefined,
        lastSummary: undefined,
        continuationCount: 0,
        transcriptAttemptCount: 0,
        audioMonitoring: undefined,
      },
    };
  }

  private buildIncompleteMediaPreflightQuestion(
    task: Task,
    missing: Array<'mode' | 'transcript'>,
  ): string {
    const kind = this.detectMediaKind(task.description);
    const parts: string[] = [];

    if (missing.includes('mode')) {
      parts.push(
        kind === 'meeting'
          ? 'should I just join and confirm, or stay until it ends?'
          : 'should I just start it and confirm playback, or keep it running until it ends?',
      );
    }

    if (missing.includes('transcript')) {
      parts.push(
        'Do you want transcript and summary generated from the recorded audio after it ends, or no transcript?',
      );
    }

    return `Before I start, I still need a quick clarification: ${parts.join(' Also, ')}`;
  }

  private getLatestRealUserText(messages: Message[]): string {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== Role.USER || !message.id) {
        continue;
      }

      const text = this.getCombinedTextContent(
        (message.content || []) as MessageContentBlock[],
      );
      if (text.trim()) {
        return text.trim();
      }
    }

    return '';
  }

  private getRealUserTextSince(messages: Message[], sinceIso?: string): string {
    if (!sinceIso) {
      return this.getLatestRealUserText(messages);
    }

    const sinceMs = new Date(sinceIso).getTime();
    const texts: string[] = [];

    for (const message of messages) {
      if (message.role !== Role.USER || !message.id) {
        continue;
      }

      const createdAtMs = new Date(message.createdAt).getTime();
      if (
        Number.isFinite(sinceMs) &&
        Number.isFinite(createdAtMs) &&
        createdAtMs < sinceMs
      ) {
        continue;
      }

      const text = this.getCombinedTextContent(
        (message.content || []) as MessageContentBlock[],
      );
      if (text.trim()) {
        texts.push(text.trim());
      }
    }

    return texts.length > 0 ? texts.join('\n') : '';
  }

  private async enforceFinalResultReview(
    taskId: string,
    task: Task,
    contentBlocks: MessageContentBlock[],
  ): Promise<MessageContentBlock[]> {
    const completedBlock = contentBlocks.find(
      (block) =>
        isSetTaskStatusToolUseBlock(block) && block.input.status === 'completed',
    ) as SetTaskStatusToolUseBlock | undefined;

    const security = this.getTaskSecurityState(task);
    if (
      this.isMediaTask(task.description) &&
      (
        security.media?.keepRunningUntilDone ||
        security.media?.transcriptRequested ||
        security.media?.summaryRequested
      )
    ) {
      return contentBlocks;
    }

    if (!completedBlock || !this.requiresFinalResultReview(task)) {
      return contentBlocks;
    }

    const reviewStepAlreadyPresent = contentBlocks.some(
      (block) =>
        (block as ToolUseContentBlock).name === 'execute_desktop_step' &&
        this.isFinalResultReviewDescription(
          String((block as ToolUseContentBlock).input?.description || ''),
        ),
    );
    const existingReview = security.execution?.resultReview;
    if (reviewStepAlreadyPresent || existingReview?.completedAt) {
      return contentBlocks;
    }

    const filteredBlocks = contentBlocks.filter(
      (block) =>
        !(
          isSetTaskStatusToolUseBlock(block) && block.input.status === 'completed'
        ),
    );

      filteredBlocks.push({
        id: `result-review-${Date.now()}`,
        type: 'tool_use',
        name: 'execute_desktop_step',
        input: {
          description: this.buildFinalResultReviewStep(task),
          execution_mode: 'fast',
          completion_condition:
            'The actual result, confirmation, or final state requested by the user is visibly on screen and the key facts needed for the final answer are visible.',
          drift_condition:
            'The current page does not yet show the real result, confirmation, or final state needed to answer the user reliably.',
      },
    } as ToolUseContentBlock);

    const updatedResult = this.mergeTaskResult(task, {
      security: {
        ...security,
        execution: {
          ...(security.execution || {}),
          resultReview: {
            ...(security.execution?.resultReview || {}),
            pending: true,
            requestedAt: new Date().toISOString(),
            completedAt: undefined,
            lastDescription: undefined,
            lastSummary: undefined,
            followUpCount:
              security.execution?.resultReview?.followUpCount || 0,
          },
        },
      },
    });

    await this.tasksService.update(taskId, {
      result: updatedResult,
    });
    task.result = updatedResult as any;
    this.logger.log(
      `Injected final result review checkpoint before completion for task ${taskId}`,
    );

    return filteredBlocks;
  }

  private async enforceCompletionReadiness(
    taskId: string,
    task: Task,
    contentBlocks: MessageContentBlock[],
  ): Promise<MessageContentBlock[]> {
    const completedBlock = contentBlocks.find(
      (block) =>
        isSetTaskStatusToolUseBlock(block) && block.input.status === 'completed',
    ) as SetTaskStatusToolUseBlock | undefined;

    if (!completedBlock) {
      return contentBlocks;
    }

    const security = this.getTaskSecurityState(task);
    const stepPlan = security.execution?.stepPlan;
    const hasRemainingPlannedSteps =
      !!stepPlan &&
      (stepPlan.totalSteps || 0) > 1 &&
      (stepPlan.currentIndex || 1) < (stepPlan.totalSteps || 0);

    if (
      hasRemainingPlannedSteps &&
      !this.isFinalResultReviewDescription(
        security.execution?.activeExecution?.description || '',
      )
    ) {
      const remainingSteps = this.rebuildRemainingPlannedSteps(task, stepPlan);
      if (remainingSteps.length > 0) {
        const filteredBlocks = contentBlocks.filter(
          (block) =>
            !(
              isSetTaskStatusToolUseBlock(block) &&
              block.input.status === 'completed'
            ),
        );

        filteredBlocks.push({
          id: `continue-plan-${Date.now()}`,
          type: 'tool_use',
          name: 'queue_desktop_plan',
          input: {
            summary:
              stepPlan?.summary ||
              this.getCurrentTurnGoal(task) ||
              'Continue the remaining planned steps from the current visible state.',
            source: stepPlan?.source || 'initial',
            steps: remainingSteps.map((step) => ({
              description: step.description,
              execution_mode: step.executionMode,
              ...(step.expectedState && { expected_state: step.expectedState }),
              ...(step.completionCondition && {
                completion_condition: step.completionCondition,
              }),
              ...(step.driftCondition && {
                drift_condition: step.driftCondition,
              }),
            })),
          },
        } as ToolUseContentBlock);

        this.logger.log(
          `Blocked premature completion for task ${taskId}; continuing remaining ${remainingSteps.length} planned step(s) from current visible state`,
        );

        return filteredBlocks;
      }
    }

    if (
      this.isMediaTask(task.description) &&
      (
        security.media?.keepRunningUntilDone ||
        security.media?.transcriptRequested ||
        security.media?.summaryRequested
      )
    ) {
      return this.enforceMediaCompletionReadiness(
        taskId,
        task,
        contentBlocks,
        security,
      );
    }

    if (!this.requiresFinalResultReview(task)) {
      return contentBlocks;
    }

    const resultReview = security.execution?.resultReview;
    const lastReviewSummary = resultReview?.lastSummary || '';

    if (!resultReview?.completedAt || !this.reviewIndicatesIncomplete(lastReviewSummary)) {
      return contentBlocks;
    }

    const filteredBlocks = contentBlocks.filter(
      (block) =>
        !(
          isSetTaskStatusToolUseBlock(block) && block.input.status === 'completed'
        ),
    );

    const followUpCount = resultReview.followUpCount || 0;

    filteredBlocks.push({
      id: `result-follow-up-${Date.now()}`,
      type: 'tool_use',
      name: 'execute_desktop_step',
      input: {
        description: this.buildResultFollowUpStep(task, lastReviewSummary),
        execution_mode: followUpCount >= 1 ? 'guarded' : 'fast',
        completion_condition:
          'The concrete final result requested by the user is visibly on screen, and the key facts needed for the final answer clearly match the request.',
        drift_condition:
          'The current page still does not show a final visible result that matches the user request, or the visible facts still contradict the requested outcome.',
      },
    } as ToolUseContentBlock);

    const updatedResult = this.mergeTaskResult(task, {
      security: {
        ...security,
        execution: {
          ...(security.execution || {}),
          resultReview: {
            ...(resultReview || {}),
            pending: true,
            requestedAt: new Date().toISOString(),
            completedAt: undefined,
            followUpCount: followUpCount + 1,
          },
        },
      },
    });

    await this.tasksService.update(taskId, {
      result: updatedResult,
    });
    task.result = updatedResult as any;
    this.logger.log(
      `Blocked premature completion after final review for task ${taskId}; follow-up count ${followUpCount + 1}`,
    );

    return filteredBlocks;
  }

  private async recoverEmptyMediaPlannerResponse(
    taskId: string,
    task: Task,
  ): Promise<MessageContentBlock[]> {
    const security = this.getTaskSecurityState(task);
    const media = security.media;

    if (
      !this.isMediaTask(task.description) ||
      !media?.selectedAt ||
      this.mediaReviewIndicatesEnded(media.lastSummary || '', media)
    ) {
      return [];
    }

    const stillNeedsExecution =
      !media.playbackVerifiedAt ||
      media.keepRunningUntilDone ||
      media.transcriptRequested ||
      media.summaryRequested;

    if (!stillNeedsExecution) {
      return [];
    }

    const syntheticContinuationCount =
      security.execution?.syntheticContinuationCount || 0;
    if (syntheticContinuationCount >= 4) {
      return [];
    }

    const updatedResult = this.mergeTaskResult(task, {
      security: {
        ...security,
        execution: {
          ...(security.execution || {}),
          syntheticContinuationCount: syntheticContinuationCount + 1,
          lastSyntheticContinuationAt: new Date().toISOString(),
          lastSyntheticContinuationText:
            media.lastSummary ||
            'Recovered from an empty planner response during an active media task.',
        },
      },
    });

    await this.tasksService.update(taskId, {
      result: updatedResult,
    });
    task.result = updatedResult as any;

    this.logger.warn(
      `Recovered empty planner response for active media task ${taskId} by injecting a continuation step`,
    );

    return [
      {
        id: `media-empty-recovery-${Date.now()}`,
        type: 'tool_use',
        name: 'execute_desktop_step',
        input: {
          description: this.buildMediaContinuationStep(
            task,
            media.lastSummary || '',
          ),
          execution_mode: this.getMediaContinuationExecutionMode(
            media,
            media.lastSummary || '',
          ),
          completion_condition:
            !media.playbackVerifiedAt
              ? 'Only mark this step complete once the requested media or meeting is visibly active on screen, not just loaded, paused, or blocked by an ad or waiting state.'
              : 'Only mark this step complete once the requested media session is stable again or the requested media clearly ends.',
          drift_condition:
            'Only mark drift if the current page is clearly on the wrong media, a login wall, a network error, or another blocker that cannot be recovered from within the current session.',
        },
      } as ToolUseContentBlock,
    ];
  }

  private async enforceMediaExecutionProgress(
    taskId: string,
    task: Task,
    contentBlocks: MessageContentBlock[],
  ): Promise<MessageContentBlock[]> {
    const security = this.getTaskSecurityState(task);
    const mediaState = security.media;

    if (!this.isMediaTask(task.description) || !mediaState?.selectedAt) {
      return contentBlocks;
    }

    const hasToolUseBlocks = contentBlocks.some(
      (block) => block.type === MessageContentType.ToolUse,
    );
    if (hasToolUseBlocks) {
      return contentBlocks;
    }

    const assistantText = this.getCombinedTextContent(contentBlocks);
    if (!assistantText) {
      return contentBlocks;
    }

    const stillNeedsExecution =
      !mediaState.playbackVerifiedAt ||
      mediaState.keepRunningUntilDone ||
      mediaState.transcriptRequested ||
      mediaState.summaryRequested;

    if (!stillNeedsExecution) {
      return contentBlocks;
    }

    const inferredStatus = this.inferImplicitTerminalStatus(task, assistantText);

    if (
      inferredStatus === 'failed' ||
      this.mediaReviewIndicatesEnded(assistantText, mediaState) ||
      /\b(captcha|recaptcha|i'?m not a robot|not a robot|cloudflare|turnstile|hcaptcha|cf-challenge|approval received)\b/i.test(
        assistantText,
      )
    ) {
      return contentBlocks;
    }

    const syntheticContinuationCount =
      security.execution?.syntheticContinuationCount || 0;

    if (syntheticContinuationCount >= 4) {
      const updatedResult = this.mergeTaskResult(task, {
        security: {
          ...security,
          execution: {
            ...(security.execution || {}),
            syntheticContinuationCount: syntheticContinuationCount + 1,
            lastSyntheticContinuationAt: new Date().toISOString(),
            lastSyntheticContinuationText: assistantText,
          },
        },
      });

      await this.tasksService.update(taskId, {
        result: updatedResult,
      });
      task.result = updatedResult as any;

      this.logger.warn(
        `Planner produced plain-text media progress without actions repeatedly for task ${taskId}; forcing a guarded continuation step instead of interrupting the user`,
      );

      return [
        ...contentBlocks,
        {
          id: `media-progress-guarded-step-${Date.now()}`,
          type: 'tool_use',
          name: 'execute_desktop_step',
          input: {
            description: this.buildMediaContinuationStep(task, assistantText),
            execution_mode: 'guarded',
            completion_condition:
              !mediaState.playbackVerifiedAt
                ? 'Only mark this step complete once the requested media or meeting is visibly active on screen, not just loaded, titled, paused, or showing an ad.'
                : 'Only mark this step complete once the requested media session is stable again or the requested media clearly ends.',
            drift_condition:
              'Only mark drift if the current page is clearly on the wrong media, a login wall, a network error, or another blocker that cannot be recovered from within the current session.',
          },
        } as ToolUseContentBlock,
      ];
    }

    const updatedResult = this.mergeTaskResult(task, {
      security: {
        ...security,
        execution: {
          ...(security.execution || {}),
          syntheticContinuationCount: syntheticContinuationCount + 1,
          lastSyntheticContinuationAt: new Date().toISOString(),
          lastSyntheticContinuationText: assistantText,
        },
      },
    });

    await this.tasksService.update(taskId, {
      result: updatedResult,
    });
    task.result = updatedResult as any;

    this.logger.log(
      `Injected media continuation step after plain-text planner narration for task ${taskId}`,
    );

    return [
      ...contentBlocks,
      {
        id: `media-progress-step-${Date.now()}`,
        type: 'tool_use',
        name: 'execute_desktop_step',
        input: {
          description: this.buildMediaContinuationStep(task, assistantText),
          execution_mode: this.getMediaContinuationExecutionMode(
            mediaState,
            assistantText,
          ),
          completion_condition:
            !mediaState.playbackVerifiedAt
              ? 'Only mark this step complete once the requested media or meeting is visibly active on screen, not just loaded, titled, paused, or showing an ad.'
              : 'Only mark this step complete once the requested media session is stable again or the requested media clearly ends.',
          drift_condition:
            'Only mark drift if the current page is clearly on the wrong media, a login wall, a network error, or another blocker that cannot be recovered from within the current session.',
        },
      } as ToolUseContentBlock,
    ];
  }

  private async enforceMediaCandidateContinuation(
    taskId: string,
    task: Task,
    contentBlocks: MessageContentBlock[],
  ): Promise<MessageContentBlock[]> {
    const security = this.getTaskSecurityState(task);
    const mediaState = security.media;

    if (!this.isMediaTask(task.description) || !mediaState?.selectedAt) {
      return contentBlocks;
    }

    const assistantText = this.getCombinedTextContent(contentBlocks);
    if (!assistantText || !this.mediaSummaryShowsVisibleMatchingCandidate(task, assistantText)) {
      return contentBlocks;
    }

    const needsHelpBlock = contentBlocks.find(
      (block) =>
        isSetTaskStatusToolUseBlock(block) && block.input.status === 'needs_help',
    );

    const looksLikeAttentionNarration =
      /\bi need your attention\b/i.test(assistantText) ||
      /\bsend the next instruction\b/i.test(assistantText);

    if (!needsHelpBlock && !looksLikeAttentionNarration) {
      return contentBlocks;
    }

    const filteredBlocks = contentBlocks.filter(
      (block) =>
        !(
          isSetTaskStatusToolUseBlock(block) && block.input.status === 'needs_help'
        ),
    );

    filteredBlocks.push({
      id: `media-candidate-auto-continue-${Date.now()}`,
      type: MessageContentType.Text,
      text: 'A matching media candidate is already visible, so continuing automatically from the current YouTube state.',
    } as TextContentBlock);

    filteredBlocks.push({
      id: `media-candidate-step-${Date.now()}`,
      type: 'tool_use',
      name: 'execute_desktop_step',
      input: {
        description: this.buildMediaContinuationStep(task, assistantText),
        execution_mode: 'guarded',
        completion_condition:
          'Only mark this step complete once the matching requested media is open on the player and playback is visibly active, not just visible in results.',
        drift_condition:
          'Only mark drift if the current page leaves the chosen media platform, the visible media clearly violates the request, or a real blocker prevents opening the matching candidate.',
      },
    } as ToolUseContentBlock);

    return filteredBlocks;
  }

  private async enforceMediaCompletionReadiness(
    taskId: string,
    task: Task,
    contentBlocks: MessageContentBlock[],
    security: TaskSecurityState,
  ): Promise<MessageContentBlock[]> {
    const completedBlock = contentBlocks.find(
      (block) =>
        isSetTaskStatusToolUseBlock(block) && block.input.status === 'completed',
    ) as SetTaskStatusToolUseBlock | undefined;

    if (!completedBlock) {
      return contentBlocks;
    }

    const resultReview = security.execution?.resultReview;
    const mediaState = security.media;
    const lastMediaSummary =
      mediaState?.lastSummary || resultReview?.lastSummary || '';

    if (this.mediaReviewIndicatesEnded(lastMediaSummary, mediaState)) {
      return contentBlocks;
    }

    const filteredBlocks = contentBlocks.filter(
      (block) =>
        !(
          isSetTaskStatusToolUseBlock(block) && block.input.status === 'completed'
        ),
    );

    filteredBlocks.push({
      id: `media-follow-up-${Date.now()}`,
      type: 'tool_use',
      name: 'execute_desktop_step',
      input: {
        description: this.buildMediaContinuationStep(task, lastMediaSummary),
        execution_mode: this.getMediaContinuationExecutionMode(
          mediaState,
          lastMediaSummary,
          { terminalCheck: true },
        ),
        completion_condition:
          'Only mark this step complete once the media or meeting has clearly ended, stopped, disconnected, or the user-visible session is no longer active.',
        drift_condition:
          'Only mark drift if the page is clearly on the wrong media, a login wall, a network error, the wrong app/site, or another blocker that cannot be recovered by skipping an ad or resuming playback.',
      },
    } as ToolUseContentBlock);

    const updatedResult = this.mergeTaskResult(task, {
      security: {
        ...security,
        media: {
          ...(mediaState || {}),
          continuationCount: (mediaState?.continuationCount || 0) + 1,
          lastSummary: lastMediaSummary,
        },
        execution: {
          ...(security.execution || {}),
          resultReview: {
            ...(resultReview || {}),
            pending: true,
            requestedAt: new Date().toISOString(),
            completedAt: undefined,
            followUpCount: resultReview?.followUpCount || 0,
          },
        },
      },
    });

    await this.tasksService.update(taskId, {
      result: updatedResult,
    });
    task.result = updatedResult as any;

    this.logger.log(
      `Blocked early media completion for task ${taskId}; waiting for the session to actually end`,
    );

    return filteredBlocks;
  }

  private requiresFinalResultReview(task: Task): boolean {
    const description = task.description.toLowerCase();
    const explicitlyRequestsVerification =
      /\b(verify|review|inspect|confirm)\b/i.test(description) ||
      /\bcheck\b.{0,40}\b(result|results|screen|page|confirmation|visible|outcome|facts|state)\b/i.test(
        description,
      ) ||
      /\b(what do you see|on screen|visible page|visible result|visible confirmation)\b/i.test(
        description,
      ) ||
      /\bextract\b/i.test(description) &&
        /\b(screen|page|result|confirmation|visible)\b/i.test(description);
    const sensitiveOutcome =
      /\b(submit|send|email|message|purchase|buy|pay|payment|book|booking|checkout|delete|remove|cancel|apply|transfer|wire|post|publish)\b/i.test(
        description,
      );

    return explicitlyRequestsVerification || sensitiveOutcome;
  }

  private getImmediateHumanOnlyAttentionPrompt(
    stepDescription: string,
    summaryText: string,
    checkpoints?: Array<{
      visibleSummary?: string;
      extractedFacts?: Record<string, string>;
    }>,
    currentUrl?: string,
  ): string | null {
    const checkpointText = (checkpoints || [])
      .flatMap((checkpoint) => [
        checkpoint.visibleSummary || '',
        ...Object.values(checkpoint.extractedFacts || {}),
      ])
      .join(' ');
    const combined = [summaryText, checkpointText, currentUrl || '']
      .filter(Boolean)
      .join('\n');

    return this.isHumanOnlyAttentionNeeded(combined)
      ? 'A CAPTCHA or human verification step is blocking progress. Please complete it in the desktop view, then send the next instruction here to continue.'
      : null;
  }

  private isFinalResultReviewDescription(description: string): boolean {
    if (this.isStructuredExecutionBrief(description)) {
      return false;
    }

    return /\b(review|verify|check|inspect|confirm|extract)\b.*\b(result|results|visible|screen|page|confirmation|outcome|facts|state)\b|\bresult-review\b/i.test(
      description,
    );
  }

  private buildFinalResultReviewStep(task: Task): string {
    if (this.isMediaTask(task.description)) {
      return `Review the current media or meeting state for this task and verify the key facts needed to answer the user accurately. Confirm whether playback or attendance is active, whether an ad or blocker is visible, what title or session is on screen, and whether the requested media or meeting has ended yet: ${task.description}`;
    }

    return `Read-only result review: inspect the current visible result or confirmation state for this task and verify the key facts needed to answer the user accurately. Confirm only what is visibly on screen for: ${this.getCurrentTurnGoal(task)}. Do not continue searching, editing, or restarting the flow during this review.`;
  }

  private buildResultFollowUpStep(task: Task, reviewSummary: string): string {
    if (this.isMediaTask(task.description)) {
      return this.buildMediaContinuationStep(task, reviewSummary);
    }

    const trimmedSummary = reviewSummary.replace(/\s+/g, ' ').trim();
    const clippedSummary =
      trimmedSummary.length > 320
        ? `${trimmedSummary.slice(0, 317)}...`
        : trimmedSummary;

    return `The previous final review showed that the visible result was not ready to complete yet. Continue from the current page and reach a final visible result that clearly matches the user's request: ${this.getCurrentTurnGoal(task)}. Resolve this issue before finishing: ${clippedSummary}`;
  }

  private reviewIndicatesIncomplete(summary: string): boolean {
    const normalized = summary.toLowerCase();
    if (!normalized.trim()) {
      return false;
    }

    const incompleteSignals = [
      'more interaction is needed',
      'not yet visible',
      'not visible on the screen',
      'not visible on screen',
      'not visible',
      'not ready',
      'not complete',
      'not completed',
      'still needs',
      'still requires',
      'further input is required',
      'further input required',
      'search button is not visible',
      'has not been clicked',
      'ready for the search to be initiated',
      'needs to be clicked',
      'needs to click',
      'sorted by "best"',
      'sorted by best',
      'showing a calendar overlay',
      'prompting for',
      'current page still does not show',
      'does not yet show',
      'does not show the real result',
      'contradict',
      'mismatch',
      'wrong page',
      'stale state',
      'retry',
      'drift',
    ];

    return incompleteSignals.some((signal) => normalized.includes(signal));
  }

  private buildMediaContinuationStep(task: Task, reviewSummary: string): string {
    const kind = this.detectMediaKind(task.description);
    const security = this.getTaskSecurityState(task);
    const media = security.media;
    const route = this.getMediaRoute(task);
    const normalizedSummary = typeof reviewSummary === 'string' ? reviewSummary : '';
    const trimmedSummary = normalizedSummary.replace(/\s+/g, ' ').trim();
    const clippedSummary =
      trimmedSummary.length > 260
        ? `${trimmedSummary.slice(0, 257)}...`
        : trimmedSummary;
    const reviewState = this.classifyMediaReviewState(normalizedSummary, media);

    if (kind === 'meeting') {
      if (!media?.playbackVerifiedAt) {
        return `Return to the requested meeting for this task: ${task.description}. Reuse the current browser tab or meeting window if it is already open. Verify that the meeting is actually joined and active on screen before doing anything else. If a join button, waiting room, login prompt, or permission blocker is visible, resolve that first. Start the final summary with exactly one label: MEDIA_STATE=meeting_active, MEDIA_STATE=meeting_quiet, MEDIA_STATE=meeting_waiting, MEDIA_STATE=network_issue, MEDIA_STATE=meeting_ended, or MEDIA_STATE=unknown. Do not complete the task until the meeting is visibly active.`;
      }

      if (
        media.phase === 'playback_verification' ||
        media.phase === 'network_recovery' ||
        reviewState === 'network_issue'
      ) {
        return `Return to the active meeting for this task: ${task.description}. Reuse the current meeting page if it is already open. If the meeting is reconnecting, showing a network issue, asking to rejoin, or otherwise no longer clearly active, recover it now and confirm that the meeting is visibly active again before doing anything else. Start the final summary with exactly one label: MEDIA_STATE=meeting_active, MEDIA_STATE=meeting_quiet, MEDIA_STATE=meeting_waiting, MEDIA_STATE=network_issue, MEDIA_STATE=meeting_ended, or MEDIA_STATE=unknown.`;
      }

      if (
        media.phase === 'quiet_monitoring' ||
        reviewState === 'meeting_quiet' ||
        reviewState === 'meeting_waiting'
      ) {
        return `Continue monitoring the current meeting for this task: ${task.description}. Keep the meeting window open and avoid disruptive clicks. If the meeting is still joined but people are quiet, waiting for someone, or waiting for the host, leave it alone and keep monitoring instead of ending the task. Only take action if a visible blocker, disconnect, or real ended state appears. Start the final summary with exactly one label: MEDIA_STATE=meeting_active, MEDIA_STATE=meeting_quiet, MEDIA_STATE=meeting_waiting, MEDIA_STATE=network_issue, MEDIA_STATE=meeting_ended, or MEDIA_STATE=unknown.${clippedSummary ? ` Current context: ${clippedSummary}` : ''}`;
      }

      return `Continue monitoring the current meeting for this task: ${task.description}. Keep the meeting active, use low-frequency checks, and avoid disruptive clicks. Once attendance is confirmed, rely on telemetry-triggered visual reviews and recorded audio for any requested transcript or summary. Silence alone does not mean the meeting ended. If silence lasts for roughly 90 seconds, do one focused screenshot-based review and only end if the meeting visibly ended. Otherwise stay in quiet monitoring. Start the final summary with exactly one label: MEDIA_STATE=meeting_active, MEDIA_STATE=meeting_quiet, MEDIA_STATE=meeting_waiting, MEDIA_STATE=network_issue, MEDIA_STATE=meeting_ended, or MEDIA_STATE=unknown.${clippedSummary ? ` Current context: ${clippedSummary}` : ''}`;
    }

    const stopAfterRequestedMedia = this.shouldStopAfterRequestedMedia(media);

    if (
      this.hasLatchedMediaCompletion(media, clippedSummary) ||
      reviewState === 'requested_media_ended' ||
      (reviewState === 'follow_on_media' && stopAfterRequestedMedia)
    ) {
      return `The requested media for this task has already finished: ${task.description}. If a follow-on song, autoplay, or Up Next item started, pause or stop that follow-on playback if possible. Do not search again or go back. Prepare the final Gemini transcript and summary from the recorded audio now.${clippedSummary ? ` Current context: ${clippedSummary}` : ''}`;
    }

    if (!media?.playbackVerifiedAt || media.phase === 'opening') {
      return `Return to the requested media for this task: ${task.description}. Stay inside the current media flow on ${this.buildSupportedVideoSurfacePhrase(task.description)}, pause or close any unrelated audio or video that is already playing elsewhere, and continue from the current ${this.buildSupportedVideoSurfacePhrase(task.description)} page if it already shows the search box, relevant results, or a player. Do not reopen the same site or retype the same search query when the current screen is already useful. ${this.buildMediaVisibleConstraintInstruction(task.description)} Get to the correct video or song page, handle any ad if present, and verify that the requested media is actively playing. A paused player, title-only page, or blank player is not enough.${route === 'supported_video' ? ` Do not leave ${this.buildSupportedVideoSurfacePhrase(task.description)} for any other site while opening or recovering this task.` : ''} If the visible title, artist, channel, or player context does not match the requested media, treat that as MEDIA_STATE=requested_media_mismatch instead of pretending playback is correct. When visible, capture the player's current time and total duration in the review summary or extracted facts. Start the final summary with exactly one label: MEDIA_STATE=requested_media_active, MEDIA_STATE=requested_media_paused, MEDIA_STATE=requested_media_mismatch, MEDIA_STATE=ad_visible, MEDIA_STATE=follow_on_media, MEDIA_STATE=requested_media_ended, MEDIA_STATE=network_issue, or MEDIA_STATE=unknown.`;
    }

    if (media.phase === 'ad_handling' || reviewState === 'ad_visible') {
      return `Stay on the current media session for this task: ${task.description}. If an ad is visible, skip it when possible or wait through it. As soon as the ad is gone, make sure the requested media is actively playing again before stopping. If the current player has drifted to the wrong media, label it MEDIA_STATE=requested_media_mismatch. Start the final summary with exactly one label: MEDIA_STATE=requested_media_active, MEDIA_STATE=requested_media_paused, MEDIA_STATE=requested_media_mismatch, MEDIA_STATE=ad_visible, MEDIA_STATE=follow_on_media, MEDIA_STATE=requested_media_ended, MEDIA_STATE=network_issue, or MEDIA_STATE=unknown. Do not restart the whole task.`;
    }

    if (
      media.phase === 'playback_verification' ||
      reviewState === 'requested_media_paused' ||
      reviewState === 'network_issue'
    ) {
      return `Return to the requested media for this task: ${task.description}. Reuse the current player page if it is already open on ${this.buildSupportedVideoSurfacePhrase(task.description)}, and pause or close any unrelated audio or video still playing elsewhere. ${this.buildMediaVisibleConstraintInstruction(task.description)} If the player is paused, click Play or press Space to resume it. If a visible network or reconnect problem is blocking playback, recover that current session instead of starting over.${route === 'supported_video' ? ` If you are not on ${this.buildSupportedVideoSurfacePhrase(task.description)}, leave the current site and return to ${this.buildSupportedVideoSurfacePhrase(task.description)} first.` : ''} Confirm the requested media is actively playing and progressing before moving on. If the current player is on a different title, artist, or unrelated item, label it MEDIA_STATE=requested_media_mismatch. When visible, capture the player's current time and total duration in the review summary or extracted facts. Start the final summary with exactly one label: MEDIA_STATE=requested_media_active, MEDIA_STATE=requested_media_paused, MEDIA_STATE=requested_media_mismatch, MEDIA_STATE=ad_visible, MEDIA_STATE=follow_on_media, MEDIA_STATE=requested_media_ended, MEDIA_STATE=network_issue, or MEDIA_STATE=unknown. Do not open transcript, settings, browser chrome, or unrelated controls until playback is stable again.`;
    }

    if (media.transcriptRequested || media.summaryRequested) {
      return `Continue monitoring the current media session for this task: ${task.description}. Keep playback stable with low-frequency checks and avoid disruptive clicks. Do not open transcript or caption UI. If audio recording is active, rely on that recording for Gemini transcript and summary generation after the requested media finishes. If the requested short, reel, or video loops back to the beginning after one playthrough, treat that as the requested media having finished instead of replaying it. On any triggered visual review, verify that the visible title, artist, channel, or player context still matches the requested media; if not, label it MEDIA_STATE=requested_media_mismatch. Start the final summary with exactly one label: MEDIA_STATE=requested_media_active, MEDIA_STATE=requested_media_paused, MEDIA_STATE=requested_media_mismatch, MEDIA_STATE=ad_visible, MEDIA_STATE=follow_on_media, MEDIA_STATE=requested_media_ended, MEDIA_STATE=network_issue, or MEDIA_STATE=unknown.${stopAfterRequestedMedia ? ' If autoplay, Up Next, or a different follow-on song/video starts after the requested media ends, treat that as the requested media having finished, stop the follow-on playback if possible, and prepare the final summary.' : ' If follow-on media starts and the user asked to keep similar music or videos going, keep monitoring instead of ending immediately.'}${clippedSummary ? ` Current context: ${clippedSummary}` : ''}`;
    }

    return `Continue monitoring the current media session for this task: ${task.description}. Keep playback stable with low-frequency checks. If an ad appears, skip it or wait it out. If the player becomes paused, resume playback and verify it is actively playing again. Avoid extra menus and keep the session stable once playback is confirmed. If the requested short, reel, or video loops back to the beginning after one playthrough, treat that as the requested media having finished instead of replaying it. On any triggered visual review, verify that the visible title, artist, channel, or player context still matches the requested media; if not, label it MEDIA_STATE=requested_media_mismatch. Start the final summary with exactly one label: MEDIA_STATE=requested_media_active, MEDIA_STATE=requested_media_paused, MEDIA_STATE=requested_media_mismatch, MEDIA_STATE=ad_visible, MEDIA_STATE=follow_on_media, MEDIA_STATE=requested_media_ended, MEDIA_STATE=network_issue, or MEDIA_STATE=unknown.${stopAfterRequestedMedia ? ' If autoplay, Up Next, or a different follow-on song/video starts after the requested media ends, treat that as the requested media having finished, stop the follow-on playback if possible, and prepare the final summary.' : ' If follow-on media starts and the user asked to keep similar music or videos going, keep monitoring instead of ending immediately.'}${clippedSummary ? ` Current context: ${clippedSummary}` : ''}`;
  }

  private async maybeQueueMediaRecoveryFromBlockedStep(
    taskId: string,
    task: Task,
    blockedStep: NonNullable<TaskSecurityState['execution']>['blockedStep'],
  ): Promise<Task | null> {
    if (!blockedStep || !this.isMediaTask(task.description)) {
      return null;
    }

    const media = this.getTaskSecurityState(task).media;
    const openingLikeMediaPhase =
      media?.phase === 'opening' ||
      media?.phase === 'playback_verification' ||
      media?.phase === 'network_recovery';
    if (
      blockedStep.watchdogReason !== 'wrong_surface' &&
      blockedStep.watchdogReason !== 'media_mismatch' &&
      !(
        openingLikeMediaPhase &&
        (blockedStep.watchdogReason === 'looping' ||
          blockedStep.watchdogReason === 'stuck')
      )
    ) {
      return null;
    }

    const reviewSummary =
      blockedStep.lastVisibleSummary || blockedStep.reason || task.description;
    const recoveryTask = await this.storeActiveExecutionHandoff(taskId, task, {
      summary: `Media recovery is restoring ${this.buildChosenMediaSurfacePhrase(task.description)} and the requested playback state.`,
      source: 'replan',
      step: {
        description: this.buildMediaContinuationStep(task, reviewSummary),
        executionMode: 'guarded',
        completionCondition:
          `Only mark this recovery complete once the requested media is back on ${this.buildChosenMediaSurfacePhrase(task.description)} and playback is visibly active again, or the requested media clearly ended.`,
        driftCondition:
          'Drift exists only if the current page remains on the wrong surface, the wrong media keeps playing, or another blocker prevents restoring the requested media state.',
      },
    });

    const updatedResult = this.mergeTaskResult(recoveryTask, {
      security: {
        ...this.getTaskSecurityState(recoveryTask),
        execution: {
          ...(this.getTaskSecurityState(recoveryTask).execution || {}),
          blockedStep: undefined,
        },
      },
    });
    await this.tasksService.update(taskId, {
      result: updatedResult,
    });
    recoveryTask.result = updatedResult as any;
    return recoveryTask;
  }

  private extractMediaStateLabel(summary: string): MediaReviewState | null {
    const match = /media_state\s*=\s*([a-z_]+)/i.exec(summary);
    if (!match) {
      return null;
    }

    const label = match[1].toLowerCase() as MediaReviewState;
    const allowed: MediaReviewState[] = [
      'requested_media_active',
      'requested_media_paused',
      'requested_media_mismatch',
      'ad_visible',
      'follow_on_media',
      'requested_media_ended',
      'meeting_active',
      'meeting_quiet',
      'meeting_waiting',
      'meeting_ended',
      'network_issue',
      'unknown',
    ];
    return allowed.includes(label) ? label : null;
  }

  private classifyMediaReviewState(
    summary: string,
    media?: NonNullable<TaskSecurityState['media']>,
  ): MediaReviewState {
    const normalized = summary.toLowerCase().trim();
    if (!normalized) {
      return 'unknown';
    }

    const explicitLabel = this.extractMediaStateLabel(normalized);
    if (explicitLabel) {
      return explicitLabel;
    }

    if (this.isNetworkIssueSummary(normalized)) {
      return 'network_issue';
    }

    if (media?.kind === 'meeting') {
      if (
        /\b(meeting ended|call ended|meeting has ended|left the meeting|session is no longer active|ended for everyone|meeting finished)\b/i.test(
          normalized,
        )
      ) {
        return 'meeting_ended';
      }
      if (
        /\b(waiting room|waiting for host|ask to join|request to join|waiting for others|no one else has joined|waiting for someone)\b/i.test(
          normalized,
        )
      ) {
        return 'meeting_waiting';
      }
      if (
        /\b(still joined|meeting is active|joined the meeting|attendance is active|participants are visible|no one is speaking|everyone is quiet|quiet but still joined)\b/i.test(
          normalized,
        )
      ) {
        return /\b(no one is speaking|everyone is quiet|quiet but still joined)\b/i.test(
          normalized,
        )
          ? 'meeting_quiet'
          : 'meeting_active';
      }
      return 'unknown';
    }

    if (this.isAdHandlingSummary(normalized)) {
      return 'ad_visible';
    }

    if (this.isPausedMediaPlaybackSummary(normalized)) {
      return 'requested_media_paused';
    }

    if (this.isRequestedMediaMismatchSummary(normalized)) {
      return 'requested_media_mismatch';
    }

    if (
      /\b(autoplay|up next|next video|next song|another song|another video|playlist)\b/i.test(
        normalized,
      ) &&
      /\b(started|playing|continued|moved on)\b/i.test(normalized)
    ) {
      return 'follow_on_media';
    }

    if (
      /\b(has ended|has finished|is over|video ended|playback ended|finished playing|not playing anymore|stopped playing|playback is complete|the song is over|the media has stopped|video has finished|song has finished|the requested media ended|replay button is visible|playback reached the end|started over from the beginning|looped back to the beginning|replaying from the start|short has looped|reel has looped|played once and restarted)\b/i.test(
        normalized,
      )
    ) {
      return 'requested_media_ended';
    }

    if (this.isActiveMediaPlaybackSummary(normalized)) {
      return 'requested_media_active';
    }

    return 'unknown';
  }

  private mediaReviewIndicatesEnded(
    summary: string,
    media?: NonNullable<TaskSecurityState['media']>,
  ): boolean {
    if (this.hasLatchedMediaCompletion(media, summary)) {
      return true;
    }

    const normalized = summary.toLowerCase();
    const reviewState = this.classifyMediaReviewState(summary, media);
    const elapsedSinceVerifiedMs = media?.playbackVerifiedAt
      ? Date.now() - new Date(media.playbackVerifiedAt).getTime()
      : null;
    if (!normalized.trim()) {
      return false;
    }

    if (
      reviewState === 'requested_media_ended' ||
      reviewState === 'meeting_ended'
    ) {
      return true;
    }

    if (media?.kind === 'meeting') {
      return false;
    }

    if (media?.continueWithRelatedMedia === true) {
      return false;
    }

    if (reviewState === 'follow_on_media') {
      return true;
    }

    return false;
  }

  private isRecoverableMediaState(summary: string): boolean {
    const normalized = summary.toLowerCase();
    if (!normalized.trim()) {
      return false;
    }

    const reviewState = this.classifyMediaReviewState(summary);
    if (
      reviewState === 'ad_visible' ||
      reviewState === 'requested_media_paused' ||
      reviewState === 'requested_media_mismatch' ||
      reviewState === 'requested_media_active' ||
      reviewState === 'meeting_active' ||
      reviewState === 'meeting_quiet' ||
      reviewState === 'meeting_waiting' ||
      reviewState === 'follow_on_media' ||
      reviewState === 'network_issue'
    ) {
      return true;
    }

    return (
      /\b(continue monitoring|still active|still playing|wait through it|pause the follow-on playback|stop the follow-on playback)\b/i.test(
        normalized,
      ) || this.isTranscriptUnavailableSummary(normalized)
    );
  }

  private isTranscriptUnavailableSummary(summary: string): boolean {
    const normalized = summary.toLowerCase();
    if (!normalized.trim()) {
      return false;
    }

    return (
      /(?:transcript|captions?)(?:.|\n){0,80}(?:not visible|not available|not present|not shown|unavailable|missing)/i.test(
        normalized,
      ) ||
      /(?:not visible|not available|not present|not shown|unavailable|missing)(?:.|\n){0,80}(?:transcript|captions?)/i.test(
        normalized,
      ) ||
      /(?:unable|could not|couldn't|cannot|can't)(?:.|\n){0,80}(?:locate|find|open)(?:.|\n){0,80}(?:transcript|captions?)/i.test(
        normalized,
      ) ||
      /transcript or captions controls(?:.|\n){0,80}(?:not visible|not available|not present)/i.test(
        normalized,
      )
    );
  }

  private isActiveMediaPlaybackSummary(summary: string): boolean {
    const normalized = summary.toLowerCase();
    if (!normalized.trim()) {
      return false;
    }

    const state = this.extractMediaStateLabel(normalized);
    if (
      state === 'requested_media_active' ||
      state === 'meeting_active' ||
      state === 'meeting_quiet' ||
      state === 'meeting_waiting'
    ) {
      return true;
    }

    if (state === 'requested_media_mismatch' || this.isRequestedMediaMismatchSummary(normalized)) {
      return false;
    }

    return (
      /\b(playing|playback is active|meeting is active|joined the meeting|attendance is active|audio is playing|video is playing)\b/i.test(
        normalized,
      ) &&
      !/\b(paused|pause|not playing|stopped|ended|finished|replay button|reconnecting|network error|connection lost)\b/i.test(
        normalized,
      )
    );
  }

  private isPausedMediaPlaybackSummary(summary: string): boolean {
    const normalized = summary.toLowerCase();
    if (!normalized.trim()) {
      return false;
    }

    const state = this.extractMediaStateLabel(normalized);
    if (state === 'requested_media_paused') {
      return true;
    }

    return /\b(paused|not playing|stopped|resume playback|paused at)\b/i.test(
      normalized,
    );
  }

  private isRequestedMediaMismatchSummary(summary: string): boolean {
    const normalized = summary.toLowerCase();
    if (!normalized.trim()) {
      return false;
    }

    const state = this.extractMediaStateLabel(normalized);
    if (state === 'requested_media_mismatch') {
      return true;
    }

    return /\b(does not match the requested (song|media|video|track|meeting|item)|wrong (song|video|media|track|item)|different (song|video|media|track|item) than requested|title does not match|artist does not match|channel does not match|unrelated (song|video|media|item)|not the requested (song|video|media|meeting|item)|currently on a different (song|video|media|item)|mismatch|does not meet the requirement|does not satisfy the requested duration|exceeds the requested duration|longer than the requested|longer than requested|over the requested duration)\b/i.test(
      normalized,
    );
  }

  private detectMediaWatchdogSignal(
    task: Task,
    combinedSummary: string,
    currentUrl?: string,
  ): ExecutionWatchdogReason | null {
    if (!this.isMediaTask(task.description)) {
      return null;
    }

    const route = this.getMediaRoute(task);
    const platform = this.getMediaPlatform(task);
    if (
      route !== 'unsupported_media' &&
      currentUrl &&
      !this.isSupportedMediaUrlForRoute(route, currentUrl, platform)
    ) {
      return 'wrong_surface';
    }

    if (this.isHumanOnlyAttentionNeeded(`${combinedSummary}\n${currentUrl || ''}`)) {
      return 'human_challenge';
    }

    if (this.isRequestedMediaMismatchSummary(combinedSummary)) {
      return 'media_mismatch';
    }

    return null;
  }

  private isAdHandlingSummary(summary: string): boolean {
    const normalized = summary.toLowerCase();
    if (!normalized.trim()) {
      return false;
    }

    const state = this.extractMediaStateLabel(normalized);
    if (state === 'ad_visible') {
      return true;
    }

    return /\b(ad is visible|skip ad|ad has disappeared|ad ended|waiting for the ad|unskippable ad)\b/i.test(
      normalized,
    );
  }

  private isNetworkIssueSummary(summary: string): boolean {
    const normalized = summary.toLowerCase();
    if (!normalized.trim()) {
      return false;
    }

    const state = this.extractMediaStateLabel(normalized);
    if (state === 'network_issue') {
      return true;
    }

    return /\b(reconnecting|trying to reconnect|connection lost|network error|internet issue|unable to connect|connection problem|offline|rejoin|could not join|failed to join)\b/i.test(
      normalized,
    );
  }

  private getMediaContinuationExecutionMode(
    media: NonNullable<TaskSecurityState['media']> | undefined,
    summaryText = '',
    options?: { terminalCheck?: boolean },
  ): ExecutionMode {
    if (!media) {
      return 'fast';
    }

    const reviewState = this.classifyMediaReviewState(summaryText, media);
    if (
      media.phase === 'network_recovery' ||
      reviewState === 'network_issue' ||
      reviewState === 'requested_media_mismatch'
    ) {
      return 'guarded';
    }

    if (
      media.phase === 'opening' ||
      media.phase === 'playback_verification' ||
      media.phase === 'ad_handling'
    ) {
      return 'fast';
    }

    if (options?.terminalCheck) {
      return 'fast';
    }

    return 'fast';
  }

  private detectExecutionWatchdogSignal(
    taskOrStatus: Task | 'in_progress' | 'completed' | 'drifted' | 'failed',
    statusOrSummary:
      | 'in_progress'
      | 'completed'
      | 'drifted'
      | 'failed'
      | string,
    summaryOrCheckpoints:
      | string
      | ExecutionCheckpoint[],
    checkpointsOrCurrentUrl?:
      | ExecutionCheckpoint[]
      | string,
    currentUrl?: string,
  ):
    | ExecutionWatchdogReason
    | null {
    const status =
      typeof taskOrStatus === 'string'
        ? taskOrStatus
        : (statusOrSummary as
            | 'in_progress'
            | 'completed'
            | 'drifted'
            | 'failed');
    const summaryText =
      typeof taskOrStatus === 'string'
        ? (statusOrSummary as string)
        : (summaryOrCheckpoints as string);
    const checkpoints =
      typeof taskOrStatus === 'string'
        ? Array.isArray(summaryOrCheckpoints)
          ? summaryOrCheckpoints
          : undefined
        : Array.isArray(checkpointsOrCurrentUrl)
          ? checkpointsOrCurrentUrl
          : undefined;
    const effectiveCurrentUrl =
      typeof taskOrStatus === 'string'
        ? typeof checkpointsOrCurrentUrl === 'string'
          ? checkpointsOrCurrentUrl
          : currentUrl
        : currentUrl;
    const task =
      typeof taskOrStatus === 'string'
        ? ({ description: '' } as Task)
        : taskOrStatus;

    if (status === 'drifted') {
      return 'drifted';
    }

    const combined = [
      summaryText,
      ...(checkpoints || []).flatMap((checkpoint) => [
        checkpoint.visibleSummary || '',
        ...Object.values(checkpoint.extractedFacts || {}),
      ]),
    ]
      .join(' ')
      .toLowerCase();
    const latestCheckpoint = [...(checkpoints || [])]
      .reverse()
      .find((checkpoint) => checkpoint.visibleSummary || checkpoint.status);

    if (this.isInfrastructureExecutionFailure(combined)) {
      return null;
    }

    const structuredBlocker = latestCheckpoint?.blockerType;
    if (structuredBlocker === 'captcha') {
      return 'human_challenge';
    }
    if (
      structuredBlocker === 'login_required' ||
      structuredBlocker === 'consent' ||
      structuredBlocker === 'interstitial' ||
      structuredBlocker === 'modal' ||
      structuredBlocker === 'network' ||
      structuredBlocker === 'permission'
    ) {
      return 'stuck';
    }

    if (
      latestCheckpoint?.status === 'in_progress' &&
      latestCheckpoint.targetVisible === false &&
      latestCheckpoint.nextActionNeeded === true
    ) {
      return null;
    }

    const mediaSpecificSignal = this.detectMediaWatchdogSignal(
      task,
      combined,
      effectiveCurrentUrl,
    );
    if (mediaSpecificSignal) {
      return mediaSpecificSignal;
    }

    if (
      /\b(loop|looping|repeating the same action|same action|repeated clicks|repeated typing)\b/i.test(
        combined,
      )
    ) {
      return 'looping';
    }

    if (
      /\b(wrong field|wrong place|wrong box|wrong input|mismatch|contradict|swapped|mixed up|incorrect field|incorrect value)\b/i.test(
        combined,
      )
    ) {
      return 'field_mismatch';
    }

    if (
      /\b(stale state|wrong page|old search|old inbox|old results|unrelated page|different task|expired session|session expired|not relevant to the current task)\b/i.test(
        combined,
      )
    ) {
      return 'drifted';
    }

    if (
      /\b(stuck|blocked|unable to continue|cannot continue|can\'t continue)\b/i.test(
        combined,
      )
    ) {
      return 'stuck';
    }

    return null;
  }

  private buildExecutionLoopSignature(
    stepDescription: string,
    currentUrl: string | undefined,
    summaryText: string,
  ): string {
    return [
      stepDescription.replace(/\s+/g, ' ').trim().toLowerCase(),
      (currentUrl || '').trim().toLowerCase(),
      (summaryText || '').replace(/\s+/g, ' ').trim().toLowerCase(),
    ].join(' || ');
  }

  private extractLatestVisibleSummary(
    checkpoints?: ExecutionCheckpoint[],
  ): string | undefined {
    const visibleSummary = [...(checkpoints || [])]
      .reverse()
      .find((checkpoint) => checkpoint.visibleSummary?.trim())
      ?.visibleSummary?.trim();

    return visibleSummary || undefined;
  }

  private shouldResolveBlockedRecovery(
    blockedStep:
      | NonNullable<TaskSecurityState['execution']>['blockedStep']
      | undefined,
    desktopStep: {
      description: string;
      executionMode?: ExecutionMode;
      source?: 'initial' | 'replan';
    },
    summary: {
      status: 'in_progress' | 'completed' | 'drifted' | 'failed';
      checkpoints?: ExecutionCheckpoint[];
    },
    execution: NonNullable<TaskSecurityState['execution']>,
  ): boolean {
    if (!blockedStep) {
      return false;
    }

    if (blockedStep.description === desktopStep.description) {
      return true;
    }

    const latestCheckpoint = [...(summary.checkpoints || [])].reverse()[0];
    const recoveryExecution =
      desktopStep.source === 'replan' ||
      execution.activeExecution?.source === 'replan' ||
      execution.watchdog?.activeRecovery === true;

    if (!recoveryExecution) {
      return false;
    }

    if (summary.status === 'completed') {
      return true;
    }

    if (
      latestCheckpoint?.targetVisible === true &&
      latestCheckpoint?.nextActionNeeded === false
    ) {
      return true;
    }

    if (
      latestCheckpoint?.blockerType &&
      latestCheckpoint.blockerType !== 'none' &&
      latestCheckpoint.blockerType !== 'unknown'
    ) {
      return false;
    }

    return false;
  }

  private async updateExecutionState(
    task: Task,
    desktopStep: {
      description: string;
      executionMode?: ExecutionMode;
      source?: 'initial' | 'replan';
    },
    summary: {
      status: 'in_progress' | 'completed' | 'drifted' | 'failed';
      summary: string;
      outcome?: {
        kind:
          | 'step_completed'
          | 'step_in_progress'
          | 'step_drifted'
          | 'step_failed'
          | 'needs_confirmation'
          | 'needs_human_attention';
        failureKind?: 'provider_capacity' | 'infrastructure' | 'repeated_action' | 'generic';
      };
      currentUrl?: string;
      checkpoints?: ExecutionCheckpoint[];
    },
  ): Promise<{
    result: Record<string, unknown>;
  }> {
    const executionMode = desktopStep.executionMode || 'fast';
    const security = this.getTaskSecurityState(task);
    const execution = security.execution || {};
    const media = security.media;
    const stepRetries = { ...(execution.stepRetries || {}) };
    const completedSteps = [...(execution.completedSteps || [])];
    const skippedSteps = [...(execution.skippedSteps || [])];
    const recoveryHistory = [...(execution.recoveryHistory || [])];
    const stepKey = desktopStep.description.trim().toLowerCase();
    let resultReview = execution.resultReview;
    let updatedMedia = media;
    let blockedStep = execution.blockedStep;
    let watchdog = execution.watchdog;
    let relevantContextUsed = execution.relevantContextUsed || false;
    const mediaReachedTerminalEnd =
      !!media?.selectedAt && this.hasLatchedMediaCompletion(media, summary.summary);
    const mediaReviewState =
      !!media?.selectedAt && !mediaReachedTerminalEnd
        ? this.classifyMediaReviewState(summary.summary, media)
        : null;
    const usedExistingContext = this.summaryIndicatesUsefulExistingContext(
      task,
      summary.summary,
    );
    const latestVisibleSummary =
      this.extractLatestVisibleSummary(summary.checkpoints) || summary.summary;
    const loopSignature = this.buildExecutionLoopSignature(
      desktopStep.description,
      summary.currentUrl,
      latestVisibleSummary,
    );
    const repeatedLoopSignatureCount =
      execution.lastLoopSignature === loopSignature
        ? (execution.repeatedLoopSignatureCount || 0) + 1
        : 1;
    const derivedLoopSignal =
      repeatedLoopSignatureCount >= 2 &&
      (
        this.isSetupOnlyVisibleStateSummary(task, latestVisibleSummary) ||
        this.isRawActionOnlySummary(latestVisibleSummary)
      )
        ? 'looping'
        : null;
    const watchdogSignal = derivedLoopSignal || this.detectExecutionWatchdogSignal(
      task,
      summary.status,
      summary.summary,
      summary.checkpoints,
      summary.currentUrl,
    );
    const hardMediaRecoverySignal =
      !!media?.selectedAt &&
      !mediaReachedTerminalEnd &&
      (watchdogSignal === 'wrong_surface' || watchdogSignal === 'media_mismatch')
        ? watchdogSignal
        : null;

    const recoverableMediaState =
      !!media?.selectedAt &&
      !hardMediaRecoverySignal &&
      (this.isRecoverableMediaState(summary.summary) || mediaReachedTerminalEnd);
    const failureKind =
      summary.outcome?.kind === 'step_failed'
        ? summary.outcome.failureKind
        : undefined;
    const resolvesBlockedRecovery = this.shouldResolveBlockedRecovery(
      blockedStep,
      desktopStep,
      summary,
      execution,
    );

    if (hardMediaRecoverySignal) {
      stepRetries[stepKey] = (stepRetries[stepKey] || 0) + 1;
      blockedStep = {
        description: desktopStep.description,
        reason: summary.summary,
        retries: stepRetries[stepKey],
        lastSeenAt: new Date().toISOString(),
        recoveryStrategy: this.determineRecoveryStrategy(task, hardMediaRecoverySignal),
        currentUrl: summary.currentUrl || undefined,
        lastVisibleSummary: this.extractLatestVisibleSummary(summary.checkpoints),
        watchdogReason: hardMediaRecoverySignal,
      };
      recoveryHistory.push({
        description: desktopStep.description,
        outcome: this.mapWatchdogSignalToRecoveryOutcome(hardMediaRecoverySignal),
        recordedAt: new Date().toISOString(),
      });
    } else if (summary.status === 'drifted' && !recoverableMediaState) {
      stepRetries[stepKey] = (stepRetries[stepKey] || 0) + 1;
      blockedStep = {
        description: desktopStep.description,
        reason: summary.summary,
        retries: stepRetries[stepKey],
        lastSeenAt: new Date().toISOString(),
        recoveryStrategy: this.determineRecoveryStrategy(task, 'drifted'),
        currentUrl: summary.currentUrl || undefined,
        lastVisibleSummary: this.extractLatestVisibleSummary(summary.checkpoints),
        watchdogReason: 'drifted',
      };
      recoveryHistory.push({
        description: desktopStep.description,
        outcome: 'drifted',
        recordedAt: new Date().toISOString(),
      });
    } else if (
      summary.status === 'completed' ||
      recoverableMediaState
    ) {
      delete stepRetries[stepKey];
      if (resolvesBlockedRecovery) {
        recoveryHistory.push({
          description: blockedStep?.description || desktopStep.description,
          outcome: 'resolved',
          recordedAt: new Date().toISOString(),
        });
        blockedStep = undefined;
      }
    } else if (summary.status === 'failed') {
      if (
        failureKind === 'provider_capacity' ||
        failureKind === 'infrastructure'
      ) {
        delete stepRetries[stepKey];
        if (blockedStep?.description === desktopStep.description) {
          blockedStep = undefined;
        }
      } else {
        stepRetries[stepKey] = (stepRetries[stepKey] || 0) + 1;
        blockedStep = {
          description: desktopStep.description,
          reason: summary.summary,
          retries: stepRetries[stepKey],
          lastSeenAt: new Date().toISOString(),
          recoveryStrategy: this.determineRecoveryStrategy(task, watchdogSignal),
          currentUrl: summary.currentUrl || undefined,
          lastVisibleSummary: this.extractLatestVisibleSummary(summary.checkpoints),
          watchdogReason: watchdogSignal || 'stuck',
        };
        recoveryHistory.push({
          description: desktopStep.description,
          outcome: this.mapWatchdogSignalToRecoveryOutcome(watchdogSignal),
          recordedAt: new Date().toISOString(),
        });
      }
    }

    if (
      summary.status === 'in_progress' &&
      watchdogSignal &&
      !recoverableMediaState &&
      !mediaReachedTerminalEnd &&
      !resolvesBlockedRecovery
    ) {
      stepRetries[stepKey] = (stepRetries[stepKey] || 0) + 1;
      blockedStep = {
        description: desktopStep.description,
        reason: summary.summary,
        retries: stepRetries[stepKey],
        lastSeenAt: new Date().toISOString(),
        recoveryStrategy: this.determineRecoveryStrategy(task, watchdogSignal),
        currentUrl: summary.currentUrl || undefined,
        lastVisibleSummary: this.extractLatestVisibleSummary(summary.checkpoints),
        watchdogReason: watchdogSignal,
      };
      recoveryHistory.push({
        description: desktopStep.description,
        outcome: this.mapWatchdogSignalToRecoveryOutcome(watchdogSignal),
        recordedAt: new Date().toISOString(),
      });
    }

    if ((summary.status === 'completed' || mediaReachedTerminalEnd) && !hardMediaRecoverySignal) {
      if (mediaReachedTerminalEnd) {
        blockedStep = undefined;
      }
      if (usedExistingContext) {
        if (!skippedSteps.includes(desktopStep.description)) {
          skippedSteps.push(desktopStep.description);
        }
        relevantContextUsed = true;
      } else if (!completedSteps.includes(desktopStep.description)) {
        completedSteps.push(desktopStep.description);
      }
    }

    watchdog =
      blockedStep &&
      !recoverableMediaState &&
      !mediaReachedTerminalEnd
        ? {
            lastObservedAt: new Date().toISOString(),
            lastObservedStatus: 'recovering',
            lastTriggerAt: new Date().toISOString(),
            lastTriggerReason:
              blockedStep.watchdogReason ||
              (summary.status === 'drifted' ? 'drifted' : watchdogSignal || 'stuck'),
            activeRecovery: true,
            currentUrl:
              blockedStep.currentUrl ||
              summary.currentUrl ||
              watchdog?.currentUrl,
            lastVisibleSummary:
              blockedStep.lastVisibleSummary ||
              this.extractLatestVisibleSummary(summary.checkpoints) ||
              summary.summary,
          }
        : {
            lastObservedAt: new Date().toISOString(),
            lastObservedStatus: 'healthy',
            lastTriggerAt: watchdog?.lastTriggerAt,
            lastTriggerReason: watchdog?.lastTriggerReason,
            activeRecovery: false,
            currentUrl:
              summary.currentUrl ||
              watchdog?.currentUrl,
            lastVisibleSummary:
              this.extractLatestVisibleSummary(summary.checkpoints) ||
              summary.summary,
          };

    if (resultReview?.pending) {
      if (
        this.isFinalResultReviewDescription(desktopStep.description) &&
        summary.status === 'completed'
      ) {
        resultReview = {
          ...resultReview,
          completedAt: new Date().toISOString(),
          lastDescription: desktopStep.description,
          lastSummary: summary.summary,
        };
      } else if (!this.isFinalResultReviewDescription(desktopStep.description)) {
        resultReview = {
          ...resultReview,
          completedAt: undefined,
          lastDescription: undefined,
          lastSummary: undefined,
          followUpCount: resultReview.followUpCount,
        };
      }
    }

    if (media?.selectedAt) {
      const normalizedDescription = desktopStep.description.toLowerCase();
      const normalizedSummary = summary.summary.toLowerCase();
      const reviewState =
        mediaReviewState || this.classifyMediaReviewState(summary.summary, media);
      const requestedAdHandling =
        /(skip ad|ad to finish|wait for the ad)/i.test(normalizedDescription);
      const adStillVisible = this.isAdHandlingSummary(normalizedSummary);
      const playbackConfirmationStep =
        media.kind === 'meeting'
          ? /(\bconfirm\b.*\bmeeting\b|\bverify\b.*\bmeeting\b|\bmeeting\b.*\bactive\b|\bjoined\b.*\bmeeting\b|\battendance\b.*\bactive\b|\bjoin\b|\battend\b|\bstay in\b|\bmonitor\b|\bcontinue monitoring\b)/i.test(
              normalizedDescription,
            )
          : /(\bconfirm\b.*\bplayback\b|\bverify\b.*\bplayback\b|\bactively playing\b|\bis playing\b|\bplayback\b|\bplay\b|\bresume\b|\bunpause\b|\blisten\b|\bwatch\b|\bkeep it playing\b|\bkeep it running\b|\bcontinue monitoring\b|\bmonitor\b)/i.test(
              normalizedDescription,
            );
      const indicatesPausedPlayback =
        this.isPausedMediaPlaybackSummary(normalizedSummary);
      const phaseAllowsPlaybackVerification =
        media.phase === 'playback_verification' ||
        media.phase === 'ad_handling' ||
        media.phase === 'network_recovery';
      const activePlaybackSignal =
        this.isActiveMediaPlaybackSummary(normalizedSummary) &&
        !indicatesPausedPlayback &&
        !adStillVisible &&
        !this.mediaReviewIndicatesEnded(normalizedSummary, media) &&
        reviewState !== 'network_issue';
      const indicatesActivePlayback =
        summary.status === 'completed' &&
        activePlaybackSignal &&
        (playbackConfirmationStep || phaseAllowsPlaybackVerification);
      const shouldMarkPlaybackVerified =
        indicatesActivePlayback && !media.playbackVerifiedAt;
      const transcriptStep = /(show transcript|transcript|captions|subtitles)/i.test(
        normalizedDescription,
      );
      const monitoringStep = /(\bplay\b|\bresume\b|\bunpause\b|\bwatch\b|\blisten\b|\bjoin\b|\battend\b|\bmonitor\b|\bcontinue monitoring\b)/i.test(
        normalizedDescription,
      );
      const primingStep =
        media.kind === 'meeting'
          ? this.isMediaOpeningLikeStep(task.description, normalizedDescription)
          : this.isMediaOpeningLikeStep(task.description, normalizedDescription) ||
            /(click .*video result|click .*song result|open .*watch\?v=|return to the requested media|select .*result)/i.test(
              normalizedDescription,
            );
      const openingStep = this.isMediaOpeningLikeStep(
        task.description,
        normalizedDescription,
      );
      const transcriptUnavailable =
        this.isTranscriptUnavailableSummary(normalizedSummary);
      if (
        reviewState === 'follow_on_media' &&
        media.kind !== 'meeting' &&
        media.continueWithRelatedMedia !== true
      ) {
        await this.pauseDesktopPlaybackIfPossible();
      }
      const transcriptAttemptCount =
        transcriptStep && !transcriptUnavailable
          ? (media.transcriptAttemptCount || 0) + 1
          : media.transcriptAttemptCount || 0;
      const exhaustedTranscriptAttempts =
        transcriptStep && transcriptAttemptCount >= 2;
      const nowIso = new Date().toISOString();
      const mediaObservation = this.extractMediaObservation(
        summary.summary,
        summary.checkpoints,
      );
      const strongVisualPlaybackEvidence = this.hasStrongPlaybackEvidence(
        media,
        reviewState,
        summary.summary,
        mediaObservation,
      );
      const shouldLatchCompletion = this.shouldLatchMediaCompletion(
        media,
        reviewState,
        summary.summary,
        mediaObservation,
      );
      const nextMonitorState = {
        ...(media.audioMonitoring || {}),
        lastClassification: shouldLatchCompletion
          ? media.kind === 'meeting'
            ? 'meeting_ended'
            : reviewState === 'follow_on_media' &&
                this.shouldStopAfterRequestedMedia(media)
              ? 'follow_on_media'
              : 'requested_media_ended'
          : reviewState,
        lastClassificationAt: nowIso,
        lastVisualCheckAt: nowIso,
        visualChecksTriggered:
          (media.audioMonitoring?.visualChecksTriggered || 0) + 1,
        noProgressVisualChecks:
          reviewState === 'meeting_quiet' ||
          reviewState === 'meeting_waiting' ||
          reviewState === 'requested_media_active'
            ? 0
            : reviewState === 'unknown'
              ? (media.audioMonitoring?.noProgressVisualChecks || 0) + 1
              : media.audioMonitoring?.noProgressVisualChecks || 0,
      };

      const nextPhase = shouldLatchCompletion
        ? 'ended'
        : reviewState === 'follow_on_media'
          ? this.shouldStopAfterRequestedMedia(media)
            ? 'ended'
            : 'follow_on_detected'
          : reviewState === 'network_issue'
            ? 'network_recovery'
            : reviewState === 'requested_media_mismatch'
              ? 'playback_verification'
            : reviewState === 'meeting_quiet' || reviewState === 'meeting_waiting'
              ? 'quiet_monitoring'
              : adStillVisible
          ? 'ad_handling'
          : indicatesPausedPlayback
            ? 'playback_verification'
            : indicatesActivePlayback
              ? 'monitoring'
              : transcriptStep &&
                  !transcriptUnavailable &&
                  !exhaustedTranscriptAttempts
                ? 'transcript_capture'
                : monitoringStep
                  ? media.playbackVerifiedAt || indicatesActivePlayback
                    ? 'monitoring'
                    : 'playback_verification'
                  : primingStep && summary.status === 'completed'
                    ? 'playback_verification'
                  : openingStep
                    ? 'opening'
                    : media.phase;

      updatedMedia = {
        ...media,
        phase: nextPhase,
        lastSummary: summary.summary,
        continuationCount: media.continuationCount || 0,
        transcriptAttemptCount,
        observedAt:
          mediaObservation.positionMs !== undefined ||
          mediaObservation.durationMs !== undefined ||
          mediaObservation.title ||
          mediaObservation.channel ||
          mediaObservation.playerState
            ? nowIso
            : media.observedAt,
        observedPositionMs:
          mediaObservation.positionMs !== undefined
            ? mediaObservation.positionMs
            : media.observedPositionMs,
        observedDurationMs:
          mediaObservation.durationMs !== undefined
            ? mediaObservation.durationMs
            : media.observedDurationMs,
        observedTitle: mediaObservation.title || media.observedTitle,
        observedChannel: mediaObservation.channel || media.observedChannel,
        observedUrl: media.observedUrl,
        observedPlayerName: media.observedPlayerName,
        observedPlayerState:
          mediaObservation.playerState || media.observedPlayerState,
        maxObservedPositionMs:
          mediaObservation.positionMs !== undefined
            ? Math.max(
                media.maxObservedPositionMs || 0,
                mediaObservation.positionMs,
              )
            : media.maxObservedPositionMs,
        playbackPrimedAt:
          (
            (primingStep && summary.status === 'completed') ||
            strongVisualPlaybackEvidence
          ) &&
          !adStillVisible &&
          !shouldLatchCompletion
            ? media.playbackPrimedAt || nowIso
            : media.playbackPrimedAt,
        playbackVerifiedAt:
          shouldMarkPlaybackVerified
            ? nowIso
            : media.playbackVerifiedAt,
        completionLatchedAt:
          shouldLatchCompletion
            ? media.completionLatchedAt || nowIso
            : media.completionLatchedAt,
        endedAt:
          shouldLatchCompletion && media.kind !== 'meeting'
            ? media.endedAt || nowIso
            : media.endedAt,
        transcriptUnavailableAt:
          transcriptUnavailable || exhaustedTranscriptAttempts
            ? nowIso
            : media.transcriptUnavailableAt,
        audioMonitoring: nextMonitorState,
      };

      await this.emitMediaProgressUpdate(
        task,
        this.buildMediaStateProgressUpdate(
          task,
          media,
          updatedMedia,
          watchdogSignal,
        ),
      );

      if (
        requestedAdHandling &&
        summary.status === 'completed' &&
        !adStillVisible &&
        !indicatesPausedPlayback &&
        !shouldLatchCompletion
      ) {
        updatedMedia = {
          ...updatedMedia,
          phase: shouldMarkPlaybackVerified ? 'monitoring' : 'playback_verification',
          playbackPrimedAt:
            updatedMedia.playbackPrimedAt || nowIso,
        };
      }

      if (updatedMedia.selectedAt) {
        let latestAudioStatus: DesktopAudioStatus | null = null;
        let latestNativeMediaState: DesktopMediaSessionState | null = null;
        if (
          !updatedMedia.recordingStartedAt &&
          !updatedMedia.recordingStoppedAt &&
          (updatedMedia.transcriptRequested || updatedMedia.summaryRequested)
        ) {
          latestAudioStatus = await this.fetchDesktopAudioStatus();
          if (latestAudioStatus?.hasSignal) {
            updatedMedia = {
              ...updatedMedia,
              audioMonitoring: {
                ...(updatedMedia.audioMonitoring || {}),
                mode: 'audio_first',
                lastPolledAt: latestAudioStatus.sampledAt || nowIso,
                lastAudibleAt: latestAudioStatus.sampledAt || nowIso,
                lastPeakDb: latestAudioStatus.peakDb ?? null,
                lastRmsDb: latestAudioStatus.rmsDb ?? null,
                lastZeroCrossingRate:
                  latestAudioStatus.zeroCrossingRate ?? null,
                lastSignature: latestAudioStatus.signature || null,
              },
            };
          }
          if (!latestAudioStatus?.hasSignal && updatedMedia.kind !== 'meeting') {
            latestNativeMediaState = await this.fetchDesktopMediaSessionState();
            const nativeObservation = this.buildMediaObservationFromNativeSession(
              updatedMedia,
              latestNativeMediaState,
            );
            if (
              nativeObservation.positionMs !== undefined ||
              nativeObservation.durationMs !== undefined ||
              nativeObservation.title ||
              nativeObservation.channel ||
              nativeObservation.playerState
            ) {
              updatedMedia = {
                ...updatedMedia,
                observedAt: nativeObservation.observedAt || updatedMedia.observedAt,
                observedPositionMs:
                  nativeObservation.positionMs ?? updatedMedia.observedPositionMs,
                observedDurationMs:
                  nativeObservation.durationMs ?? updatedMedia.observedDurationMs,
                observedTitle:
                  nativeObservation.title || updatedMedia.observedTitle,
                observedChannel:
                  nativeObservation.channel || updatedMedia.observedChannel,
                observedUrl: nativeObservation.url || updatedMedia.observedUrl,
                observedPlayerName:
                  nativeObservation.playerName || updatedMedia.observedPlayerName,
                observedPlayerState:
                  nativeObservation.playerState || updatedMedia.observedPlayerState,
                maxObservedPositionMs:
                  nativeObservation.maxObservedPositionMs ??
                  updatedMedia.maxObservedPositionMs,
                playbackPrimedAt:
                  (
                    updatedMedia.playbackPrimedAt ||
                    this.hasStrongPlaybackEvidence(
                      updatedMedia,
                      reviewState,
                      summary.summary,
                      {
                        positionMs: nativeObservation.positionMs,
                        durationMs: nativeObservation.durationMs,
                        title: nativeObservation.title,
                        channel: nativeObservation.channel,
                        playerState: nativeObservation.playerState,
                      },
                      latestNativeMediaState,
                    )
                  ) &&
                  !this.hasLatchedMediaCompletion(updatedMedia, normalizedSummary)
                    ? updatedMedia.playbackPrimedAt || nowIso
                    : updatedMedia.playbackPrimedAt,
              };
            }
          }
        }
        updatedMedia = await this.mediaSessionService.maybeStartRecording(
          task.id,
          task,
          {
            ...security,
            media: updatedMedia,
          },
          {
            currentAudioHasSignal: !!latestAudioStatus?.hasSignal,
            currentPlaybackLikelyActive: this.hasStrongPlaybackEvidence(
              updatedMedia,
              reviewState,
              summary.summary,
              mediaObservation,
              latestNativeMediaState,
            ),
          },
        );
      }
    }

    const nextSecurity = applySessionActiveBranch(
      {
        ...security,
        media: updatedMedia,
        execution: {
          ...execution,
          syntheticContinuationCount: 0,
          lastSyntheticContinuationAt: undefined,
          lastSyntheticContinuationText: undefined,
          suppressedContinuationPromptCount: 0,
          lastSuppressedContinuationPrompt: undefined,
          lastSuppressedContinuationAt: undefined,
          lastLoopSignature: loopSignature,
          repeatedLoopSignatureCount,
          currentStep:
            ((summary.status === 'completed' && !hardMediaRecoverySignal) ||
              mediaReachedTerminalEnd)
              ? undefined
              : desktopStep.description,
          driftCount:
            summary.status === 'drifted' &&
            !recoverableMediaState &&
            !mediaReachedTerminalEnd
              ? (execution.driftCount || 0) + 1
              : execution.driftCount || 0,
          stepRetries,
          completedSteps,
          skippedSteps,
          blockedStep,
          recoveryHistory,
          watchdog,
          relevantContextUsed,
          lastDriftAt:
            summary.status === 'drifted' &&
            !recoverableMediaState &&
            !mediaReachedTerminalEnd
              ? new Date().toISOString()
              : execution.lastDriftAt,
          lastDriftReason:
            summary.status === 'drifted' &&
            !recoverableMediaState &&
            !mediaReachedTerminalEnd
              ? summary.summary
              : execution.lastDriftReason,
          resultReview,
        },
      },
      blockedStep
        ? 'blocked_recovery'
        : security.pendingConfirmation
          ? 'awaiting_confirmation'
          : 'executing',
      {
        phase: blockedStep ? security.session?.phase || 'active' : 'active',
        awaitingUserDecision: false,
      },
    );

    const updatedResult = this.mergeTaskResult(task, {
      security: nextSecurity,
    });

    await this.tasksService.update(task.id, {
      result: updatedResult,
    });

    return { result: updatedResult };
  }

  private parsePreflightResponse(raw: string): {
    decision: 'ask_user' | 'proceed';
    reason: 'confirmation' | 'clarification';
    question: string;
    plan: string;
    planSteps: string[];
    guidelines: string[];
  } | null {
    if (!raw) {
      return null;
    }

    const normalized = raw
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const candidates: string[] = [normalized];
    const objectStart = normalized.indexOf('{');
    const objectEnd = normalized.lastIndexOf('}');
    if (objectStart !== -1 && objectEnd !== -1 && objectEnd > objectStart) {
      candidates.push(normalized.slice(objectStart, objectEnd + 1));
    }

    for (const candidate of candidates) {
      const parsed = this.tryParsePreflightCandidate(candidate);
      if (parsed) {
        return parsed;
      }
    }

    return this.derivePreflightResponseFromText(normalized);
  }

  private tryParsePreflightCandidate(candidate: string): {
    decision: 'ask_user' | 'proceed';
    reason: 'confirmation' | 'clarification';
    question: string;
    plan: string;
    planSteps: string[];
    guidelines: string[];
  } | null {
    try {
      const parsed = JSON.parse(candidate) as {
        decision?: string;
        reason?: string;
        question?: string;
        plan?: string;
        plan_steps?: unknown;
        guidelines?: unknown;
      };

      if (
        (parsed.decision !== 'ask_user' && parsed.decision !== 'proceed') ||
        (parsed.reason !== 'confirmation' &&
          parsed.reason !== 'clarification')
      ) {
        return null;
      }

      return {
        decision: parsed.decision,
        reason: parsed.reason,
        question: this.normalizePreflightTextField(parsed.question),
        plan: this.normalizePreflightTextField(parsed.plan),
        planSteps: this.normalizePreflightPlanSteps(parsed.plan_steps, parsed.plan),
        guidelines: this.normalizePreflightGuidelines(parsed.guidelines),
      };
    } catch {
      return null;
    }
  }

  private derivePreflightResponseFromText(raw: string): {
    decision: 'ask_user' | 'proceed';
    reason: 'confirmation' | 'clarification';
    question: string;
    plan: string;
    planSteps: string[];
    guidelines: string[];
  } | null {
    const normalized = raw.trim();
    if (!normalized) {
      return null;
    }

    const lower = normalized.toLowerCase();
    const firstLine = normalized
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    const normalizedFirstLine = this.normalizePreflightTextField(firstLine);

    if (normalized.includes('?')) {
      return {
        decision: 'ask_user',
        reason:
          lower.includes('confirm') || lower.includes('approval')
            ? 'confirmation'
            : 'clarification',
        question:
          normalizedFirstLine ||
          this.normalizePreflightTextField(normalized) ||
          normalized,
        plan: 'Start the task after the missing detail is provided.',
        planSteps: [],
        guidelines: this.defaultPlannerGuidelines(),
      };
    }

    if (/^(?:proceed|decision\s*[:=]\s*proceed)\b/i.test(normalized)) {
      return {
        decision: 'proceed',
        reason: 'clarification',
        question: '',
        plan: normalizedFirstLine || 'Begin executing the task.',
        planSteps: this.plannerPlanCompiler.derivePlanStepsFromPlanText(
          normalizedFirstLine || 'Begin executing the task.',
        ),
        guidelines: this.defaultPlannerGuidelines(),
      };
    }

    return null;
  }

  private normalizePreflightTextField(value: unknown): string {
    if (typeof value !== 'string') {
      return '';
    }

    const trimmed = value
      .replace(/\s+/g, ' ')
      .replace(/\b(i can also|i could also)\b.*$/i, '')
      .replace(/\b(or should i.*?)$/i, '')
      .replace(/\b(is there anything else you'd like me to do.*)$/i, '')
      .replace(/\b(what would you like me to do\??)$/i, '')
      .trim();
    if (!trimmed || trimmed === '{' || trimmed === '}' || trimmed === '```') {
      return '';
    }

    const firstQuestion = trimmed.match(/[^?]+\?/);
    if (firstQuestion?.[0]) {
      return firstQuestion[0].trim();
    }

    const firstSentence = trimmed.match(/[^.!]+[.!]?/);
    return firstSentence?.[0]?.trim() || trimmed;
  }

  private isMalformedStartupQuestion(question: string): boolean {
    const normalized = (question || '').trim().toLowerCase();
    if (!normalized) {
      return true;
    }

    return (
      /^(happy to|sure|okay|ok|absolutely|certainly|of course|sounds good|will do|can do|yep|yes)\.?$/.test(
        normalized,
      ) ||
      (normalized.length < 18 && !normalized.includes('?')) ||
      (!normalized.includes('?') &&
        /^(happy to|sure|okay|ok|absolutely|certainly|of course|sounds good|will do|can do)\b/.test(
          normalized,
        ))
    );
  }

  private normalizePreflightPlanSteps(
    value: unknown,
    plan?: string,
  ): string[] {
    const explicitSteps = Array.isArray(value)
      ? value
          .map((step) => this.normalizePreflightTextField(step))
          .filter(Boolean)
      : [];

    if (explicitSteps.length > 0) {
      return explicitSteps;
    }

    return this.plannerPlanCompiler.derivePlanStepsFromPlanText(plan || '');
  }

  private normalizePreflightGuidelines(value: unknown): string[] {
    const explicitGuidelines = Array.isArray(value)
      ? value
          .map((entry) => this.normalizePreflightTextField(entry))
          .filter(Boolean)
      : [];

    if (explicitGuidelines.length > 0) {
      return explicitGuidelines.slice(0, 5);
    }

    return this.defaultPlannerGuidelines();
  }

  private defaultPlannerGuidelines(): string[] {
    return [
      'Reuse useful current state when it already helps the goal.',
      'Do not redo healthy progress or already-satisfied work.',
      'If a step is already done or partially done, continue from there instead of restarting.',
      'Stop immediately once the requested result is visibly ready.',
      'Ask for help only on real blockers or contradictions.',
    ];
  }

  private buildPlannerStepCompletionCondition(
    goal: string,
    step: string,
  ): string {
    const normalizedStep = step.replace(/\s+/g, ' ').trim();
    const explicitStop = normalizedStep.match(/stop when\s+(.+)$/i);
    if (explicitStop?.[1]) {
      return explicitStop[1].replace(/[.]+$/g, '').trim();
    }

    const explicitOnce = normalizedStep.match(/\bonce\s+(.+)$/i);
    if (explicitOnce?.[1]) {
      return explicitOnce[1].replace(/[.]+$/g, '').trim();
    }

    const explicitUntil = normalizedStep.match(/\buntil\s+(.+)$/i);
    if (explicitUntil?.[1]) {
      return explicitUntil[1].replace(/[.]+$/g, '').trim();
    }

    const lowerStep = normalizedStep.toLowerCase();
    const lowerGoal = goal.toLowerCase();

    if (/\b(search|browse|look up|find)\b/.test(lowerStep)) {
      return 'The requested search results or candidate list is visibly on screen and ready for comparison.';
    }

    if (/\b(compare|review|evaluate|inspect|narrow|choose|select|finali[sz]e|pick)\b/.test(lowerStep)) {
      return 'The shortlist or final candidate is visibly identified on screen with the evidence needed for the next step.';
    }

    if (/\b(add to cart|cart|checkout|submit|send|book|purchase|buy)\b/.test(lowerStep)) {
      return 'The requested confirmation or committed state is visibly shown on screen.';
    }

    if (/\b(play|resume|start playback|listen|watch)\b/.test(lowerStep)) {
      return 'The requested media is visibly open and actively playing.';
    }

    if (/\b(monitor|wait|stay|continue monitoring)\b/.test(lowerStep)) {
      return /\b(summary|summari[sz]e|transcript)\b/.test(lowerGoal)
        ? 'The requested media or meeting has clearly ended and the task is ready for final transcript or summary generation.'
        : 'The requested media or meeting state has reached the intended visible checkpoint.';
    }

    if (/\b(transcript|captions|subtitles)\b/.test(lowerStep)) {
      return 'The transcript content or recorded-audio finalization needed for the task is ready.';
    }

    if (/\b(summary|summari[sz]e|summarise)\b/.test(lowerStep)) {
      return 'The information needed for the requested summary is ready and grounded.';
    }

    return `The visible page clearly satisfies the current step for: ${goal}`;
  }

  private normalizeUserFacingSummaryText(summaryText: string): string {
    const normalized = (summaryText || '')
      .replace(/<ctrl\d+>/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!normalized) {
      return '';
    }

    const toolCallMatch = normalized.match(
      /call:set_task_status\s*\{\s*description:\s*(.*?)\s*,\s*status:\s*(completed|needs_help)\s*\}/i,
    );
    if (toolCallMatch?.[1]) {
      return toolCallMatch[1].replace(/^["']|["']$/g, '').trim();
    }

    return normalized;
  }

  private isPlaceholderExecutionSummary(summaryText: string): boolean {
    const normalized = (summaryText || '').replace(/\s+/g, ' ').trim().toLowerCase();
    return (
      !normalized ||
      normalized === 'step checkpoint captured.' ||
      normalized === 'step checkpoint captured'
    );
  }

  private isRawActionOnlySummary(summaryText: string): boolean {
    const trimmed = (summaryText || '').trim();
    return /^(clicked at \(\d+,\s*\d+\)|typed text at \(\d+,\s*\d+\)|entered sensitive text at \(\d+,\s*\d+\)|opened web browser|open application|pressed key|pressed keys|scrolled (up|down)|dragged from \(\d+,\s*\d+\) to \(\d+,\s*\d+\)|paused very briefly for page settle)\.?$/i.test(
      trimmed,
    );
  }

  private isGroundedActionCompletion(task: Task, text: string): boolean {
    const normalizedTask = this.getCurrentTurnGoal(task).toLowerCase();
    const normalizedText = text.toLowerCase().trim();
    if (!normalizedText) {
      return false;
    }

    if (
      /\b(add to cart|cart|buy|purchase|checkout|shopping|amazon|flipkart|book|books)\b/.test(
        normalizedTask,
      ) &&
      /\b(added to cart|cart confirmation|cart subtotal|updated cart state|item (?:is )?visible (?:in|on) the cart|cart (?:is )?updated)\b/.test(
        normalizedText,
      )
    ) {
      return true;
    }

    if (
      /\b(open|show|check)\b.*\b(inbox|mailbox|gmail|proton mail|outlook|mail)\b/.test(
        normalizedTask,
      ) &&
      /\b(inbox (?:is )?(?:open|visible|selected)|mail list (?:is )?visible|email list (?:is )?visible|proton mail inbox|gmail inbox|outlook inbox)\b/.test(
        normalizedText,
      )
    ) {
      return true;
    }

    if (
      /\b(flight|flights|train|trains|hotel|trip|travel|itinerary|route|routes)\b/.test(
        normalizedTask,
      ) &&
      /\b(results (?:are )?(?:visible|ready)|flight results|travel results|itinerary results|options (?:are )?(?:visible|ready))\b/.test(
        normalizedText,
      )
    ) {
      return true;
    }

    return false;
  }

  private deriveStepSatisfiedSummary(
    task: Task,
    desktopStep: {
      description: string;
      completionCondition?: string;
    },
    summary: {
      status: 'in_progress' | 'completed' | 'drifted' | 'failed';
      summary: string;
      checkpoints?: ExecutionCheckpoint[];
    },
  ): string | null {
    if (summary.status !== 'completed') {
      return null;
    }

    const latestCheckpoint = [...(summary.checkpoints || [])]
      .reverse()
      .find((checkpoint) => checkpoint.visibleSummary?.trim());
    const directGroundedAnswer = this.extractGroundedSummaryAnswerCandidate(task, [
      summary.summary,
      this.extractLatestVisibleSummary(summary.checkpoints),
      latestCheckpoint?.visibleSummary,
    ]);
    if (
      latestCheckpoint &&
      latestCheckpoint.targetVisible === true &&
      latestCheckpoint.nextActionNeeded === false &&
      latestCheckpoint.visibleSummary?.trim()
    ) {
      return latestCheckpoint.visibleSummary.trim();
    }
    if (
      latestCheckpoint &&
      latestCheckpoint.targetVisible === false &&
      latestCheckpoint.nextActionNeeded === true
    ) {
      return directGroundedAnswer;
    }

    const visibleSummary = this.extractLatestVisibleSummary(summary.checkpoints);
    const candidates = [visibleSummary, summary.summary].filter(
      (entry): entry is string => !!entry && !!entry.trim(),
    );
    const completionCondition = (desktopStep.completionCondition || '')
      .toLowerCase()
      .trim();
    const hasMeaningfulCompletionCondition =
      !!completionCondition &&
      !/this step's visible target state is satisfied|visually confirm the described step is complete/.test(
        completionCondition,
      );

    for (const candidate of candidates) {
      if (
        this.isPlaceholderExecutionSummary(candidate) ||
        this.isRawActionOnlySummary(candidate) ||
        this.isSetupOnlyVisibleStateSummary(task, candidate)
      ) {
        continue;
      }

      if (this.summaryIndicatesStaleOrContradictoryContext(candidate)) {
        continue;
      }

      if (this.summarySupportsCurrentTurnGoal(task, candidate)) {
        return candidate.trim();
      }

      if (
        hasMeaningfulCompletionCondition &&
        this.textLikelySatisfiesCompletionCondition(
          candidate,
          completionCondition,
        )
      ) {
        return candidate.trim();
      }

      if (this.isGroundedSummaryAnswer(task, candidate)) {
        return candidate.trim();
      }
    }

    return directGroundedAnswer;
  }

  private mapWatchdogSignalToRecoveryOutcome(
    signal: ExecutionWatchdogReason | null,
  ):
    | 'resolved'
    | 'stuck'
    | 'looping'
    | 'drifted'
    | 'wrong_surface'
    | 'media_mismatch'
    | 'human_challenge' {
    if (
      signal === 'looping' ||
      signal === 'drifted' ||
      signal === 'wrong_surface' ||
      signal === 'media_mismatch' ||
      signal === 'human_challenge'
    ) {
      return signal;
    }

    return 'stuck';
  }

  private determineRecoveryStrategy(
    task: Task,
    signal: ExecutionWatchdogReason | null,
  ): 'planner_reentry' | 'media_reentry' {
    const media = this.getTaskSecurityState(task).media;
    const openingLikeMediaPhase =
      media?.phase === 'opening' ||
      media?.phase === 'playback_verification' ||
      media?.phase === 'network_recovery';
    if (
      this.isMediaTask(task.description) &&
      (
        signal === 'wrong_surface' ||
        signal === 'media_mismatch' ||
        ((signal === 'looping' || signal === 'stuck') && openingLikeMediaPhase)
      )
    ) {
      return 'media_reentry';
    }

    return 'planner_reentry';
  }

  private textLikelySatisfiesCompletionCondition(
    text: string,
    completionCondition: string,
  ): boolean {
    const normalizedText = text.toLowerCase();
    const conditionTokens = completionCondition
      .split(/[^a-z0-9]+/i)
      .map((token) => token.trim())
      .filter((token) => token.length >= 4)
      .filter(
        (token) =>
          ![
            'visible',
            'ready',
            'requested',
            'result',
            'results',
            'state',
            'match',
            'current',
            'screen',
            'clearly',
            'page',
          ].includes(token),
      );

    if (conditionTokens.length === 0) {
      return false;
    }

    const overlap = conditionTokens.filter((token) =>
      normalizedText.includes(token),
    ).length;
    return overlap >= Math.min(2, conditionTokens.length);
  }

  private sanitizeAssistantContentBlocks(
    task: Task,
    contentBlocks: MessageContentBlock[],
  ): MessageContentBlock[] {
    return contentBlocks.map((block) => {
      if (block.type !== MessageContentType.Text) {
        return block;
      }

      const sanitizedText = this.sanitizeAssistantText(
        task,
        (block as TextContentBlock).text,
      );

      return {
        ...(block as TextContentBlock),
        text: sanitizedText,
      } as MessageContentBlock;
    });
  }

  private sanitizeAssistantText(task: Task, text: string): string {
    const normalized = this.normalizeUserFacingSummaryText(text.replace(/\r/g, ''));
    if (!normalized) {
      return text;
    }

    const currentGoal = this.getCurrentTurnGoal(task);
    const isBookingTask = /\b(book|booking|buy|purchase|pay|payment|reserve|checkout|order)\b/i.test(
      currentGoal,
    );
    const shouldKeepOnlySummary = /\b(find|search|look up|compare|show|tell me|best|cheapest|flight|hotel|train|summarize|summary)\b/i.test(
      currentGoal,
    ) && !isBookingTask;

    const rawSentences = normalized
      .split(/(?<=[.!?])\s+|\n+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length > 0);

    const filteredSentences: string[] = [];
    const seen = new Set<string>();

    for (const sentence of rawSentences) {
      if (this.isBoilerplateCleanupSentence(sentence)) {
        continue;
      }

      if (
        /\b(i can also|i could also|if you'd like|anything else you'd like me to do|what else would you like me to do|such as composing a new email|searching for a specific message|organizing your folders|check your spam folder)\b/i.test(
          sentence,
        )
      ) {
        continue;
      }

      if (
        shouldKeepOnlySummary &&
        /\b(book|booking|hotel|cab|return flight|pay|payment|purchase)\b/i.test(
          sentence,
        )
      ) {
        continue;
      }

      const canonical = sentence
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[^\w\s₹:.-]/g, '')
        .trim();

      if (!canonical || seen.has(canonical)) {
        continue;
      }

      seen.add(canonical);
      filteredSentences.push(sentence);
    }

    if (filteredSentences.length === 0) {
      return normalized;
    }

    const maxSentences = shouldKeepOnlySummary ? 3 : 8;
    return filteredSentences.slice(0, maxSentences).join(' ');
  }

  private isBoilerplateCleanupSentence(sentence: string): boolean {
    return /^(i will now (close|log off|shut down|restart|hibernate|sleep|lock the screen|switch user|sign out|end the task)|i will wait for your response|i am waiting for your response|i am here to help|let me know if you want me to do anything else|if not i will end the task)/i.test(
      sentence.trim(),
    );
  }
}
