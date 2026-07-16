import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Content, GoogleGenAI, Part } from '@google/genai';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActionMapper, ActionResult } from './action-mapper';
import { COMPUTER_USE_SYSTEM_INSTRUCTION } from './agent.constants';
import { TaskSecretsService } from '../tasks/task-secrets.service';
import { TaskUsageState } from '../tasks/task-security.types';
import { mergeTaskUsage } from '../tasks/task-usage.utils';
import {
  ExecutionCheckpoint,
  ExecutionCheckpointStatus,
  ExecutionMode,
} from '@bytebot/shared';

const BYTEBOT_DESKTOP_BASE_URL = process.env
  .BYTEBOT_DESKTOP_BASE_URL as string;

type AuthSecretField = 'username' | 'password' | 'otp';

export type ExecutorFailureKind =
  | 'provider_capacity'
  | 'infrastructure'
  | 'repeated_action'
  | 'generic';

export type ExecutorStepOutcome =
  | {
      kind: 'step_completed' | 'step_in_progress' | 'step_drifted';
    }
  | {
      kind: 'step_failed';
      failureKind: ExecutorFailureKind;
    }
  | {
      kind: 'needs_confirmation';
      confirmationKind: 'sensitive_action';
    }
  | {
      kind: 'needs_human_attention';
      attentionKind: 'captcha' | 'human_verification';
    };

@Injectable()
export class ComputerUseExecutorService {
  private readonly logger = new Logger(ComputerUseExecutorService.name);
  private readonly google: GoogleGenAI;
  private readonly actionMapper = new ActionMapper();
  private readonly cuModel: string;
  private readonly maxTurns: number;
  private readonly lastKnownUrlByTask = new Map<string, string>();
  private readonly recentScreenshotByTask = new Map<
    string,
    { imageBase64: string; capturedAt: number }
  >();

  constructor(
    private readonly configService: ConfigService,
    private readonly taskSecretsService: TaskSecretsService,
    private readonly prisma: PrismaService,
  ) {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY');
    this.google = new GoogleGenAI({
      apiKey: apiKey || 'dummy-key-for-initialization',
    });
    this.cuModel =
      this.configService.get<string>('COMPUTER_USE_MODEL') ||
      'gemini-2.5-computer-use-preview-10-2025';
    this.maxTurns =
      parseInt(
        this.configService.get<string>('COMPUTER_USE_MAX_TURNS') || '30',
        10,
      ) || 10;
  }

