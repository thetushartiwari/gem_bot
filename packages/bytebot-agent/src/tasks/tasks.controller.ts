import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  HttpStatus,
  HttpCode,
  Query,
  HttpException,
  BadRequestException,
} from '@nestjs/common';
import { TasksService } from './tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { Message, Task } from '@prisma/client';
import { AddTaskMessageDto } from './dto/add-task-message.dto';
import { MessagesService } from '../messages/messages.service';
import { ANTHROPIC_MODELS } from '../anthropic/anthropic.constants';
import { OPENAI_MODELS } from '../openai/openai.constants';
import { GOOGLE_MODELS } from '../google/google.constants';
import { BytebotAgentModel } from 'src/agent/agent.types';
import { TaskSecretsService } from './task-secrets.service';
import { BrowserSessionsService } from './browser-sessions.service';
import { SecureCredentialDto } from './dto/create-task.dto';
import { BrowserSessionRestoreReason } from './task-security.types';

const geminiApiKey = process.env.GEMINI_API_KEY;
const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
const openaiApiKey = process.env.OPENAI_API_KEY;

const proxyUrl = process.env.BYTEBOT_LLM_PROXY_URL;

const models = [
  ...(anthropicApiKey ? ANTHROPIC_MODELS : []),
  ...(openaiApiKey ? OPENAI_MODELS : []),
  ...(geminiApiKey ? GOOGLE_MODELS : []),
];

@Controller('tasks')
export class TasksController {
  constructor(
    private readonly tasksService: TasksService,
    private readonly messagesService: MessagesService,
    private readonly taskSecretsService: TaskSecretsService,
    private readonly browserSessionsService: BrowserSessionsService,
  ) {}

