import {
  Injectable,
  NotFoundException,
  Logger,
  BadRequestException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import {
  Task,
  Role,
  Prisma,
  TaskStatus,
  TaskType,
  TaskPriority,
  File,
} from '@prisma/client';
import { AddTaskMessageDto } from './dto/add-task-message.dto';
import { TasksGateway } from './tasks.gateway';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BrowserSessionsService } from './browser-sessions.service';
import { TaskSecretsService } from './task-secrets.service';
import { SessionActiveBranch, TaskSecurityState } from './task-security.types';
import { MediaSessionService } from './media-session.service';
import { BytebotAgentModel } from '../agent/agent.types';
import { GOOGLE_MODELS, DEFAULT_MODEL as DEFAULT_GOOGLE_MODEL } from '../google/google.constants';
import { OPENAI_MODELS } from '../openai/openai.constants';
import { ANTHROPIC_MODELS } from '../anthropic/anthropic.constants';

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);
  private readonly knownModels: BytebotAgentModel[] = [
    ...GOOGLE_MODELS,
    ...OPENAI_MODELS,
    ...ANTHROPIC_MODELS,
  ];

  constructor(
    readonly prisma: PrismaService,
    @Inject(forwardRef(() => TasksGateway))
    private readonly tasksGateway: TasksGateway,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly browserSessionsService: BrowserSessionsService,
    private readonly taskSecretsService: TaskSecretsService,
    private readonly mediaSessionService: MediaSessionService,
  ) {
    this.logger.log('TasksService initialized');
  }

  private createPlannerTurnId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private setSessionActiveBranch(
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

  async create(createTaskDto: CreateTaskDto): Promise<Task> {
    this.logger.log('Creating new task');

    const description = createTaskDto.description?.trim() || createTaskDto.task?.trim();

    if (!description) {
      throw new BadRequestException(
        'Task description is required. Provide either "description" or "task".',
      );
    }

    const normalizedSavedBrowser =
      createTaskDto.savedBrowserSession?.browser === 'firefox'
        ? 'brave'
        : createTaskDto.savedBrowserSession?.browser;

    const browserSessionState = {
      ...(createTaskDto.secureCredential?.mode === 'save_for_later' &&
        createTaskDto.secureCredential.sessionLabel && {
          saveLabel: createTaskDto.secureCredential.sessionLabel,
        }),
      ...(createTaskDto.savedBrowserSession && {
        restoreLabel: createTaskDto.savedBrowserSession.label,
      }),
      ...(createTaskDto.savedBrowserSessionRestoreReason && {
        restoreReason: createTaskDto.savedBrowserSessionRestoreReason,
      }),
      ...((createTaskDto.savedBrowserSession?.site ||
        createTaskDto.secureCredential?.site) && {
        site:
          createTaskDto.savedBrowserSession?.site ||
          createTaskDto.secureCredential?.site,
      }),
      ...(normalizedSavedBrowser && {
        browser: normalizedSavedBrowser,
      }),
    };

    const taskSecurityState: TaskSecurityState = this.setSessionActiveBranch(
      {
        ...(createTaskDto.secureCredential && {
          secureCredentialMode: createTaskDto.secureCredential.mode,
        }),
        ...(Object.keys(browserSessionState).length > 0 && {
          browserSession: browserSessionState,
        }),
      },
      'executing',
      {
        keepAliveUntilUserDone:
          (createTaskDto.createdBy || Role.USER) === Role.USER,
        phase: 'active',
        mode: 'normal',
        awaitingUserDecision: false,
        currentTurnGoal: description,
      },
    );

    const normalizedModel = this.normalizeTaskModel(createTaskDto.model);

    const task = await this.prisma.$transaction(async (prisma) => {
      // Create the task first
      this.logger.debug('Creating task record in database');
      const task = await prisma.task.create({
        data: {
          description,
          type: createTaskDto.type || TaskType.IMMEDIATE,
          priority: createTaskDto.priority || TaskPriority.MEDIUM,
          status: TaskStatus.PENDING,
          createdBy: createTaskDto.createdBy || Role.USER,
          model: normalizedModel,
          result:
            Object.keys(taskSecurityState).length > 0
              ? ({ security: taskSecurityState } as Prisma.InputJsonValue)
              : undefined,
          ...(createTaskDto.scheduledFor
            ? { scheduledFor: createTaskDto.scheduledFor }
            : {}),
        },
      });
      this.logger.log(`Task created successfully with ID: ${task.id}`);

      let filesDescription = '';

      // Save files if provided
      if (createTaskDto.files && createTaskDto.files.length > 0) {
        this.logger.debug(
          `Saving ${createTaskDto.files.length} file(s) for task ID: ${task.id}`,
        );
        filesDescription += `\n`;

        const filePromises = createTaskDto.files.map((file) => {
          // Extract base64 data without the data URL prefix
          const base64Data = file.base64.includes('base64,')
            ? file.base64.split('base64,')[1]
            : file.base64;

          filesDescription += `\nFile ${file.name} written to desktop.`;

          return prisma.file.create({
            data: {
              name: file.name,
              type: file.type || 'application/octet-stream',
              size: file.size,
              data: base64Data,
              taskId: task.id,
            },
          });
        });

        await Promise.all(filePromises);
        this.logger.debug(`Files saved successfully for task ID: ${task.id}`);
      }

      // Create the initial system message
      this.logger.debug(`Creating initial message for task ID: ${task.id}`);
      await prisma.message.create({
        data: {
          content: [
            {
              type: 'text',
              text: `${description} ${filesDescription}`,
            },
          ] as Prisma.InputJsonValue,
          role: Role.USER,
          taskId: task.id,
        },
      });
      this.logger.debug(`Initial message created for task ID: ${task.id}`);

      return task;
    });

    this.tasksGateway.emitTaskCreated(task);

    return task;
  }

  private async resetOpenInteractiveTasksBeforeCreate(): Promise<void> {
    const openTasks = await this.prisma.task.findMany({
      where: {
        type: TaskType.IMMEDIATE,
        status: {
          in: [TaskStatus.PENDING, TaskStatus.RUNNING, TaskStatus.NEEDS_REVIEW],
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    if (openTasks.length === 0) {
      return;
    }

    this.logger.log(
      `Resetting ${openTasks.length} open interactive task(s) before creating a new task`,
    );

    for (const openTask of openTasks) {
      const updatedTask = await this.prisma.task.update({
        where: { id: openTask.id },
        data: {
          status: TaskStatus.CANCELLED,
        },
      });

      await this.handleTaskSecurityAfterUpdate(openTask, TaskStatus.CANCELLED);
      this.taskSecretsService.forget(openTask.id);
      this.eventEmitter.emit('task.cancel', { taskId: openTask.id });
      this.tasksGateway.emitTaskUpdate(openTask.id, updatedTask);
    }

  }

  private normalizeTaskModel(model: unknown): Prisma.InputJsonValue {
    if (model && typeof model === 'object' && !Array.isArray(model)) {
      const candidate = model as Partial<BytebotAgentModel>;
      if (
        typeof candidate.provider === 'string' &&
        typeof candidate.name === 'string'
      ) {
        return model as Prisma.InputJsonValue;
      }

      if (typeof candidate.name === 'string') {
        const matched = this.knownModels.find(
          (known) => known.name === candidate.name,
        );
        if (matched) {
          return matched as unknown as Prisma.InputJsonValue;
        }
      }
    }

    if (typeof model === 'string' && model.trim().length > 0) {
      const matched = this.knownModels.find(
        (known) => known.name === model.trim(),
      );
      if (matched) {
        return matched as unknown as Prisma.InputJsonValue;
      }
    }

    return DEFAULT_GOOGLE_MODEL as unknown as Prisma.InputJsonValue;
  }

  async findScheduledTasks(): Promise<Task[]> {
    return this.prisma.task.findMany({
      where: {
        scheduledFor: {
          not: null,
        },
        queuedAt: null,
      },
      orderBy: [{ scheduledFor: 'asc' }],
    });
  }

  async findNextTask(): Promise<(Task & { files: File[] }) | null> {
    const task = await this.prisma.task.findFirst({
      where: {
        status: {
          in: [TaskStatus.RUNNING, TaskStatus.PENDING],
        },
      },
      orderBy: [
        { executedAt: 'asc' },
        { priority: 'desc' },
        { queuedAt: 'asc' },
        { createdAt: 'asc' },
      ],
      include: {
        files: true,
      },
    });

    if (task) {
      this.logger.log(
        `Found existing task with ID: ${task.id}, and status ${task.status}. Resuming.`,
      );
    }

    return task;
  }

  async findAll(
    page = 1,
    limit = 10,
    statuses?: string[],
  ): Promise<{ tasks: Task[]; total: number; totalPages: number }> {
    this.logger.log(
      `Retrieving tasks - page: ${page}, limit: ${limit}, statuses: ${statuses?.join(',')}`,
    );

    const skip = (page - 1) * limit;

    const whereClause: Prisma.TaskWhereInput =
      statuses && statuses.length > 0
        ? { status: { in: statuses as TaskStatus[] } }
        : {};

    const [tasks, total] = await Promise.all([
      this.prisma.task.findMany({
        where: whereClause,
        orderBy: {
          createdAt: 'desc',
        },
        skip,
        take: limit,
      }),
      this.prisma.task.count({ where: whereClause }),
    ]);

    const totalPages = Math.ceil(total / limit);
    this.logger.debug(`Retrieved ${tasks.length} tasks out of ${total} total`);

    return { tasks, total, totalPages };
  }

  async findById(id: string): Promise<Task> {
    this.logger.log(`Retrieving task by ID: ${id}`);

    try {
      const task = await this.prisma.task.findUnique({
        where: { id },
        include: {
          files: true,
        },
      });

      if (!task) {
        this.logger.warn(`Task with ID: ${id} not found`);
        throw new NotFoundException(`Task with ID ${id} not found`);
      }

      this.logger.debug(`Retrieved task with ID: ${id}`);
      return task;
    } catch (error: any) {
      this.logger.error(`Error retrieving task ID: ${id} - ${error.message}`);
      this.logger.error(error.stack);
      throw error;
    }
  }

  async update(id: string, updateTaskDto: UpdateTaskDto): Promise<Task> {
    this.logger.log(`Updating task with ID: ${id}`);
    this.logger.debug(`Update data: ${JSON.stringify(updateTaskDto)}`);

    await this.findById(id);

    let updatedTask = await this.prisma.task.update({
      where: { id },
      data: updateTaskDto,
    });

    if (updateTaskDto.status === TaskStatus.COMPLETED) {
      await this.handleTaskSecurityAfterUpdate(updatedTask, updateTaskDto.status);
      this.eventEmitter.emit('task.completed', { taskId: id });
    } else if (updateTaskDto.status === TaskStatus.NEEDS_REVIEW) {
      await this.handleTaskSecurityAfterUpdate(updatedTask, updateTaskDto.status);
      updatedTask = await this.prisma.task.update({
        where: { id },
        data: {
          control: Role.USER,
        },
      });
    } else if (updateTaskDto.status === TaskStatus.NEEDS_HELP) {
      updatedTask = await this.takeOver(id);
    } else if (updateTaskDto.status === TaskStatus.FAILED) {
      await this.handleTaskSecurityAfterUpdate(updatedTask, updateTaskDto.status);
      this.eventEmitter.emit('task.failed', { taskId: id });
    }

    this.logger.log(`Successfully updated task ID: ${id}`);
    this.logger.debug(`Updated task: ${JSON.stringify(updatedTask)}`);

    this.tasksGateway.emitTaskUpdate(id, updatedTask);

    return updatedTask;
  }

  async delete(id: string): Promise<Task> {
    this.logger.log(`Deleting task with ID: ${id}`);

    const deletedTask = await this.prisma.task.delete({
      where: { id },
    });

    this.logger.log(`Successfully deleted task ID: ${id}`);

    this.tasksGateway.emitTaskDeleted(id);

    return deletedTask;
  }

  async addTaskMessage(taskId: string, addTaskMessageDto: AddTaskMessageDto) {
    const task = await this.findById(taskId);
    if (!task) {
      this.logger.warn(`Task with ID: ${taskId} not found for guiding`);
      throw new NotFoundException(`Task with ID ${taskId} not found`);
    }

    const message = await this.prisma.message.create({
      data: {
        content: [{ type: 'text', text: addTaskMessageDto.message }],
        role: Role.USER,
        taskId,
      },
    });

    this.tasksGateway.emitNewMessage(taskId, message);

    const security = this.getTaskSecurityState(task);
    if (
      task.status === TaskStatus.NEEDS_REVIEW &&
      security.session?.awaitingUserDecision
    ) {
      if (
        this.mediaSessionService.isExplicitSessionCloseCommand(
          addTaskMessageDto.message,
        )
      ) {
        const updatedTask = await this.prisma.task.update({
          where: { id: taskId },
          data: {
            status: TaskStatus.COMPLETED,
            completedAt: new Date(),
            result: this.mergeTaskResult(task, {
              security: {
                ...security,
                session: {
                  ...(security.session || {}),
                  phase: 'closed',
                  awaitingUserDecision: false,
                  lastTerminalStatus: 'completed',
                  lastTerminalSummary:
                    security.session?.lastTerminalSummary || 'Task closed by user.',
                  closedAt: new Date().toISOString(),
                },
              },
            }) as Prisma.InputJsonValue,
          },
        });

        await this.handleTaskSecurityAfterUpdate(
          updatedTask,
          TaskStatus.COMPLETED,
        );
        this.taskSecretsService.forget(taskId);
        this.eventEmitter.emit('task.completed', { taskId });
        this.tasksGateway.emitTaskUpdate(taskId, updatedTask);
        return updatedTask;
      }

      return this.resume(taskId, addTaskMessageDto.message);
    }

    if (task.status === TaskStatus.NEEDS_HELP && security.preflight?.awaitingUserResponse) {
      return this.resume(taskId, addTaskMessageDto.message);
    }

    if (task.status === TaskStatus.NEEDS_HELP && task.control === Role.USER) {
      return this.resume(taskId, addTaskMessageDto.message);
    }

    return task;
  }

  async resume(taskId: string, latestInstruction?: string): Promise<Task> {
    this.logger.log(`Resuming task ID: ${taskId}`);

    const task = await this.findById(taskId);
    if (!task) {
      throw new NotFoundException(`Task with ID ${taskId} not found`);
    }

    if (task.control !== Role.USER) {
      throw new BadRequestException(`Task ${taskId} is not under user control`);
    }

    const security = this.getTaskSecurityState(task);
    const execution = security.execution || {};
    const normalizedInstruction = latestInstruction?.trim();
    const answeringExistingPreflight =
      security.preflight?.awaitingUserResponse === true;
    const clarifiedPreflightGoal =
      answeringExistingPreflight && normalizedInstruction
        ? `${
            security.session?.currentTurnGoal || task.description
          }\nClarification: ${normalizedInstruction}`
        : undefined;
    const shouldStartFollowUpPreflight =
      Boolean(normalizedInstruction) &&
      !this.mediaSessionService.isExplicitSessionCloseCommand(normalizedInstruction) &&
      !security.pendingConfirmation &&
      !answeringExistingPreflight &&
      (
        (task.status === TaskStatus.NEEDS_REVIEW &&
          security.session?.awaitingUserDecision === true) ||
        (task.status === TaskStatus.NEEDS_HELP && task.control === Role.USER)
      );
    const mediaPlan = execution.mediaPlan
      ? {
          ...execution.mediaPlan,
          blockedAt: undefined,
          blockReason: undefined,
        }
      : undefined;
    const updatedTask = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        control: Role.ASSISTANT,
        status: TaskStatus.RUNNING,
        result: this.mergeTaskResult(task, {
          security: this.setSessionActiveBranch(
            {
              ...security,
              pendingConfirmation: security.pendingConfirmation,
              ...(security.execution && {
                execution: {
                  ...execution,
                  blockedStep: undefined,
                  ...(mediaPlan && { mediaPlan }),
                },
              }),
              preflight: shouldStartFollowUpPreflight
                ? {
                    ...(security.preflight || {}),
                    turnId: this.createPlannerTurnId(),
                    turnKind: 'follow_up',
                    questionAsked: false,
                    questionAnswered: false,
                    executionStarted: false,
                    awaitingUserResponse: false,
                    followUpPending: true,
                    question: undefined,
                    plan: undefined,
                    planSteps: undefined,
                    askedAt: undefined,
                    confirmedAt: undefined,
                  }
                : answeringExistingPreflight
                  ? {
                      ...(security.preflight || {}),
                      questionAnswered: true,
                      executionStarted: false,
                    }
                : security.preflight,
            },
            'executing',
            {
              phase: 'active',
              lastUserInstructionAt: new Date().toISOString(),
              awaitingUserDecision: false,
              parkedAt: undefined,
              lastTerminalStatus: undefined,
              lastTerminalSummary: undefined,
              ...(clarifiedPreflightGoal && {
                currentTurnGoal: clarifiedPreflightGoal,
              }),
              ...(shouldStartFollowUpPreflight &&
                normalizedInstruction && {
                  currentTurnGoal: normalizedInstruction,
                }),
            },
          ),
        }) as Prisma.InputJsonValue,
      },
    });

    try {
      await fetch(
        `${this.configService.get<string>('BYTEBOT_DESKTOP_BASE_URL')}/input-tracking/stop`,
        { method: 'POST' },
      );
    } catch (error) {
      this.logger.error('Failed to stop input tracking', error);
    }

    // Broadcast resume event so AgentProcessor can react
    this.eventEmitter.emit('task.resume', { taskId });

    this.logger.log(`Task ${taskId} resumed`);
    this.tasksGateway.emitTaskUpdate(taskId, updatedTask);

    return updatedTask;
  }

  async takeOver(taskId: string): Promise<Task> {
    this.logger.log(`Taking over control for task ID: ${taskId}`);

    const task = await this.findById(taskId);
    if (!task) {
      throw new NotFoundException(`Task with ID ${taskId} not found`);
    }

    if (task.control !== Role.ASSISTANT) {
      throw new BadRequestException(
        `Task ${taskId} is not under agent control`,
      );
    }

    const updatedTask = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        control: Role.USER,
      },
    });

    try {
      await fetch(
        `${this.configService.get<string>('BYTEBOT_DESKTOP_BASE_URL')}/input-tracking/start`,
        { method: 'POST' },
      );
    } catch (error) {
      this.logger.error('Failed to start input tracking', error);
    }

    // Broadcast takeover event so AgentProcessor can react
    this.eventEmitter.emit('task.takeover', { taskId });

    this.logger.log(`Task ${taskId} takeover initiated`);
    this.tasksGateway.emitTaskUpdate(taskId, updatedTask);

    return updatedTask;
  }

  async cancel(taskId: string): Promise<Task> {
    this.logger.log(`Cancelling task ID: ${taskId}`);

    const task = await this.findById(taskId);
    if (!task) {
      throw new NotFoundException(`Task with ID ${taskId} not found`);
    }

    if (
      task.status === TaskStatus.COMPLETED ||
      task.status === TaskStatus.FAILED ||
      task.status === TaskStatus.CANCELLED
    ) {
      throw new BadRequestException(
        `Task ${taskId} is already completed, failed, or cancelled`,
      );
    }

    const updatedTask = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status: TaskStatus.CANCELLED,
      },
    });

    await this.handleTaskSecurityAfterUpdate(task, TaskStatus.CANCELLED);

    // Broadcast cancel event so AgentProcessor can cancel processing
    this.eventEmitter.emit('task.cancel', { taskId });

    this.logger.log(`Task ${taskId} cancelled and marked as failed`);
    this.tasksGateway.emitTaskUpdate(taskId, updatedTask);

    return updatedTask;
  }

  private async handleTaskSecurityAfterUpdate(
    task: Task,
    nextStatus: TaskStatus,
  ): Promise<void> {
    if (
      !(
        nextStatus === TaskStatus.COMPLETED ||
        nextStatus === TaskStatus.NEEDS_REVIEW ||
        nextStatus === TaskStatus.CANCELLED ||
        nextStatus === TaskStatus.FAILED
      )
    ) {
      return;
    }

    const result = (task.result || {}) as Record<string, any>;
    const security = (result.security || {}) as TaskSecurityState;
    const browserSession = security.browserSession;

    if (!browserSession) {
      return;
    }

    const terminalStatus = security.session?.lastTerminalStatus;
    if (
      (nextStatus === TaskStatus.COMPLETED ||
        (nextStatus === TaskStatus.NEEDS_REVIEW &&
          terminalStatus === 'completed')) &&
      browserSession.saveLabel
    ) {
      const normalizedBrowser =
        browserSession.browser === 'firefox' ? 'brave' : browserSession.browser;

      try {
        const savedCredential = this.taskSecretsService.get(task.id);
        if (savedCredential?.mode === 'save_for_later') {
          await this.browserSessionsService.saveCredential(
            browserSession.saveLabel,
            savedCredential,
          );
        }

        await this.browserSessionsService.saveCurrent(
          browserSession.saveLabel,
          browserSession.site,
          normalizedBrowser,
        );
      } catch (error: any) {
        this.logger.error(
          `Failed to save browser session ${browserSession.saveLabel}: ${error.message}`,
          error.stack,
        );
      }
    }

    // Do not clear the live browser profile automatically on terminal task states.
    // Allyra is expected to preserve Brave session state across ordinary task
    // completion so cookies, login state, and anti-abuse signals are not reset
    // into a fresh browser on every turn.
  }

  private getTaskSecurityState(task: Task): TaskSecurityState {
    const result = (task.result || {}) as Record<string, any>;
    const security = (result.security || {}) as TaskSecurityState;

    if (security.browserSession?.browser === 'firefox') {
      return {
        ...security,
        browserSession: {
          ...security.browserSession,
          browser: 'brave',
        },
      };
    }

    return security;
  }

  private mergeTaskResult(
    task: Task,
    patch: Record<string, unknown>,
  ): Record<string, unknown> {
    const current = (task.result || {}) as Record<string, unknown>;
    return {
      ...current,
      ...patch,
    };
  }
}