  /**
   * Run one "see and do" sub-loop for a single planner step.
   * Takes screenshots, sends them to the Computer Use model, executes
   * the returned actions, and loops until the model has no more actions
   * or maxTurns is reached.
   *
   * Returns a plain-text summary of the outcome (never images).
   */
  async runStep(
    taskId: string,
    step: DesktopStepInput,
    taskGoal: string,
    signal: AbortSignal,
  ): Promise<ComputerUseStepResult> {
    const normalizedStep = this.normalizeStepInput(step);
    const settings = this.getModeSettings(normalizedStep.executionMode);
    this.logger.log(`CU Executor: starting step - "${normalizedStep.description}"`);

    const history: Content[] = [];
    let actionsExecuted = 0;
    const checkpoints: ExecutionCheckpoint[] = [];
    let currentUrl: string | undefined =
      this.lastKnownUrlByTask.get(taskId) || 'about:blank';
    this.lastKnownUrlByTask.set(taskId, currentUrl);
    let latestScreenshotBase64 = await this.takeScreenshot();
    let lastActionName: string | undefined;
    let lastActionOutput: string | undefined;

    const fullContext = `OVERALL TASK: ${taskGoal}\n\nCURRENT STEP TO PERFORM: ${normalizedStep.description}\n\nEXECUTION MODE: ${normalizedStep.executionMode}\n\nEXPECTED STATE: ${JSON.stringify(normalizedStep.expectedState)}\n\nCOMPLETION CONDITION: ${normalizedStep.completionCondition || 'Visually confirm the described step is complete.'}\n\nDRIFT CONDITION: ${normalizedStep.driftCondition || 'The screen contradicts the requested target values or shows stale state from another flow.'}\n\nLook at the screenshot and perform only the step described above. When this step is visually confirmed as done on screen, stop and respond with a summary of what you see.`;

    if (settings.captureInitialCheckpoint) {
      const initialCheckpoint = await this.captureCheckpoint({
        taskId,
        checkpointIndex: checkpoints.length + 1,
        mode: normalizedStep.executionMode,
        taskGoal,
        step: normalizedStep,
        screenshotBase64: latestScreenshotBase64,
        currentUrl,
      });
      checkpoints.push(initialCheckpoint);
      if (initialCheckpoint.status === 'completed') {
        return this.finalizeStepResult(
          taskId,
          normalizedStep,
          taskGoal,
          initialCheckpoint.visibleSummary,
          'completed',
          latestScreenshotBase64,
          currentUrl,
          checkpoints,
        );
      }
      if (initialCheckpoint.status === 'drifted') {
        return this.finalizeStepResult(
          taskId,
          normalizedStep,
          taskGoal,
          initialCheckpoint.driftReason ||
            initialCheckpoint.visibleSummary ||
            'The current page state does not match the requested target values.',
          'drifted',
          latestScreenshotBase64,
          currentUrl,
          checkpoints,
        );
      }
    }

    history.push({
      role: 'user',
      parts: [
        {
          text: fullContext,
        },
        {
          inlineData: {
            data: latestScreenshotBase64,
            mimeType: 'image/png',
          },
        },
      ],
    });

    for (let turn = 0; turn < settings.turnBudget; turn++) {
      if (signal.aborted) {
        return this.finalizeStepResult(
          taskId,
          normalizedStep,
          taskGoal,
          `Step aborted after ${actionsExecuted} actions.`,
          'failed',
          latestScreenshotBase64,
          currentUrl,
          checkpoints,
        );
      }

      let response;
      try {
        response = await this.google.models.generateContent({
          model: this.cuModel,
          contents: history,
          config: {
            systemInstruction: COMPUTER_USE_SYSTEM_INSTRUCTION,
            tools: [
              { computerUse: { environment: 'ENVIRONMENT_BROWSER' } } as any,
            ],
            abortSignal: signal,
          },
        });
        await this.recordUsage(taskId, this.cuModel, response, 'computer_use');
      } catch (error: any) {
        if (error?.message?.includes('AbortError') || signal.aborted) {
          return this.finalizeStepResult(
            taskId,
            normalizedStep,
            taskGoal,
            `Step aborted after ${actionsExecuted} actions.`,
            'failed',
            latestScreenshotBase64,
            currentUrl,
            checkpoints,
          );
        }
        this.logger.error(
          `CU model API call failed: ${error.message}`,
          error.stack,
        );
        return this.finalizeStepResult(
          taskId,
          normalizedStep,
          taskGoal,
          `Computer Use step failed: ${error.message}. ${actionsExecuted} actions executed before this.`,
          'failed',
          latestScreenshotBase64,
          currentUrl,
          checkpoints,
        );
      }

      const candidate = response.candidates?.[0];
      const finishReason = (candidate as any)?.finishReason;

      if (finishReason) {
        this.logger.debug(`CU model finishReason: ${finishReason}`);
      }

      if (!candidate?.content?.parts) {
        const reason = finishReason || 'unknown';
        this.logger.warn(
          `CU model returned empty/blocked response (reason: ${reason}) - running verification`,
        );
        const checkpoint = await this.captureCheckpoint({
          taskId,
          checkpointIndex: checkpoints.length + 1,
          mode: normalizedStep.executionMode,
          taskGoal,
          step: normalizedStep,
          screenshotBase64: latestScreenshotBase64,
          currentUrl,
          fallbackSummary: await this.verifyScreenState(
            taskId,
            normalizedStep.description,
            signal,
          ),
        });
        checkpoints.push(checkpoint);
        return this.finalizeStepResult(
          taskId,
          normalizedStep,
          taskGoal,
          checkpoint.visibleSummary,
          checkpoint.status,
          latestScreenshotBase64,
          currentUrl,
          checkpoints,
        );
      }

      const modelParts = candidate.content.parts;

      history.push({
        role: 'model',
        parts: modelParts,
      });

      const functionCalls = modelParts.filter((p: Part) => p.functionCall);

      if (functionCalls.length === 0) {
        const textPart = modelParts.find((p: Part) => p.text);
        const checkpoint = await this.captureCheckpoint({
          taskId,
          checkpointIndex: checkpoints.length + 1,
          mode: normalizedStep.executionMode,
          taskGoal,
          step: normalizedStep,
          screenshotBase64: latestScreenshotBase64,
          currentUrl,
          lastActionName,
          lastActionOutput,
          fallbackStatus: 'in_progress',
          fallbackSummary:
            textPart?.text ||
            `The screen changed after ${actionsExecuted} action${actionsExecuted === 1 ? '' : 's'}, but the current step still needs visible verification.`,
        });
        checkpoints.push(checkpoint);
        this.logger.log(
          `CU Executor: step done - ${checkpoint.visibleSummary || checkpoint.status}`,
        );
        return this.finalizeStepResult(
          taskId,
          normalizedStep,
          taskGoal,
          checkpoint.visibleSummary ||
            textPart?.text ||
            `Step completed after ${actionsExecuted} actions.`,
          checkpoint.status,
          latestScreenshotBase64,
          currentUrl,
          checkpoints,
        );
      }

      const functionResponses: Part[] = [];

      for (const part of functionCalls) {
        if (signal.aborted) {
          return this.finalizeStepResult(
            taskId,
            normalizedStep,
            taskGoal,
            `Step aborted after ${actionsExecuted} actions.`,
            'failed',
            latestScreenshotBase64,
            currentUrl,
            checkpoints,
          );
        }

        const fc = part.functionCall!;
        const originalFunctionArgs =
          ((fc.args as Record<string, unknown>) || {}) as Record<string, unknown>;
        const functionArgs = this.prepareAuthActionArgs(
          taskId,
          normalizedStep,
          fc.name!,
          originalFunctionArgs,
          currentUrl,
        );
        const confirmationPrompt = this.buildConfirmationPrompt(
          taskId,
          normalizedStep,
          fc.name!,
          functionArgs,
          currentUrl,
        );
        if (confirmationPrompt) {
          return {
            summary: confirmationPrompt,
            status: 'in_progress',
            outcome: {
              kind: 'needs_confirmation',
              confirmationKind: 'sensitive_action',
            },
            mode: normalizedStep.executionMode,
            currentUrl,
            taskGoal,
            checkpoints,
            requiresConfirmation: {
              actionName: fc.name!,
              actionArgs: functionArgs,
              stepDescription: normalizedStep.description,
              prompt: confirmationPrompt,
            },
            screenshotBase64: await this.takeScreenshot(),
          };
        }

        try {
          const result: ActionResult = await this.actionMapper.execute(
            {
              name: fc.name!,
              args: functionArgs,
            },
            {
              resolveSecretText: (text) =>
                this.taskSecretsService.resolvePlaceholders(taskId, text),
            },
          );
          actionsExecuted++;
          lastActionName = fc.name!;
          lastActionOutput = result.output;

          currentUrl = this.deriveCurrentUrl(
            fc.name!,
            functionArgs,
            result,
            currentUrl,
          );

          if (currentUrl) {
            this.lastKnownUrlByTask.set(taskId, currentUrl);
          }

          this.logger.debug(`CU action ${fc.name}: ${result.output}`);

          const responsePayload: Record<string, unknown> = {
            output: result.output,
          };

          if (currentUrl) {
            responsePayload.current_url = currentUrl;
          }

          const acknowledgedSafetyDecision =
            this.buildSafetyDecisionAcknowledgement(functionArgs);
          if (acknowledgedSafetyDecision) {
            responsePayload.safety_decision = acknowledgedSafetyDecision;
            responsePayload.safety_decision_acknowledged = true;
          }

          functionResponses.push({
            functionResponse: {
              name: fc.name!,
              id: fc.id,
              response: responsePayload,
            },
          });
        } catch (error: any) {
          this.logger.error(
            `CU action ${fc.name} failed: ${error.message}`,
            error.stack,
          );

          const responsePayload: Record<string, unknown> = {
            error: error.message,
          };
          if (currentUrl) {
            responsePayload.current_url = currentUrl;
          }

          const acknowledgedSafetyDecision =
            this.buildSafetyDecisionAcknowledgement(functionArgs);
          if (acknowledgedSafetyDecision) {
            responsePayload.safety_decision = acknowledgedSafetyDecision;
            responsePayload.safety_decision_acknowledged = true;
          }

          functionResponses.push({
            functionResponse: {
              name: fc.name!,
              id: fc.id,
              response: responsePayload,
            },
          });
        }
      }

      await this.delay(300);

      latestScreenshotBase64 = await this.takeScreenshot();

      history.push({
        role: 'user',
        parts: [
          ...functionResponses,
          {
            inlineData: {
              data: latestScreenshotBase64,
              mimeType: 'image/png',
            },
          },
        ],
      });

      if ((turn + 1) % settings.checkpointEvery === 0) {
        const checkpoint = await this.captureCheckpoint({
          taskId,
          checkpointIndex: checkpoints.length + 1,
          mode: normalizedStep.executionMode,
          taskGoal,
          step: normalizedStep,
          screenshotBase64: latestScreenshotBase64,
          currentUrl,
          lastActionName,
          lastActionOutput,
        });
        checkpoints.push(checkpoint);
        if (checkpoint.status === 'completed' || checkpoint.status === 'drifted') {
          return this.finalizeStepResult(
            taskId,
            normalizedStep,
            taskGoal,
            checkpoint.visibleSummary,
            checkpoint.status,
            latestScreenshotBase64,
            currentUrl,
            checkpoints,
          );
        }
      }
    }

    this.logger.warn(
      'CU Executor: checkpoint batch limit reached for step - returning progress',
    );
    const checkpoint = await this.captureCheckpoint({
      taskId,
      checkpointIndex: checkpoints.length + 1,
      mode: normalizedStep.executionMode,
      taskGoal,
      step: normalizedStep,
      screenshotBase64: latestScreenshotBase64,
      currentUrl,
      lastActionName,
      lastActionOutput,
      fallbackSummary: await this.verifyScreenState(
        taskId,
        normalizedStep.description,
        signal,
      ),
      forceInProgress: true,
    });
    checkpoints.push(checkpoint);
    return this.finalizeStepResult(
      taskId,
      normalizedStep,
      taskGoal,
      checkpoint.visibleSummary,
      checkpoint.status,
      latestScreenshotBase64,
      currentUrl,
      checkpoints,
    );
  }