  // Restore saved auth/session state only for tasks that clearly target an
  // existing signed-in surface or an explicit sign-in flow.
  private classifySavedAuthIntent(description: string):
    | {
        mode: 'explicit_auth' | 'open_existing_account_surface';
        restoreReason: BrowserSessionRestoreReason;
      }
    | null {
    const normalized = description.toLowerCase().trim();
    const explicitAuthTask =
      /\b(sign in|signin|sign-in|log in|login|authenticate|complete sign[- ]in|continue sign[- ]in)\b/.test(
        normalized,
      ) ||
      /\b(open|go to|continue to)\b.{0,30}\b(gmail|outlook|hotmail|teams|google meet|meet|calendar|drive|github)\b/.test(
        normalized,
      );
    if (explicitAuthTask) {
      return {
        mode: 'explicit_auth',
        restoreReason: 'inferred_auth',
      };
    }

    const openExistingAccountSurfaceTask =
      /\b(open|check|review|continue|resume|look at|go to)\b.{0,40}\b(inbox|mailbox|account|calendar|drive|teams|meet|messages|dm|chat)\b/.test(
        normalized,
      ) ||
      /\b(open|check|review|continue|resume|look at|go to)\b.{0,30}\b(gmail|outlook|hotmail|teams|google meet|meet|calendar|drive|github)\b/.test(
        normalized,
      );

    if (openExistingAccountSurfaceTask) {
      return {
        mode: 'open_existing_account_surface',
        restoreReason: 'inferred_open_session',
      };
    }

    return null;
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() createTaskDto: CreateTaskDto): Promise<Task> {
    const normalizedDescription =
      createTaskDto.description?.trim() || createTaskDto.task?.trim();

    if (!normalizedDescription) {
      throw new BadRequestException(
        'Task description is required. Provide either "description" or "task".',
      );
    }

    let autoResolvedSavedBrowserSession = createTaskDto.savedBrowserSession;
    let autoResolvedCredentialLabel: string | null = null;
    let savedBrowserSessionRestoreReason =
      createTaskDto.savedBrowserSessionRestoreReason ||
      (createTaskDto.savedBrowserSession ? 'explicit' : undefined);
    const savedAuthIntent = this.classifySavedAuthIntent(normalizedDescription);
    const savedAuthResolutionMode =
      savedAuthIntent?.mode || 'generic_browser_task';

    if (
      !createTaskDto.secureCredential &&
      !createTaskDto.savedBrowserSession
    ) {
      const resolvedSavedAuth =
        await this.browserSessionsService.resolveSavedAuthForTask(
          normalizedDescription,
          undefined,
          savedAuthResolutionMode,
        );
      if (resolvedSavedAuth) {
        if (resolvedSavedAuth.hasBrowserSession) {
          autoResolvedSavedBrowserSession = {
            label: resolvedSavedAuth.label,
            site: resolvedSavedAuth.site,
            browser: resolvedSavedAuth.browser,
          };
          savedBrowserSessionRestoreReason =
            savedAuthIntent?.restoreReason || 'inferred_open_session';
        }
        if (savedAuthIntent && resolvedSavedAuth.hasCredential) {
          autoResolvedCredentialLabel = resolvedSavedAuth.label;
        }
      }
    }

    const normalizedCreateTaskDto: CreateTaskDto = {
      ...createTaskDto,
      description: normalizedDescription,
      ...(autoResolvedSavedBrowserSession && {
        savedBrowserSession: autoResolvedSavedBrowserSession,
      }),
      ...(savedBrowserSessionRestoreReason && {
        savedBrowserSessionRestoreReason,
      }),
    };

    const task = await this.tasksService.create(normalizedCreateTaskDto);

    if (normalizedCreateTaskDto.secureCredential) {
      this.taskSecretsService.save(task.id, normalizedCreateTaskDto.secureCredential);
      if (
        normalizedCreateTaskDto.secureCredential.mode === 'save_for_later' &&
        normalizedCreateTaskDto.secureCredential.sessionLabel
      ) {
        await this.browserSessionsService.saveCredential(
          normalizedCreateTaskDto.secureCredential.sessionLabel,
          normalizedCreateTaskDto.secureCredential,
        );
      }
    } else if (normalizedCreateTaskDto.savedBrowserSession?.label) {
      const savedCredential = await this.browserSessionsService.loadCredential(
        normalizedCreateTaskDto.savedBrowserSession.label,
      );
      if (savedCredential) {
        this.taskSecretsService.save(task.id, savedCredential);
      }
    } else if (autoResolvedCredentialLabel) {
      const savedCredential = await this.browserSessionsService.loadCredential(
        autoResolvedCredentialLabel,
      );
      if (savedCredential) {
        this.taskSecretsService.save(task.id, savedCredential);
      }
    }

    return task;
  }

  @Get('browser-sessions')
  async listBrowserSessions() {
    return this.browserSessionsService.list();
  }

  @Post('browser-sessions/credentials')
  @HttpCode(HttpStatus.CREATED)
  async saveBrowserCredential(
    @Body() secureCredentialDto: SecureCredentialDto,
  ): Promise<{ label: string; site: string }> {
    const site = secureCredentialDto.site?.trim();
    if (!site) {
      throw new BadRequestException('Site is required to save credentials.');
    }

    if (!secureCredentialDto.username?.trim() && !secureCredentialDto.password?.trim()) {
      throw new BadRequestException(
        'Provide at least a username or password to save credentials.',
      );
    }

    const label =
      secureCredentialDto.sessionLabel?.trim() || site || 'saved-session';

    await this.browserSessionsService.saveCredential(label, {
      site,
      ...(secureCredentialDto.username?.trim() && {
        username: secureCredentialDto.username.trim(),
      }),
      ...(secureCredentialDto.password?.trim() && {
        password: secureCredentialDto.password.trim(),
      }),
      mode: 'save_for_later',
      sessionLabel: label,
    });

    return { label, site };
  }

  @Delete('browser-sessions/:label')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteBrowserSession(@Param('label') label: string): Promise<void> {
    const deleted = await this.browserSessionsService.delete(label);
    if (!deleted) {
      throw new HttpException(
        `Saved browser session "${label}" not found`,
        HttpStatus.NOT_FOUND,
      );
    }
  }

