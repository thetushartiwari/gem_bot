import {
  Controller,
  Post,
  Body,
  Logger,
  HttpException,
  HttpStatus,
  Get,
  Req,
  Res,
} from '@nestjs/common';
import { ComputerUseService } from './computer-use.service';
import { ComputerActionValidationPipe } from './dto/computer-action-validation.pipe';
import { ComputerActionDto } from './dto/computer-action.dto';
import { Request, Response } from 'express';

@Controller('computer-use')
export class ComputerUseController {
  private readonly logger = new Logger(ComputerUseController.name);

  constructor(private readonly computerUseService: ComputerUseService) {}

  @Get('audio/live')
  liveAudio(@Req() req: Request, @Res() res: Response): void {
    const audioProcess = this.computerUseService.createLiveAudioStream();
    let stderr = '';

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    audioProcess.stdout?.pipe(res);
    audioProcess.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const cleanup = () => {
      if (!audioProcess.killed) {
        audioProcess.kill('SIGTERM');
      }
      if (!res.writableEnded) {
        res.end();
      }
    };

    req.on('close', cleanup);
    res.on('close', cleanup);

    audioProcess.once('error', (error) => {
      this.logger.error(
        `Desktop audio stream failed to start: ${error.message}`,
        error.stack,
      );
      if (!res.headersSent) {
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
          message: `Failed to start desktop audio stream: ${error.message}`,
        });
      } else {
        cleanup();
      }
    });

    audioProcess.once('exit', (code) => {
      if (code && !res.writableEnded) {
        this.logger.warn(
          `Desktop audio stream exited with code ${code}: ${stderr || 'no stderr output'}`,
        );
      }
      cleanup();
    });
  }

  @Get('audio/status')
  async audioStatus() {
    return this.computerUseService.audioLiveStatus();
  }

  @Get('media/session')
  async mediaSession() {
    return this.computerUseService.mediaSessionState();
  }

  @Post()
  async action(
    @Body(new ComputerActionValidationPipe()) params: ComputerActionDto,
  ) {
    try {
      // don't log base64 data
      const paramsCopy = { ...params };
      if (paramsCopy.action === 'write_file') {
        paramsCopy.data = 'base64 data';
      }
      if (paramsCopy.action === 'browser_session_import') {
        (paramsCopy as any).archive = 'base64 archive';
      }
      if (
        (paramsCopy.action === 'type_text' ||
          paramsCopy.action === 'paste_text') &&
        (paramsCopy as any).sensitive
      ) {
        (paramsCopy as any).text = '[redacted]';
      }
      this.logger.log(`Computer action request: ${JSON.stringify(paramsCopy)}`);
      return await this.computerUseService.action(params);
    } catch (error) {
      this.logger.error(
        `Error executing computer action: ${error.message}`,
        error.stack,
      );
      throw new HttpException(
        `Failed to execute computer action: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