  private async verifyScreenState(
    taskId: string,
    stepDescription: string,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const screenshot = await this.takeScreenshot();
      const response = await this.google.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `Look at this screenshot and describe in one paragraph what is currently visible on screen. Then state whether this step appears to be completed: "${stepDescription}"`,
              },
              {
                inlineData: { data: screenshot, mimeType: 'image/png' },
              },
            ],
          },
        ],
        config: { abortSignal: signal },
      });
      await this.recordUsage(
        taskId,
        'gemini-2.5-flash',
        response,
        'computer_use_verification',
      );
      const text = response.candidates?.[0]?.content?.parts?.find(
        (p: Part) => p.text,
      )?.text;
      return text || `Screen shows content after performing: ${stepDescription}`;
    } catch {
      return `Screen shows content after performing: ${stepDescription}`;
    }
  }

  /**
   * Take a final screenshot and ask the CU model to describe the current
   * screen state. Used as a fallback when the main loop exits without a
   * clear summary (max turns, blocked response, etc.).
   */
  private async takeScreenshot(): Promise<string> {
    const response = await fetch(`${BYTEBOT_DESKTOP_BASE_URL}/computer-use`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'screenshot' }),
    });

    if (!response.ok) {
      throw new Error(`Screenshot failed: ${response.statusText}`);
    }

    const data = await response.json();
    if (!data.image) {
      throw new Error('Screenshot returned no image data');
    }
    return data.image;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private normalizeStepInput(step: DesktopStepInput): NormalizedDesktopStepInput {
    const expectedStateEntries = Object.entries(step.expectedState || {}).filter(
      ([key, value]) => typeof key === 'string' && typeof value === 'string',
    ) as [string, string][];

    return {
      description: step.description,
      executionMode: step.executionMode || 'fast',
      expectedState: Object.fromEntries(expectedStateEntries),
      completionCondition: step.completionCondition?.trim() || undefined,
      driftCondition: step.driftCondition?.trim() || undefined,
    };
  }

  private getModeSettings(mode: ExecutionMode): {
    turnBudget: number;
    checkpointEvery: number;
    captureInitialCheckpoint: boolean;
    analyzeScreen: boolean;
  } {
    switch (mode) {
      case 'strict':
        return {
          turnBudget: Math.min(this.maxTurns, 5),
          checkpointEvery: 2,
          captureInitialCheckpoint: true,
          analyzeScreen: true,
        };
      case 'guarded':
        return {
          turnBudget: Math.min(this.maxTurns, 8),
          checkpointEvery: 4,
          captureInitialCheckpoint: true,
          analyzeScreen: true,
        };
      default:
        return {
          turnBudget: Math.min(this.maxTurns, 10),
          checkpointEvery: 5,
          captureInitialCheckpoint: false,
          analyzeScreen: false,
        };
    }
  }

  private async captureCheckpoint(input: {
    taskId: string;
    checkpointIndex: number;
    mode: ExecutionMode;
    taskGoal: string;
    step: NormalizedDesktopStepInput;
    screenshotBase64: string;
    currentUrl?: string;
    lastActionName?: string;
    lastActionOutput?: string;
    fallbackSummary?: string;
    forceInProgress?: boolean;
    fallbackStatus?: ExecutionCheckpointStatus;
  }): Promise<ExecutionCheckpoint> {
    const multiPhaseBrief = this.isMultiPhaseExecutionBrief(
      input.step.description,
    );
    const shouldAnalyze =
      input.mode !== 'fast' ||
      multiPhaseBrief ||
      Object.keys(input.step.expectedState).length > 0 ||
      !!input.step.completionCondition ||
      !!input.step.driftCondition;

    if (!shouldAnalyze) {
      return {
        checkpointIndex: input.checkpointIndex,
        status: input.forceInProgress ? 'in_progress' : 'completed',
        currentUrl: input.currentUrl,
        visibleSummary:
          input.fallbackSummary ||
          input.lastActionOutput ||
          '',
        pageType: 'unknown',
        blockerType: 'unknown',
        targetVisible: undefined,
        nextActionNeeded: input.forceInProgress ? true : undefined,
        actionName: input.lastActionName,
        actionOutput: input.lastActionOutput,
      };
    }

    const analyzed = await this.analyzeScreenState({
      taskId: input.taskId,
      taskGoal: input.taskGoal,
      step: input.step,
      screenshotBase64: input.screenshotBase64,
      currentUrl: input.currentUrl,
      fallbackSummary: input.fallbackSummary || input.lastActionOutput,
      forceInProgress: input.forceInProgress,
    });

    const normalized = this.normalizeRelevantDrift(input, analyzed);

    return {
      checkpointIndex: input.checkpointIndex,
      status: normalized.status,
      currentUrl: input.currentUrl,
      visibleSummary: normalized.visibleSummary,
      extractedFacts: normalized.extractedFacts,
      pageType: normalized.pageType,
      blockerType: normalized.blockerType,
      targetVisible: normalized.targetVisible,
      nextActionNeeded: normalized.nextActionNeeded,
      driftReason: normalized.driftReason,
      actionName: input.lastActionName,
      actionOutput: input.lastActionOutput,
    };
  }

  private normalizeRelevantDrift(
    input: {
      checkpointIndex: number;
      mode: ExecutionMode;
      taskGoal: string;
      step: NormalizedDesktopStepInput;
      screenshotBase64: string;
      currentUrl?: string;
      lastActionName?: string;
      lastActionOutput?: string;
      fallbackSummary?: string;
      forceInProgress?: boolean;
    },
    analyzed: {
      status: ExecutionCheckpointStatus;
      visibleSummary: string;
      extractedFacts: Record<string, string>;
      pageType?: ExecutionCheckpoint['pageType'];
      blockerType?: ExecutionCheckpoint['blockerType'];
      targetVisible?: boolean;
      nextActionNeeded?: boolean;
      driftReason?: string;
    },
  ): {
    status: ExecutionCheckpointStatus;
    visibleSummary: string;
    extractedFacts: Record<string, string>;
    pageType?: ExecutionCheckpoint['pageType'];
    blockerType?: ExecutionCheckpoint['blockerType'];
    targetVisible?: boolean;
    nextActionNeeded?: boolean;
    driftReason?: string;
  } {
    if (analyzed.status !== 'drifted') {
      return analyzed;
    }

    if (
      !this.stepLooksLikeSearchNavigation(input.step.description) ||
      !this.visibleStateSeemsRelevant(
        input.taskGoal,
        analyzed.visibleSummary,
        analyzed.extractedFacts,
        input.currentUrl,
      )
    ) {
      return analyzed;
    }

    return {
      // A relevant page that still needs more work should recover as in-progress,
      // not jump straight to completed just because the screen is vaguely on-topic.
      status: 'in_progress',
      visibleSummary:
        analyzed.visibleSummary ||
        'The current page already appears relevant to the requested task.',
      extractedFacts: analyzed.extractedFacts,
      pageType: analyzed.pageType,
      blockerType: analyzed.blockerType,
      targetVisible:
        analyzed.targetVisible === true ? false : analyzed.targetVisible,
      nextActionNeeded:
        analyzed.nextActionNeeded === false ? true : analyzed.nextActionNeeded,
    };
  }

  private stepLooksLikeSearchNavigation(description: string): boolean {
    return /\b(search|summarize|summarise|open a new tab|navigate to|go to|click the address bar|type .*press enter|open the article|click the first search result|open the page)\b/i.test(
      description,
    );
  }

  private visibleStateSeemsRelevant(
    taskGoal: string,
    visibleSummary: string,
    extractedFacts: Record<string, string>,
    currentUrl?: string,
  ): boolean {
    if (this.visibleStateLooksBlockedOrUnusable(visibleSummary, currentUrl)) {
      return false;
    }

    const corpus = [
      taskGoal,
      visibleSummary,
      currentUrl || '',
      ...Object.values(extractedFacts),
    ]
      .join(' ')
      .toLowerCase();

    const keywords = taskGoal
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter(
        (token) =>
          token.length >= 3 &&
          ![
            'the',
            'this',
            'that',
            'from',
            'with',
            'into',
            'them',
            'then',
            'latest',
            'search',
            'summarize',
            'summary',
            'show',
            'find',
            'open',
            'click',
            'page',
            'article',
          ].includes(token),
      );

    const overlap = keywords.filter((token) => corpus.includes(token));
    const looksLikeResultPage =
      /\b(article|results|summary|advances|advancement|report|news|research|diagnostic imaging|page displays)\b/i.test(
        visibleSummary,
      );

    return overlap.length >= 2 || (looksLikeResultPage && overlap.length >= 1);
  }

  private visibleStateLooksBlockedOrUnusable(
    visibleSummary: string,
    currentUrl?: string,
  ): boolean {
    const corpus = `${visibleSummary || ''} ${currentUrl || ''}`.toLowerCase();
    return /\b(captcha|recaptcha|not a robot|cloudflare|turnstile|hcaptcha|login wall|sign in|consent prompt|consent dialog|blank page|about:blank|stuck in a loading state|loading state|unusable page|blocked page|access denied)\b/.test(
      corpus,
    );
  }

  private async analyzeScreenState(input: {
    taskId: string;
    taskGoal: string;
    step: NormalizedDesktopStepInput;
    screenshotBase64: string;
    currentUrl?: string;
    fallbackSummary?: string;
    forceInProgress?: boolean;
    fallbackStatus?: ExecutionCheckpointStatus;
  }): Promise<{
    status: ExecutionCheckpointStatus;
    visibleSummary: string;
    extractedFacts: Record<string, string>;
    pageType?: ExecutionCheckpoint['pageType'];
    blockerType?: ExecutionCheckpoint['blockerType'];
    targetVisible?: boolean;
    nextActionNeeded?: boolean;
    driftReason?: string;
  }> {
    try {
      const prompt = [
        'Return JSON only.',
        'Use this exact shape:',
        '{"status":"in_progress|completed|drifted","visibleSummary":"...","pageType":"desktop|blank|browser_home|search_results|detail_page|form|login|interstitial|consent|cart|player|meeting|unknown","blockerType":"none|captcha|login_required|consent|interstitial|modal|network|permission|unknown","targetVisible":true,"nextActionNeeded":false,"driftReason":"...","extractedFacts":{"key":"value"}}',
        `Overall task: ${input.taskGoal}`,
        `Current step: ${input.step.description}`,
        `Execution mode: ${input.step.executionMode}`,
        input.currentUrl ? `Current URL: ${input.currentUrl}` : 'Current URL: unknown',
        `Expected state: ${JSON.stringify(input.step.expectedState)}`,
        `Completion condition: ${input.step.completionCondition || 'If the visible screen clearly shows the requested step is done, mark completed.'}`,
        `Drift condition: ${input.step.driftCondition || 'Mark drifted only if the visible page clearly contradicts the target values or stale state is present.'}`,
        'Do not mark drifted just because an intermediate suggestion, button, or popup is temporarily not visible if the current screen still appears to be on the correct flow.',
        'When the screen is on the right flow but more interaction is still needed, prefer "in_progress" over "drifted".',
        'Set pageType from the dominant visible surface, blockerType from the main blocker if any, targetVisible to true only when the requested target for this step is visibly present, and nextActionNeeded to true when more interaction is still needed.',
        'Use blockerType "interstitial" or "consent" for soft blockers instead of pretending the task is complete. Use blockerType "none" when no blocker is visible.',
        this.isMultiPhaseExecutionBrief(input.step.description)
          ? 'This is a broader planner-managed phase. Judge progress against the whole visible phase, not against one tiny click. If the screen still shows the correct search, form, sign-in, shopping, travel, or results flow, prefer "in_progress" over "drifted". If the final requested result is already visible, mark "completed".'
          : 'Judge progress against the current handoff only.',
        /form|search|flight|train|hotel|signin|sign in|login|log in|filter|field|route|date/i.test(
          `${input.taskGoal}\n${input.step.description}`,
        )
          ? 'When helpful, include clearly visible field facts in extractedFacts using keys such as origin, destination, trip_type, departure_date, return_date, passenger_count, email, username, result_title, or result_status. Do not invent values.'
          : 'Populate extractedFacts only with clearly visible facts that may help later steps. Do not invent values.',
        this.looksLikeMediaTask(input.taskGoal)
          ? 'If this is a media or meeting screen, include any clearly visible facts in extractedFacts when available using keys such as media_title, media_channel, player_current_time, player_total_time, player_state, autoplay_state, replay_visible, and end_screen_visible. Do not invent values that are not clearly visible.'
          : 'If this is not media, do not hallucinate hidden values or invisible form state.',
        input.forceInProgress
          ? 'Unless there is a clear contradiction with the target values, prefer status "in_progress" for this checkpoint batch.'
          : 'Choose completed only when the visible screen clearly matches the requested step outcome.',
      ].join('\n');

      const response = await this.google.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              {
                inlineData: {
                  data: input.screenshotBase64,
                  mimeType: 'image/png',
                },
              },
            ],
          },
        ],
      });
      await this.recordUsage(
        input.taskId,
        'gemini-2.5-flash',
        response,
        'computer_use_checkpoint',
      );

      const raw = response.candidates?.[0]?.content?.parts?.find(
        (p: Part) => p.text,
      )?.text;

      const parsed = this.parseCheckpointAnalysis(raw || '');
      if (parsed) {
        if (input.forceInProgress && parsed.status === 'completed') {
          parsed.status = 'in_progress';
        }
        return parsed;
      }
    } catch (error: any) {
      this.logger.warn(
        `Checkpoint analysis fallback triggered: ${error?.message || 'unknown error'}`,
      );
    }

    return {
      status:
        input.fallbackStatus ||
        (input.forceInProgress ? 'in_progress' : 'completed'),
      visibleSummary:
        input.fallbackSummary ||
        'The current screen state was captured, but structured analysis was unavailable.',
      extractedFacts: {},
      pageType: 'unknown',
      blockerType: 'unknown',
      targetVisible: undefined,
      nextActionNeeded: input.forceInProgress ? true : undefined,
    };
  }

  private parseCheckpointAnalysis(raw: string): {
    status: ExecutionCheckpointStatus;
    visibleSummary: string;
    extractedFacts: Record<string, string>;
    pageType?: ExecutionCheckpoint['pageType'];
    blockerType?: ExecutionCheckpoint['blockerType'];
    targetVisible?: boolean;
    nextActionNeeded?: boolean;
    driftReason?: string;
  } | null {
    if (!raw) {
      return null;
    }

    const normalized = raw
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    const objectStart = normalized.indexOf('{');
    const objectEnd = normalized.lastIndexOf('}');
    const candidate =
      objectStart !== -1 && objectEnd !== -1 && objectEnd > objectStart
        ? normalized.slice(objectStart, objectEnd + 1)
        : normalized;

    try {
      const parsed = JSON.parse(candidate) as {
        status?: ExecutionCheckpointStatus;
        visibleSummary?: string;
        extractedFacts?: Record<string, unknown>;
        pageType?: ExecutionCheckpoint['pageType'];
        blockerType?: ExecutionCheckpoint['blockerType'];
        targetVisible?: unknown;
        nextActionNeeded?: unknown;
        driftReason?: string;
      };
      if (
        !parsed.status ||
        !['in_progress', 'completed', 'drifted', 'failed'].includes(
          parsed.status,
        ) ||
        typeof parsed.visibleSummary !== 'string'
      ) {
        return null;
      }

      const extractedFacts = Object.fromEntries(
        Object.entries(parsed.extractedFacts || {})
          .filter(([, value]) => typeof value === 'string')
          .map(([key, value]) => [key, value as string]),
      );

      return {
        status: parsed.status,
        visibleSummary: parsed.visibleSummary,
        extractedFacts,
        pageType:
          typeof parsed.pageType === 'string' ? parsed.pageType : undefined,
        blockerType:
          typeof parsed.blockerType === 'string' ? parsed.blockerType : undefined,
        targetVisible:
          typeof parsed.targetVisible === 'boolean'
            ? parsed.targetVisible
            : undefined,
        nextActionNeeded:
          typeof parsed.nextActionNeeded === 'boolean'
            ? parsed.nextActionNeeded
            : undefined,
        driftReason:
          typeof parsed.driftReason === 'string'
            ? parsed.driftReason
            : undefined,
      };
    } catch {
      return null;
    }
  }

  private buildActionSignature(
    actionName: string,
    args: Record<string, unknown>,
    currentUrl?: string,
  ): string {
    return JSON.stringify({
      actionName,
      currentUrl: currentUrl || null,
      args,
    });
  }

  private shouldEscalateRepeatedActionLoop(
    mode: ExecutionMode,
    actionName: string,
  ): boolean {
    if (mode === 'strict') {
      return true;
    }

    return !['wait', 'scroll_document'].includes(actionName);
  }

  private isMultiPhaseExecutionBrief(description: string): boolean {
    return /^(?:planner execution brief|recovery brief):/i.test(
      description.trim(),
    );
  }

  private looksLikeMediaTask(taskGoal: string): boolean {
    return /\b(youtube|video|audio|song|music|listen|watch|podcast|meeting|meet|zoom|teams|webinar)\b/i.test(
      taskGoal,
    );
  }

  private async recordUsage(
    taskId: string,
    model: string,
    response: any,
    purpose: string,
  ): Promise<void> {
    const usageMetadata = response?.usageMetadata;
    if (!usageMetadata) {
      return;
    }

    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { result: true },
    });

    const currentResult = (task?.result || {}) as Record<string, unknown>;
    const currentUsage = currentResult.usage as TaskUsageState | undefined;
    const updatedUsage = mergeTaskUsage(currentUsage, {
      provider: 'google',
      model,
      purpose,
      inputTokens: usageMetadata.promptTokenCount || 0,
      outputTokens: usageMetadata.candidatesTokenCount || 0,
      totalTokens: usageMetadata.totalTokenCount || 0,
    });

    await this.prisma.task.update({
      where: { id: taskId },
      data: {
        result: {
          ...currentResult,
          usage: updatedUsage,
        } as Prisma.InputJsonValue,
      },
    });
  }

  private finalizeStepResult(
    taskId: string,
    step: NormalizedDesktopStepInput,
    taskGoal: string,
    summary: string,
    status: ExecutionCheckpointStatus,
    screenshotBase64: string | undefined,
    currentUrl: string | undefined,
    checkpoints: ExecutionCheckpoint[],
  ): ComputerUseStepResult {
    const cleanedSummary = this.normalizeComputerUseSummaryText(summary);
    const normalizedSummary = this.normalizeSummaryForAvailableAuth(
      taskId,
      step,
      cleanedSummary,
      currentUrl,
    );
    const normalizedStatus =
      status === 'completed' &&
      this.isAuthContinuationSummary(normalizedSummary)
        ? 'in_progress'
        : status;

    return {
      summary: normalizedSummary,
      status: normalizedStatus,
      outcome: this.buildStructuredStepOutcome(
        normalizedStatus,
        normalizedSummary,
      ),
      mode: step.executionMode,
      screenshotBase64,
      currentUrl,
      expectedState: step.expectedState,
      completionCondition: step.completionCondition,
      driftCondition: step.driftCondition,
      taskGoal,
      checkpoints,
    };
  }

  private buildHumanAttentionResult(
    step: NormalizedDesktopStepInput,
    taskGoal: string,
    prompt: string,
    screenshotBase64: string | undefined,
    currentUrl: string | undefined,
    checkpoints: ExecutionCheckpoint[],
  ): ComputerUseStepResult {
    return {
      summary: prompt,
      status: 'in_progress',
      outcome: {
        kind: 'needs_human_attention',
        attentionKind: 'captcha',
      },
      mode: step.executionMode,
      screenshotBase64,
      currentUrl,
      expectedState: step.expectedState,
      completionCondition: step.completionCondition,
      driftCondition: step.driftCondition,
      taskGoal,
      checkpoints,
      requiresConfirmation: {
        actionName: 'human_attention_needed',
        actionArgs: {},
        stepDescription: step.description,
        prompt,
      },
    };
  }

  private getHumanAttentionPromptFromVisibleState(
    visibleSummary: string,
    currentUrl?: string,
  ): string | null {
    const corpus = `${visibleSummary || ''} ${currentUrl || ''}`.toLowerCase();
    if (
      /\b(captcha|recaptcha|i'?m not a robot|not a robot|cloudflare|turnstile|hcaptcha|cf-challenge)\b/.test(
        corpus,
      )
    ) {
      return 'A CAPTCHA or human verification step is blocking progress. Please complete it in the desktop view, then send the next instruction here to continue.';
    }

    return null;
  }

  private isAuthContinuationSummary(summary: string): boolean {
    const normalized = (summary || '').toLowerCase();
    return (
      normalized.includes('the current page is asking for sign-in') &&
      normalized.includes('continue the login flow automatically')
    );
  }

  forgetTaskContext(taskId: string): void {
    this.lastKnownUrlByTask.delete(taskId);
    this.recentScreenshotByTask.delete(taskId);
  }

  rememberTaskUrl(taskId: string, url: string): void {
    this.lastKnownUrlByTask.set(taskId, url);
  }

  rememberRecentScreenshot(taskId: string, imageBase64: string): void {
    if (!imageBase64) {
      return;
    }

    this.recentScreenshotByTask.set(taskId, {
      imageBase64,
      capturedAt: Date.now(),
    });
  }

  private getRecentScreenshot(taskId: string, maxAgeMs = 2500): string | null {
    const cached = this.recentScreenshotByTask.get(taskId);
    if (!cached) {
      return null;
    }

    if (Date.now() - cached.capturedAt > maxAgeMs) {
      this.recentScreenshotByTask.delete(taskId);
      return null;
    }

    return cached.imageBase64;
  }

  async executeApprovedAction(
    taskId: string,
    actionName: string,
    actionArgs: Record<string, unknown>,
  ): Promise<ComputerUseStepResult> {
    const result = await this.actionMapper.execute(
      {
        name: actionName,
        args: actionArgs,
      },
      {
        resolveSecretText: (text) =>
          this.taskSecretsService.resolvePlaceholders(taskId, text),
      },
    );

    const currentUrl = this.deriveCurrentUrl(
      actionName,
      actionArgs,
      result,
      this.lastKnownUrlByTask.get(taskId),
    );
    if (currentUrl) {
      this.lastKnownUrlByTask.set(taskId, currentUrl);
    }

    await this.delay(500);

    return {
      summary: `Approved action executed: ${result.output}`,
      status: 'completed',
      outcome: {
        kind: 'step_completed',
      },
      mode: 'strict',
      screenshotBase64: await this.takeScreenshot(),
      currentUrl,
      taskGoal: 'Execute approved sensitive action',
      checkpoints: [
        {
          checkpointIndex: 1,
          status: 'completed',
          currentUrl,
          visibleSummary: `Approved action executed: ${result.output}`,
          actionName,
          actionOutput: result.output,
        },
      ],
    };
  }

  private deriveCurrentUrl(
    actionName: string,
    args: Record<string, unknown>,
    result: ActionResult,
    previousUrl?: string,
  ): string | undefined {
    if (result.currentUrl) {
      return result.currentUrl;
    }

    if (
      actionName === 'type_text_at' &&
      args.press_enter &&
      typeof args.text === 'string'
    ) {
      const typedText = args.text.trim();
      if (!typedText) {
        return previousUrl;
      }

      if (/^https?:\/\//i.test(typedText)) {
        return typedText;
      }

      if (/^[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(typedText)) {
        return `https://${typedText}`;
      }

      if (previousUrl) {
        try {
          const previous = new URL(previousUrl);
          const isGoogleSearchPage =
            previous.hostname === 'google.com' ||
            previous.hostname === 'www.google.com' ||
            previous.hostname.endsWith('.google.com');

          if (isGoogleSearchPage) {
            const searchUrl = new URL('/search', `${previous.protocol}//${previous.host}`);
            searchUrl.searchParams.set('q', typedText);
            return searchUrl.toString();
          }
        } catch {
          return previousUrl;
        }
      }

      return previousUrl;
    }

    return previousUrl;
  }

  private getFunctionResponseCurrentUrl(currentUrl?: string): string {
    const normalized = currentUrl?.trim();
    return normalized || 'about:blank';
  }

  private getPostActionDelayMs(
    actionName: string,
    args: Record<string, unknown>,
  ): number {
    if (
      actionName === 'open_web_browser' ||
      actionName === 'computer_application'
    ) {
      return 120;
    }

    if (actionName === 'scroll') {
      return 80;
    }

    if (actionName === 'type_text_at') {
      return args.press_enter ? 110 : 70;
    }

    if (actionName === 'click') {
      return 70;
    }

    if (
      actionName === 'navigate' ||
      actionName === 'go_back' ||
      actionName === 'go_forward'
    ) {
      return 140;
    }

    return 70;
  }

  private normalizeComputerUseSummaryText(summary: string): string {
    const normalized = (summary || '')
      .replace(/<ctrl\d+>/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!normalized) {
      return summary;
    }

    const toolCallMatch = normalized.match(
      /call:set_task_status\s*\{\s*description:\s*(.*?)\s*,\s*status:\s*(completed|needs_help)\s*\}/i,
    );
    if (toolCallMatch?.[1]) {
      return toolCallMatch[1].replace(/^["']|["']$/g, '').trim();
    }

    return normalized;
  }

  private buildConfirmationPrompt(
    taskId: string,
    step: NormalizedDesktopStepInput,
    actionName: string,
    args: Record<string, unknown>,
    currentUrl?: string,
  ): string | null {
    if (!args.safety_decision) {
      return null;
    }

    if (
      this.shouldAutoApproveSafetyDecision(
        taskId,
        step,
        actionName,
        args,
        currentUrl,
      )
    ) {
      return null;
    }

    const decision =
      typeof args.safety_decision === 'object' && args.safety_decision
        ? (args.safety_decision as Record<string, unknown>)
        : null;
    const reason =
      (decision?.explanation as string | undefined) ||
      (decision?.reason as string | undefined) ||
      (decision?.decision as string | undefined) ||
      (decision?.type as string | undefined);

    return `This ${actionName.replace(/_/g, ' ')} requires your confirmation before I continue${reason ? ` (${reason})` : ''}. Review the screen, then click Proceed to approve it.`;
  }

  private shouldAutoApproveSafetyDecision(
    taskId: string,
    step: NormalizedDesktopStepInput,
    actionName: string,
    args: Record<string, unknown>,
    currentUrl?: string,
  ): boolean {
    const normalizedDescription = step.description.toLowerCase();
    const normalizedUrl = (currentUrl || '').toLowerCase();
    const rawDecision =
      typeof args.safety_decision === 'object' && args.safety_decision
        ? (args.safety_decision as Record<string, unknown>)
        : null;
    const normalizedDecisionText = [
      rawDecision?.decision,
      rawDecision?.reason,
      rawDecision?.type,
      rawDecision?.explanation,
    ]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join(' ')
      .toLowerCase();
    const riskyKeywords =
      /\b(send|submit|book|booking|purchase|buy|pay|payment|delete|remove|confirm order|place order|checkout|transfer|wire|publish|post)\b/;
    const captchaKeywords =
      /\b(captcha|recaptcha|i'?m not a robot|not a robot|verify\b|verification challenge|security challenge|take over)\b/;
    const loginKeywords =
      /\b(sign in|signin|log in|login|password|email or phone|verification code|otp|2fa|next button|continue to gmail)\b/;
    const loginHosts = /(accounts\.google\.com|login|signin|sign-in|auth|oauth)/;
    const sensitiveActionNames = ['click_at', 'type_text_at', 'type_text', 'press_key'];
    const isSensitiveAction =
      sensitiveActionNames.includes(actionName) &&
      riskyKeywords.test(normalizedDescription);

    if (
      captchaKeywords.test(normalizedDescription) ||
      captchaKeywords.test(normalizedDecisionText)
    ) {
      return false;
    }

    const secrets = this.taskSecretsService.get(taskId);
    const looksLikeLoginProgression =
      loginKeywords.test(normalizedDescription) ||
      normalizedDescription.includes('[[secure:username]]') ||
      normalizedDescription.includes('[[secure:password]]') ||
      normalizedDescription.includes('[[secure:otp]]') ||
      loginHosts.test(normalizedUrl);

    if (looksLikeLoginProgression) {
      if (!secrets?.username && !secrets?.password && !secrets?.otp) {
        return false;
      }

      if (riskyKeywords.test(normalizedDescription)) {
        return false;
      }

      return sensitiveActionNames.includes(actionName);
    }

    if (isSensitiveAction) {
      return false;
    }

    return true;
  }

  private buildSafetyDecisionAcknowledgement(
    args: Record<string, unknown>,
  ): Record<string, unknown> | null {
    const rawDecision = args.safety_decision;
    if (!rawDecision || typeof rawDecision !== 'object') {
      return null;
    }

    const decision = rawDecision as Record<string, unknown>;
    return {
      ...decision,
      acknowledged: true,
    };
  }

  private normalizeSummaryForAvailableAuth(
    taskId: string,
    step: NormalizedDesktopStepInput,
    summary: string,
    currentUrl?: string,
  ): string {
    const secrets = this.taskSecretsService.get(taskId);
    if ((!secrets?.username && !secrets?.password && !secrets?.otp) || !summary) {
      return summary;
    }

    const normalizedSummary = summary.toLowerCase();
    const normalizedStep = step.description.toLowerCase();
    const normalizedUrl = (currentUrl || '').toLowerCase();
    const missingCredentialPhrases = [
      "i don't have credentials",
      'i do not have credentials',
      'cannot proceed without login',
      'cannot proceed without logging in',
      'cannot access the inbox without logging in',
      'please provide credentials',
      'i need to log in',
      'i need login details',
    ];

    const isAuthContext =
      /\b(sign in|signin|log in|login|password|email or phone|gmail|inbox)\b/.test(
        normalizedStep,
      ) ||
      /(accounts\.google\.com|login|signin|sign-in|auth|oauth)/.test(
        normalizedUrl,
      );

    if (
      !isAuthContext ||
      !missingCredentialPhrases.some((phrase) => normalizedSummary.includes(phrase))
    ) {

      const authField = this.detectAuthField(step.description);
      if (
        authField === 'username' &&
        (normalizedSummary.includes('@') ||
          normalizedSummary.includes('email or phone') ||
          normalizedSummary.includes('username'))
      ) {
        return 'The sign-in username field was populated using the saved credentials.';
      }

      if (
        authField === 'password' &&
        (normalizedSummary.includes('password') ||
          normalizedSummary.includes('typed') ||
          normalizedSummary.includes('entered'))
      ) {
        return 'The sign-in password field was populated using the saved credentials.';
      }

      if (
        authField === 'otp' &&
        (normalizedSummary.includes('otp') ||
          normalizedSummary.includes('verification code') ||
          normalizedSummary.includes('entered'))
      ) {
        return 'The sign-in verification code field was populated using the saved credentials.';
      }

      return summary;
    }

    return 'The current page is asking for sign-in, and secure saved placeholders are available for this task. Continue the login flow automatically using those placeholders instead of asking the user for credentials again.';
  }

  private prepareAuthActionArgs(
    taskId: string,
    step: NormalizedDesktopStepInput,
    actionName: string,
    args: Record<string, unknown>,
    currentUrl?: string,
  ): Record<string, unknown> {
    if (actionName !== 'type_text_at') {
      return args;
    }

    if (!this.isAuthContext(step.description, currentUrl)) {
      return args;
    }

    const authField = this.detectAuthField(step.description);
    if (!authField) {
      return args;
    }

    const secrets = this.taskSecretsService.get(taskId);
    const placeholder = this.getAuthPlaceholder(authField);
    const rawValue = secrets?.[authField];

    if (!rawValue) {
      return args;
    }

    const nextArgs = {
      ...args,
      text: placeholder,
      clear_before_typing:
        args.clear_before_typing !== undefined ? args.clear_before_typing : true,
    };

    if (args.text !== placeholder) {
      this.logger.debug(
        `Auth action override applied for ${authField} on step "${step.description}"`,
      );
    }

    return nextArgs;
  }

  private isAuthContext(
    description: string,
    currentUrl?: string,
  ): boolean {
    const normalizedDescription = description.toLowerCase();
    const normalizedUrl = (currentUrl || '').toLowerCase();
    return (
      /\b(sign in|signin|log in|login|password|email or phone|verification code|otp|2fa|continue to gmail|gmail|inbox)\b/.test(
        normalizedDescription,
      ) ||
      /(accounts\.google\.com|login|signin|sign-in|auth|oauth)/.test(
        normalizedUrl,
      )
    );
  }

  private detectAuthField(description: string): AuthSecretField | null {
    const normalizedDescription = description.toLowerCase();

    if (
      /\b(password|passcode)\b/.test(normalizedDescription) ||
      normalizedDescription.includes('[[secure:password]]')
    ) {
      return 'password';
    }

    if (
      /\b(otp|2fa|verification code|one-time code|one time code|authenticator code)\b/.test(
        normalizedDescription,
      ) ||
      normalizedDescription.includes('[[secure:otp]]')
    ) {
      return 'otp';
    }

    if (
      /\b(email or phone|username|email address|email field|phone field)\b/.test(
        normalizedDescription,
      ) ||
      normalizedDescription.includes('[[secure:username]]')
    ) {
      return 'username';
    }

    return null;
  }

  private getAuthPlaceholder(field: AuthSecretField): string {
    switch (field) {
      case 'password':
        return '[[secure:password]]';
      case 'otp':
        return '[[secure:otp]]';
      default:
        return '[[secure:username]]';
    }
  }

  private buildStructuredStepOutcome(
    status: ExecutionCheckpointStatus,
    summary: string,
  ): ExecutorStepOutcome {
    switch (status) {
      case 'completed':
        return { kind: 'step_completed' };
      case 'drifted':
        return { kind: 'step_drifted' };
      case 'failed':
        return {
          kind: 'step_failed',
          failureKind: this.classifyExecutorFailureKind(summary),
        };
      default:
        return { kind: 'step_in_progress' };
    }
  }

  private classifyExecutorFailureKind(summary: string): ExecutorFailureKind {
    const normalized = (summary || '').toLowerCase();

    if (
      normalized.includes('provider capacity limit') ||
      normalized.includes('resource_exhausted') ||
      normalized.includes('resource has been exhausted') ||
      normalized.includes('quota') ||
      normalized.includes('rate limit')
    ) {
      return 'provider_capacity';
    }

    if (
      normalized.includes('desktop api') ||
      normalized.includes('screenshot failed') ||
      normalized.includes('screenshot returned no image data') ||
      normalized.includes('invalid_argument') ||
      normalized.includes(
        'computer use model requires function response to contain the url',
      )
    ) {
      return 'infrastructure';
    }

    if (
      normalized.includes('appears stuck repeating the same action') ||
      normalized.includes('same action')
    ) {
      return 'repeated_action';
    }

    return 'generic';
  }
}

export type ComputerUseStepResult = {
  summary: string;
  status: ExecutionCheckpointStatus;
  outcome: ExecutorStepOutcome;
  mode: ExecutionMode;
  taskGoal: string;
  screenshotBase64?: string;
  currentUrl?: string;
  expectedState?: Record<string, string>;
  completionCondition?: string;
  driftCondition?: string;
  checkpoints: ExecutionCheckpoint[];
  requiresConfirmation?: {
    actionName: string;
    actionArgs: Record<string, unknown>;
    stepDescription: string;
    prompt: string;
  };
};

type DesktopStepInput = {
  description: string;
  executionMode?: ExecutionMode;
  expectedState?: Record<string, unknown>;
  completionCondition?: string;
  driftCondition?: string;
};

type NormalizedDesktopStepInput = {
  description: string;
  executionMode: ExecutionMode;
  expectedState: Record<string, string>;
  completionCondition?: string;
  driftCondition?: string;
};
