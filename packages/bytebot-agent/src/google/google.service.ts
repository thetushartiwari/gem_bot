import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  isComputerToolUseContentBlock,
  isImageContentBlock,
  isUserActionContentBlock,
  MessageContentBlock,
  MessageContentType,
  TextContentBlock,
  ThinkingContentBlock,
  ToolUseContentBlock,
} from '@bytebot/shared';
import {
  BytebotAgentService,
  BytebotAgentInterrupt,
  BytebotAgentResponse,
} from '../agent/agent.types';
import { Message, Role } from '@prisma/client';
import { googleTools, googlePlanningTools } from './google.tools';
import {
  Content,
  GenerateContentResponse,
  GoogleGenAI,
  Part,
} from '@google/genai';
import { v4 as uuid } from 'uuid';
import { DEFAULT_MODEL } from './google.constants';

@Injectable()
export class GoogleService implements BytebotAgentService {
  private readonly google: GoogleGenAI;
  private readonly logger = new Logger(GoogleService.name);

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY');

    if (!apiKey) {
      this.logger.warn(
        'GEMINI_API_KEY is not set. GoogleService will not work properly.',
      );
    }

    this.google = new GoogleGenAI({
      apiKey: apiKey || 'dummy-key-for-initialization',
    });
  }

  async generateMessage(
    systemPrompt: string,
    messages: Message[],
    model: string = DEFAULT_MODEL.name,
    useTools: boolean = true,
    signal?: AbortSignal,
    planningMode?: boolean,
  ): Promise<BytebotAgentResponse> {
    const timeoutMs = Math.max(
      1000,
      Number(this.configService.get<string>('BYTEBOT_MODEL_TIMEOUT_MS') || 45000),
    );
    const requestAbortController = new AbortController();
    let timedOut = false;
    const onAbort = () => requestAbortController.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      requestAbortController.abort();
    }, timeoutMs);

    try {
      const maxTokens = 8192;

      const googleMessages = this.formatMessagesForGoogle(messages);

      const toolDeclarations =
        planningMode ? googlePlanningTools : googleTools;

      const response: GenerateContentResponse =
        await this.google.models.generateContent({
          model,
          contents: googleMessages,
          config: {
            thinkingConfig: {
              thinkingBudget: 24576,
            },
            maxOutputTokens: maxTokens,
            systemInstruction: systemPrompt,
            tools: useTools
              ? [
                  {
                    functionDeclarations: toolDeclarations,
                  },
                ]
              : [],
            abortSignal: requestAbortController.signal,
          },
        });

      const candidate = response.candidates?.[0];

      if (!candidate) {
        throw new Error('No candidate found in response');
      }

      const content = candidate.content;

      if (!content) {
        throw new Error(
          'The model provider returned an empty candidate response.',
        );
      }

      if (!content.parts) {
        throw new Error(
          'The model provider returned an empty content payload.',
        );
      }

      return {
        contentBlocks: this.formatGoogleResponse(content.parts),
        tokenUsage: {
          inputTokens: response.usageMetadata?.promptTokenCount || 0,
          outputTokens: response.usageMetadata?.candidatesTokenCount || 0,
          totalTokens: response.usageMetadata?.totalTokenCount || 0,
        },
      };
    } catch (error: any) {
      const errorMessage =
        typeof error?.message === 'string' ? error.message : String(error || '');
      if (
        error?.name === 'AbortError' ||
        errorMessage.includes('AbortError')
      ) {
        if (timedOut) {
          const timeoutError = new Error(
            `The model provider timed out after ${timeoutMs}ms.`,
          );
          this.logger.error(
            `Error sending message to Google Gemini: ${timeoutError.message}`,
            error.stack,
          );
          throw timeoutError;
        }
        throw new BytebotAgentInterrupt();
      }
      if (
        error?.message?.includes?.('RESOURCE_EXHAUSTED') ||
        error?.message?.includes?.('Resource has been exhausted') ||
        error?.message?.includes?.('429')
      ) {
        const capacityError = new Error(
          'The model provider is temporarily out of capacity (quota/rate limit). Please retry in a moment.',
        );
        this.logger.error(
          `Error sending message to Google Gemini: ${capacityError.message}`,
          error.stack,
        );
        throw capacityError;
      }
      this.logger.error(
        `Error sending message to Google Gemini: ${errorMessage}`,
        error.stack,
      );
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Convert our MessageContentBlock format to Google Gemini's message format
   */
  private formatMessagesForGoogle(messages: Message[]): Content[] {
    const googleMessages: Content[] = [];

    // Process each message content block
    for (const message of messages) {
      const messageContentBlocks = message.content as MessageContentBlock[];

      const parts: Part[] = [];

      if (
        messageContentBlocks.every((block) => isUserActionContentBlock(block))
      ) {
        const userActionContentBlocks = messageContentBlocks.flatMap(
          (block) => block.content,
        );
        for (const block of userActionContentBlocks) {
          if (isComputerToolUseContentBlock(block)) {
            parts.push({
              text: `User performed action: ${block.name}\n${JSON.stringify(block.input, null, 2)}`,
            });
          } else if (isImageContentBlock(block)) {
            parts.push({
              inlineData: {
                data: block.source.data,
                mimeType: block.source.media_type,
              },
            });
          }
        }
      } else {
        for (const block of messageContentBlocks) {
          switch (block.type) {
            case MessageContentType.Text:
              parts.push({
                text: block.text,
              });
              break;
            case MessageContentType.ToolUse:
              parts.push({
                functionCall: {
                  id: block.id,
                  name: block.name,
                  args: block.input,
                },
              });
              break;
            case MessageContentType.Image:
              parts.push({
                inlineData: {
                  data: block.source.data,
                  mimeType: block.source.media_type,
                },
              });
              break;
            case MessageContentType.ToolResult: {
              const textBlock = block.content.find(
                (b) => b.type === MessageContentType.Text,
              );
              const imageBlock = block.content.find(
                (b) => b.type === MessageContentType.Image,
              );

              const toolName =
                this.getToolName(block.tool_use_id, messages) ||
                'queue_desktop_plan';

              parts.push({
                functionResponse: {
                  id: block.tool_use_id,
                  name: toolName,
                  response: {
                    ...(!block.is_error && {
                      output: textBlock
                        ? (textBlock as TextContentBlock).text
                        : 'action completed',
                    }),
                    ...(block.is_error && { error: block.content[0] }),
                  },
                },
              });

              if (imageBlock) {
                parts.push({
                  inlineData: {
                    data: (imageBlock as any).source.data,
                    mimeType: (imageBlock as any).source.media_type,
                  },
                });
              }
              break;
            }
            case MessageContentType.Thinking:
              parts.push({
                text: block.thinking,
                thoughtSignature: block.signature,
                thought: true,
              });
              break;
            default:
              parts.push({
                text: JSON.stringify(block),
              });
              break;
          }
        }
      }

      googleMessages.push({
        role: message.role === Role.USER ? 'user' : 'model',
        parts: parts,
      });
    }

    return googleMessages;
  }

  // Find the content block with the tool_use_id and return the name
  private getToolName(
    tool_use_id: string,
    messages: Message[],
  ): string | undefined {
    const toolMessage = messages.find((message) =>
      (message.content as MessageContentBlock[]).some(
        (block) =>
          block.type === MessageContentType.ToolUse && block.id === tool_use_id,
      ),
    );
    if (!toolMessage) {
      return undefined;
    }

    const toolBlock = (toolMessage.content as MessageContentBlock[]).find(
      (block) =>
        block.type === MessageContentType.ToolUse && block.id === tool_use_id,
    );
    if (!toolBlock) {
      return undefined;
    }
    return (toolBlock as ToolUseContentBlock).name;
  }

  /**
   * Convert Google Gemini's response content to our MessageContentBlock format
   */
  private formatGoogleResponse(parts: Part[]): MessageContentBlock[] {
    return parts.map((part) => {
      if (part.text) {
        return {
          type: MessageContentType.Text,
          text: part.text,
        } as TextContentBlock;
      }

      if (part.thought) {
        return {
          type: MessageContentType.Thinking,
          signature: part.thoughtSignature,
          thinking: part.text,
        } as ThinkingContentBlock;
      }

      if (part.functionCall) {
        return {
          type: MessageContentType.ToolUse,
          id: part.functionCall.id || uuid(),
          name: part.functionCall.name,
          input: part.functionCall.args,
        } as ToolUseContentBlock;
      }

      this.logger.warn(`Unknown content type from Google: ${part}`);
      return {
        type: MessageContentType.Text,
        text: JSON.stringify(part),
      } as TextContentBlock;
    });
  }
}
