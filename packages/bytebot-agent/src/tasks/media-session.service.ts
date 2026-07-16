import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';
import { Prisma, Task } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TaskSecurityState, TaskUsageState } from './task-security.types';
import { mergeTaskUsage } from './task-usage.utils';

const BYTEBOT_DESKTOP_BASE_URL = process.env.BYTEBOT_DESKTOP_BASE_URL as string;

type AudioReadResult = {
  data: string;
  mediaType?: string;
  name?: string;
  size?: number;
};

type ExportedAudioChunk = {
  index: number;
  filePath: string;
  name: string;
  sizeBytes: number;
  format: 'wav' | 'flac';
};

type MediaFinalizeResult = {
  media?: NonNullable<TaskSecurityState['media']>;
  transcriptText?: string;
  conciseSummary?: string;
  detailedSummary?: string;
};

@Injectable()
export class MediaSessionService {
  private readonly logger = new Logger(MediaSessionService.name);
  private readonly google?: GoogleGenAI;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY');
    if (apiKey) {
      this.google = new GoogleGenAI({ apiKey });
    }
  }

  isExplicitSessionCloseCommand(message?: string | null): boolean {
    const normalized = (message || '')
      .trim()
      .toLowerCase()
      .replace(/[.!?,;:]+$/g, '');
    if (!normalized) {
      return false;
    }

    const exactCloseCommands = new Set([
      'done',
      'complete',
      'completed',
      'finish',
      'finished',
      'close',
      'close task',
      'end',
      'end task',
      'stop',
      'stop now',
      'we are done',
      "that's all",
      'that is all',
      'all done',
    ]);

    if (exactCloseCommands.has(normalized)) {
      return true;
    }

    return /^(please\s+)?(close|end|stop|complete|finish)\s+(this\s+)?(task|session)(\s+now)?$/i.test(
      normalized,
    );
  }

  async maybeStartRecording(
    taskId: string,
    task: Task,
    security: TaskSecurityState,
    options?: {
      currentAudioHasSignal?: boolean;
      currentPlaybackLikelyActive?: boolean;
    },
  ): Promise<NonNullable<TaskSecurityState['media']> | undefined> {
    const media = security.media;
    if (
      !media?.selectedAt ||
      (!media.transcriptRequested && !media.summaryRequested)
    ) {
      return media;
    }

    const eligibleEarlyAudioStart =
      (options?.currentAudioHasSignal === true ||
        !!media.audioMonitoring?.lastAudibleAt ||
        options?.currentPlaybackLikelyActive === true) &&
      media.phase !== 'ended' &&
      media.phase !== 'follow_on_detected' &&
      !media.completionLatchedAt;
    if (
      (!media.playbackVerifiedAt && !eligibleEarlyAudioStart) ||
      media.recordingStoppedAt ||
      media.completionLatchedAt
    ) {
      return media;
    }

    if (media.recordingStartedAt) {
      return media;
    }

    const nextMedia = media;

    try {
      const response = await fetch(`${BYTEBOT_DESKTOP_BASE_URL}/computer-use`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'audio_record_start',
          format: 'flac',
          purpose: `${media.kind || 'media'} task ${taskId}: ${task.description.slice(0, 120)}`,
        }),
      });

      if (!response.ok) {
        throw new Error(
          `desktop responded ${response.status} ${response.statusText}`,
        );
      }

      const payload = (await response.json()) as {
        success: boolean;
        filePath?: string;
        source?: string;
        startedAt?: string;
        format?: 'wav' | 'flac';
      };

      if (!payload.success || !payload.filePath) {
        throw new Error('desktop did not return a recording file path');
      }

      this.logger.log(
        `Started media recording for task ${taskId} at ${payload.filePath}`,
      );

      return {
        ...nextMedia,
        phase: 'recording',
        recordingStartedAt: payload.startedAt || new Date().toISOString(),
        recordingFilePath: payload.filePath,
        recordingSource: payload.source,
        recordingFormat: payload.format || 'flac',
        transcriptionStatus: 'recording',
        transcriptionError: undefined,
      };
    } catch (error: any) {
      this.logger.error(
        `Failed to start media recording for task ${taskId}: ${error.message}`,
        error.stack,
      );
      return {
        ...nextMedia,
        transcriptionStatus: 'failed',
        transcriptionError: `Recording could not start: ${error.message}`,
      };
    }
  }

  async finalizeMediaSession(
    taskId: string,
    task: Task,
    security: TaskSecurityState,
  ): Promise<MediaFinalizeResult> {
    const media = security.media;
    if (
      !media?.selectedAt ||
      (!media.transcriptRequested && !media.summaryRequested)
    ) {
      return { media };
    }

    if (media.transcriptionStatus === 'ready') {
      return {
        media,
        transcriptText: media.transcriptText,
        conciseSummary: media.conciseSummary,
        detailedSummary: media.detailedSummary,
      };
    }

    const hasRecordedPlaybackEvidence =
      !!media.recordingStartedAt &&
      (
        !!media.recordingStoppedAt ||
        !!media.recordingFilePath ||
        !!media.audioMonitoring?.lastAudibleAt
      );

    // Do not finalize transcript/summary work before playback was ever verified
    // unless we have already captured real recording evidence from the media
    // session. Otherwise transcript errors are misleading for tasks that never
    // got past the opening phase.
    if (
      (!media.playbackVerifiedAt && !hasRecordedPlaybackEvidence) ||
      (media.phase === 'opening' && !hasRecordedPlaybackEvidence)
    ) {
      return { media };
    }

    let nextMedia: NonNullable<TaskSecurityState['media']> = {
      ...media,
      phase: media.recordingStartedAt ? 'transcribing' : 'ended',
      transcriptionStatus: media.recordingStartedAt ? 'transcribing' : 'unavailable',
    };

    try {
      const stopPayload = await this.stopRecordingIfNeeded(nextMedia);
      nextMedia = {
        ...nextMedia,
        ...(stopPayload.startedAt && { recordingStartedAt: stopPayload.startedAt }),
        ...(stopPayload.stoppedAt && { recordingStoppedAt: stopPayload.stoppedAt }),
        ...(stopPayload.filePath && { recordingFilePath: stopPayload.filePath }),
        ...(stopPayload.source && { recordingSource: stopPayload.source }),
        ...(stopPayload.format && { recordingFormat: stopPayload.format }),
      };

      if (!stopPayload.filePath) {
        return {
          media: {
            ...nextMedia,
            phase: 'ended',
            transcriptionStatus: 'unavailable',
            transcriptionError:
              stopPayload.message ||
              'No audio was captured, so no transcript could be created.',
          },
        };
      }

      const transcriptResult = await this.transcribeAndSummarizeRecording(
        taskId,
        task.description,
        stopPayload.filePath,
        stopPayload.sizeBytes,
      );

      return {
        media: {
          ...nextMedia,
          phase: 'summarizing',
          transcriptionStatus: 'ready',
          transcriptText: transcriptResult.transcriptText,
          conciseSummary: transcriptResult.conciseSummary,
          detailedSummary: transcriptResult.detailedSummary,
          transcriptionError: undefined,
        },
        transcriptText: transcriptResult.transcriptText,
        conciseSummary: transcriptResult.conciseSummary,
        detailedSummary: transcriptResult.detailedSummary,
      };
    } catch (error: any) {
      this.logger.error(
        `Failed to finalize media session for task ${taskId}: ${error.message}`,
        error.stack,
      );
      return {
        media: {
          ...nextMedia,
          phase: 'ended',
          transcriptionStatus: 'failed',
          transcriptionError: error.message,
        },
      };
    }
  }

  private async stopRecordingIfNeeded(
    media: NonNullable<TaskSecurityState['media']>,
  ): Promise<{
    message?: string;
    filePath?: string;
    startedAt?: string;
    stoppedAt?: string;
    sizeBytes?: number;
    source?: string;
    format?: 'wav' | 'flac';
  }> {
    if (media.recordingStoppedAt && media.recordingFilePath) {
      return {
        filePath: media.recordingFilePath,
        startedAt: media.recordingStartedAt,
        stoppedAt: media.recordingStoppedAt,
        source: media.recordingSource,
        format: media.recordingFormat,
      };
    }

    if (!media.recordingStartedAt) {
      return {
        message: 'No audio recording was started for this task.',
      };
    }

    const response = await fetch(`${BYTEBOT_DESKTOP_BASE_URL}/computer-use`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'audio_record_stop',
      }),
    });

    if (!response.ok) {
      throw new Error(
        `desktop responded ${response.status} ${response.statusText} while stopping recording`,
      );
    }

    return (await response.json()) as {
      message?: string;
      filePath?: string;
      startedAt?: string;
      stoppedAt?: string;
      sizeBytes?: number;
      source?: string;
      format?: 'wav' | 'flac';
    };
  }

  private async stopLiveRecordingSilently(taskId: string): Promise<void> {
    try {
      const response = await fetch(`${BYTEBOT_DESKTOP_BASE_URL}/computer-use`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'audio_record_stop',
        }),
      });

      if (!response.ok) {
        throw new Error(
          `desktop responded ${response.status} ${response.statusText} while stopping recording`,
        );
      }
    } catch (error: any) {
      this.logger.warn(
        `Failed to stop live recording cleanly for task ${taskId} before restarting it: ${error.message}`,
      );
    }
  }

  private async readAudioFile(filePath: string): Promise<AudioReadResult> {
    const response = await fetch(`${BYTEBOT_DESKTOP_BASE_URL}/computer-use`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'read_file',
        path: filePath,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `desktop responded ${response.status} ${response.statusText} while reading recorded audio`,
      );
    }

    const payload = (await response.json()) as {
      success: boolean;
      data?: string;
      mediaType?: string;
      name?: string;
      size?: number;
      message?: string;
    };

    if (!payload.success || !payload.data) {
      throw new Error(payload.message || 'desktop did not return audio data');
    }

    return {
      data: payload.data,
      mediaType: payload.mediaType,
      name: payload.name,
      size: payload.size,
    };
  }

  private async transcribeAndSummarizeRecording(
    taskId: string,
    taskDescription: string,
    filePath: string,
    fileSizeBytes?: number,
  ): Promise<{
    transcriptText: string;
    conciseSummary: string;
    detailedSummary: string;
  }> {
    const transcriptBundle = await this.transcribeRecordingToTranscript(
      taskId,
      taskDescription,
      filePath,
      fileSizeBytes,
    );
    const summary = await this.summarizeTranscriptText(
      taskId,
      taskDescription,
      transcriptBundle.transcriptText,
      transcriptBundle.chunkSummaries,
    );

    return {
      transcriptText: transcriptBundle.transcriptText,
      conciseSummary: summary.conciseSummary,
      detailedSummary: summary.detailedSummary,
    };
  }

  private async transcribeRecordingToTranscript(
    taskId: string,
    taskDescription: string,
    filePath: string,
    fileSizeBytes?: number,
  ): Promise<{
    transcriptText: string;
    chunkSummaries: string[];
  }> {
    const inlineLimit = this.getInlineTranscriptionLimitBytes();
    if (fileSizeBytes && fileSizeBytes <= inlineLimit) {
      const audioFile = await this.readAudioFile(filePath);
      return this.transcribeSingleAudioInput(taskId, taskDescription, audioFile);
    }

    if (!fileSizeBytes) {
      const audioFile = await this.readAudioFile(filePath);
      if (!audioFile.size || audioFile.size <= inlineLimit) {
        return this.transcribeSingleAudioInput(taskId, taskDescription, audioFile);
      }
    }

    return this.transcribeChunkedAudio(taskId, taskDescription, filePath);
  }

  private async transcribeSingleAudioInput(
    taskId: string,
    taskDescription: string,
    audioFile: AudioReadResult,
  ): Promise<{
    transcriptText: string;
    chunkSummaries: string[];
  }> {
    if (!this.google) {
      throw new Error(
        'No Gemini API key is configured, so audio transcription is unavailable.',
      );
    }

    const response = await this.google.models.generateContent({
      model: this.getMediaTranscriptionModel(),
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `You are transcribing recorded media audio for a desktop agent task.\nTask: ${taskDescription}\n\nReturn strict JSON with this shape:\n{"transcript":"...","chunkSummary":"..."}\n\nRules:\n- transcript: best-effort transcript of what was heard from the requested media or meeting only. If the audio is music or lyrics are unclear, provide the best partial transcript you can and mention uncertainty inside the transcript text.\n- chunkSummary: 1-3 sentences capturing the important content, discussion, or mood of the requested media or meeting only.\n- Ignore pre-roll ads, sponsor spots, autoplay follow-on media, unrelated music, and incidental system audio.\n- If this audio is mostly unrelated ad or follow-on content instead of the requested media or meeting, set transcript to an empty string and say that in chunkSummary.\n- Do not wrap the JSON in markdown.`,
            },
            {
              inlineData: {
                data: audioFile.data,
                mimeType: this.resolveAudioMimeType(audioFile),
              },
            },
          ],
        },
      ],
    });
    await this.recordGeminiUsage(
      taskId,
      this.getMediaTranscriptionModel(),
      response,
      'media_transcription',
    );

    const rawText =
      response.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || '')
        .join('\n')
        .trim() || '';

    const parsed = this.parseChunkTranscriptionResponse(rawText);
    return (
      parsed || {
        transcriptText: rawText || 'No transcript could be extracted.',
        chunkSummaries: rawText ? [rawText] : [],
      }
    );
  }

  private async transcribeChunkedAudio(
    taskId: string,
    taskDescription: string,
    filePath: string,
  ): Promise<{
    transcriptText: string;
    chunkSummaries: string[];
  }> {
    const chunks = await this.exportAudioChunks(filePath);
    const transcripts: string[] = [];
    const chunkSummaries: string[] = [];

    for (const chunk of chunks) {
      const audioFile = await this.readAudioFile(chunk.filePath);
      const result = await this.transcribeAudioChunk(
        taskId,
        taskDescription,
        audioFile,
        chunk.index,
        chunks.length,
      );
      if (result.transcriptText) {
        transcripts.push(result.transcriptText);
      }
      if (result.chunkSummary) {
        chunkSummaries.push(`Chunk ${chunk.index + 1}: ${result.chunkSummary}`);
      }
    }

    const mergedTranscript = transcripts.join('\n\n').trim();
    if (!mergedTranscript && chunkSummaries.length === 0) {
      throw new Error(
        'Gemini did not return a usable transcript for any audio chunk.',
      );
    }

    return {
      transcriptText: mergedTranscript || chunkSummaries.join('\n'),
      chunkSummaries,
    };
  }

  private async transcribeAudioChunk(
    taskId: string,
    taskDescription: string,
    audioFile: AudioReadResult,
    chunkIndex: number,
    totalChunks: number,
  ): Promise<{
    transcriptText: string;
    chunkSummary?: string;
  }> {
    if (!this.google) {
      throw new Error(
        'No Gemini API key is configured, so audio transcription is unavailable.',
      );
    }

    const response = await this.google.models.generateContent({
      model: this.getMediaTranscriptionModel(),
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `You are transcribing one chunk of recorded media audio for a desktop agent task.\nTask: ${taskDescription}\nChunk: ${chunkIndex + 1} of ${totalChunks}\n\nReturn strict JSON with this shape:\n{"transcript":"...","chunkSummary":"..."}\n\nRules:\n- transcript: best-effort transcript of only this chunk from the requested media or meeting.\n- chunkSummary: 1-2 sentences summarizing this chunk only.\n- If this chunk is mostly music or unclear audio, still provide the best partial transcript and mention uncertainty.\n- Ignore pre-roll ads, sponsor spots, autoplay follow-on media, unrelated music, and incidental system audio.\n- If this chunk is mostly unrelated ad or follow-on content, set transcript to an empty string and say that in chunkSummary.\n- Do not wrap the JSON in markdown.`,
            },
            {
              inlineData: {
                data: audioFile.data,
                mimeType: this.resolveAudioMimeType(audioFile),
              },
            },
          ],
        },
      ],
    });
    await this.recordGeminiUsage(
      taskId,
      this.getMediaTranscriptionModel(),
      response,
      'media_transcription_chunk',
    );

    const rawText =
      response.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || '')
        .join('\n')
        .trim() || '';

    const parsed = this.parseChunkTranscriptionResponse(rawText);
    if (parsed) {
      return {
        transcriptText: parsed.transcriptText,
        chunkSummary: parsed.chunkSummaries[0],
      };
    }

    return {
      transcriptText: rawText || '',
      chunkSummary: rawText || undefined,
    };
  }

  private async summarizeTranscriptText(
    taskId: string,
    taskDescription: string,
    transcriptText: string,
    chunkSummaries: string[],
  ): Promise<{
    conciseSummary: string;
    detailedSummary: string;
  }> {
    if (!this.google) {
      throw new Error(
        'No Gemini API key is configured, so media summarization is unavailable.',
      );
    }

    const maxTranscriptChars = this.getTranscriptSummaryInputLimitChars();
    const useTranscriptDirectly =
      transcriptText.length > 0 && transcriptText.length <= maxTranscriptChars;

    const summaryInput = useTranscriptDirectly
      ? `Transcript:\n${transcriptText}`
      : `Chunk summaries:\n${chunkSummaries.join('\n')}\n\nTranscript excerpt:\n${transcriptText.slice(0, Math.min(6000, transcriptText.length))}`;

    const response = await this.google.models.generateContent({
      model: this.getMediaSummaryModel(),
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `You are summarizing recorded media audio for a desktop agent task.\nTask: ${taskDescription}\n\nUse the material below and return strict JSON with this shape:\n{"conciseSummary":"...","detailedSummary":"..."}\n\nRules:\n- conciseSummary: 2-4 sentences.\n- detailedSummary: one detailed paragraph with the important content, discussion points, mood, or themes.\n- Summarize only the requested media or meeting content. Ignore pre-roll ads, sponsor spots, autoplay follow-on media, and unrelated audio before or after the requested content.\n- If the requested media or meeting never became the dominant captured audio, say that clearly instead of summarizing the unrelated audio.\n- If the source audio seems to be a song or music video, mention that clearly instead of inventing spoken discussion.\n- If the transcript is partial or uncertain, reflect that uncertainty instead of hallucinating.\n- Do not wrap the JSON in markdown.\n\n${summaryInput}`,
            },
          ],
        },
      ],
    });
    await this.recordGeminiUsage(
      taskId,
      this.getMediaSummaryModel(),
      response,
      'media_summary',
    );

    const rawText =
      response.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || '')
        .join('\n')
        .trim() || '';

    const parsed = this.parseSummaryResponse(rawText);
    return (
      parsed || {
        conciseSummary: rawText || 'No concise summary could be generated.',
        detailedSummary: rawText || 'No detailed summary could be generated.',
      }
    );
  }

  private async exportAudioChunks(
    filePath: string,
  ): Promise<ExportedAudioChunk[]> {
    const response = await fetch(`${BYTEBOT_DESKTOP_BASE_URL}/computer-use`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'audio_chunk_export',
        path: filePath,
        chunkDurationSeconds: this.getTranscriptionChunkDurationSeconds(),
        format: 'flac',
        maxChunks: this.getMaxTranscriptionChunks(),
      }),
    });

    if (!response.ok) {
      throw new Error(
        `desktop responded ${response.status} ${response.statusText} while exporting audio chunks`,
      );
    }

    const payload = (await response.json()) as {
      success: boolean;
      message?: string;
      chunks?: ExportedAudioChunk[];
    };

    if (!payload.success || !payload.chunks?.length) {
      throw new Error(
        payload.message || 'desktop did not return any exported audio chunks',
      );
    }

    this.logger.log(
      `Exported ${payload.chunks.length} audio chunk(s) for Gemini transcription`,
    );

    return payload.chunks;
  }

  private parseChunkTranscriptionResponse(rawText: string): {
    transcriptText: string;
    chunkSummaries: string[];
  } | null {
    const parsed = this.parseJsonObject(rawText) as
      | {
          transcript?: string;
          chunkSummary?: string;
        }
      | null;

    if (!parsed || typeof parsed.transcript !== 'string') {
      return null;
    }

    return {
      transcriptText: parsed.transcript.trim(),
      chunkSummaries:
        typeof parsed.chunkSummary === 'string' && parsed.chunkSummary.trim()
          ? [parsed.chunkSummary.trim()]
          : [],
    };
  }

  private parseSummaryResponse(rawText: string): {
    conciseSummary: string;
    detailedSummary: string;
  } | null {
    const parsed = this.parseJsonObject(rawText) as
      | {
          conciseSummary?: string;
          detailedSummary?: string;
        }
      | null;

    if (
      !parsed ||
      typeof parsed.conciseSummary !== 'string' ||
      typeof parsed.detailedSummary !== 'string'
    ) {
      return null;
    }

    return {
      conciseSummary: parsed.conciseSummary.trim(),
      detailedSummary: parsed.detailedSummary.trim(),
    };
  }

  private parseJsonObject(rawText: string): Record<string, unknown> | null {
    const normalized = rawText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const start = normalized.indexOf('{');
    const end = normalized.lastIndexOf('}');
    const candidates = [normalized];
    if (start !== -1 && end !== -1 && end > start) {
      candidates.push(normalized.slice(start, end + 1));
    }

    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate) as Record<string, unknown>;
      } catch {
        // try the next candidate
      }
    }

    return null;
  }

  private getMediaTranscriptionModel(): string {
    return (
      this.configService.get<string>('MEDIA_TRANSCRIPTION_MODEL') ||
      'gemini-2.5-flash'
    );
  }

  private getMediaSummaryModel(): string {
    return (
      this.configService.get<string>('MEDIA_SUMMARY_MODEL') ||
      this.getMediaTranscriptionModel()
    );
  }

  private getInlineTranscriptionLimitBytes(): number {
    return Number(
      this.configService.get<string>('MEDIA_TRANSCRIPTION_INLINE_MAX_BYTES') ||
        15 * 1024 * 1024,
    );
  }

  private getTranscriptionChunkDurationSeconds(): number {
    return Number(
      this.configService.get<string>('MEDIA_TRANSCRIPTION_CHUNK_SECONDS') ||
        480,
    );
  }

  private getMaxTranscriptionChunks(): number {
    return Number(
      this.configService.get<string>('MEDIA_TRANSCRIPTION_MAX_CHUNKS') || 24,
    );
  }

  private getTranscriptSummaryInputLimitChars(): number {
    return Number(
      this.configService.get<string>('MEDIA_SUMMARY_TRANSCRIPT_MAX_CHARS') ||
        60000,
    );
  }

  private inferAudioMimeType(fileName?: string): string {
    const normalized = (fileName || '').toLowerCase();
    if (normalized.endsWith('.flac')) {
      return 'audio/flac';
    }
    if (normalized.endsWith('.mp3')) {
      return 'audio/mpeg';
    }
    return 'audio/wav';
  }

  private resolveAudioMimeType(audioFile: AudioReadResult): string {
    const declared = (audioFile.mediaType || '').trim().toLowerCase();
    if (declared && declared !== 'application/octet-stream') {
      return declared;
    }

    return this.inferAudioMimeType(audioFile.name);
  }

  private async recordGeminiUsage(
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
}