  @Get()
  async findAll(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('statuses') statuses?: string,
  ): Promise<{ tasks: Task[]; total: number; totalPages: number }> {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;

    // Handle both single status and multiple statuses
    let statusFilter: string[] | undefined;
    if (statuses) {
      statusFilter = statuses.split(',');
    } else if (status) {
      statusFilter = [status];
    }

    return this.tasksService.findAll(pageNum, limitNum, statusFilter);
  }

  @Get('models')
  async getModels() {
    if (proxyUrl) {
      try {
        const response = await fetch(`${proxyUrl}/model/info`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          },
        });

        if (!response.ok) {
          throw new HttpException(
            `Failed to fetch models from proxy: ${response.statusText}`,
            HttpStatus.BAD_GATEWAY,
          );
        }

        const proxyModels = await response.json();

        // Map proxy response to BytebotAgentModel format
        const models: BytebotAgentModel[] = proxyModels.data.map(
          (model: any) => ({
            provider: 'proxy',
            name: model.litellm_params.model,
            title: model.model_name,
            contextWindow: 128000,
          }),
        );

        return models;
      } catch (error) {
        if (error instanceof HttpException) {
          throw error;
        }
        throw new HttpException(
          `Error fetching models: ${error.message}`,
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
    }
    return models;
  }

  @Get(':id')
  async findById(@Param('id') id: string): Promise<Task> {
    return this.tasksService.findById(id);
  }

  @Get(':id/messages')
  async taskMessages(
    @Param('id') taskId: string,
    @Query('limit') limit?: string,
    @Query('page') page?: string,
  ): Promise<Message[]> {
    const options = {
      limit: limit ? parseInt(limit, 10) : undefined,
      page: page ? parseInt(page, 10) : undefined,
    };

    const messages = await this.messagesService.findAll(taskId, options);
    return messages;
  }

  @Post(':id/messages')
  @HttpCode(HttpStatus.CREATED)
  async addTaskMessage(
    @Param('id') taskId: string,
    @Body() guideTaskDto: AddTaskMessageDto,
  ): Promise<Task> {
    const normalizedMessage =
      guideTaskDto.message?.trim() || guideTaskDto.content?.trim();

    if (!normalizedMessage) {
      throw new BadRequestException(
        'Message text is required. Provide either "message" or "content".',
      );
    }

    return this.tasksService.addTaskMessage(taskId, {
      ...guideTaskDto,
      message: normalizedMessage,
    });
  }

  @Get(':id/messages/raw')
  async taskRawMessages(
    @Param('id') taskId: string,
    @Query('limit') limit?: string,
    @Query('page') page?: string,
  ): Promise<Message[]> {
    const options = {
      limit: limit ? parseInt(limit, 10) : undefined,
      page: page ? parseInt(page, 10) : undefined,
    };

    return this.messagesService.findRawMessages(taskId, options);
  }

  @Get(':id/messages/processed')
  async taskProcessedMessages(
    @Param('id') taskId: string,
    @Query('limit') limit?: string,
    @Query('page') page?: string,
  ) {
    const options = {
      limit: limit ? parseInt(limit, 10) : undefined,
      page: page ? parseInt(page, 10) : undefined,
    };

    return this.messagesService.findProcessedMessages(taskId, options);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Param('id') id: string): Promise<void> {
    await this.tasksService.delete(id);
  }

  @Post(':id/takeover')
  @HttpCode(HttpStatus.OK)
  async takeOver(@Param('id') taskId: string): Promise<Task> {
    return this.tasksService.takeOver(taskId);
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  async resume(@Param('id') taskId: string): Promise<Task> {
    return this.tasksService.resume(taskId);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(@Param('id') taskId: string): Promise<Task> {
    return this.tasksService.cancel(taskId);
  }
}
