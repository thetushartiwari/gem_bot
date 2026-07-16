import { Injectable, Logger } from '@nestjs/common';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { NutService } from '../nut/nut.service';
import {
  ComputerAction,
  MoveMouseAction,
  TraceMouseAction,
  ClickMouseAction,
  PressMouseAction,
  DragMouseAction,
  ScrollAction,
  TypeKeysAction,
  PressKeysAction,
  TypeTextAction,
  ApplicationAction,
  Application,
  PasteTextAction,
  WriteFileAction,
  ReadFileAction,
  BrowserSessionExportAction,
  BrowserSessionImportAction,
  BrowserSessionClearAction,
  AudioDevicesAction,
  AudioRecordStartAction,
  AudioRecordStopAction,
  AudioRecordStatusAction,
  AudioChunkExportAction,
} from '@bytebot/shared';

type ActiveAudioRecording = {
  process: ReturnType<typeof spawn>;
  filePath: string;
  startedAt: string;
  source: string;
  format: 'wav' | 'flac';
  purpose?: string;
};

type ActiveWindowSnapshot = {
  id?: string;
  title?: string;
  className?: string;
};

type NativeMediaSessionSnapshot = {
  playerName?: string;
  status?: string;
  positionMs?: number;
  lengthMs?: number;
  title?: string;
  artist?: string;
  album?: string;
  url?: string;
  source: 'playerctl' | 'window';
};

@Injectable()
export class ComputerUseService {
  private readonly logger = new Logger(ComputerUseService.name);
  private activeAudioRecording: ActiveAudioRecording | null = null;
  private readonly audioOutputMonitor = 'bytebot_output.monitor';
  private readonly audioRecordingsDir = '/tmp/bytebot-audio';
  private readonly defaultBrowser: 'brave' | 'firefox' = 'brave';

  constructor(private readonly nutService: NutService) {}

  async action(params: ComputerAction): Promise<any> {
    this.logger.log(`Executing computer action: ${params.action}`);

    switch (params.action) {
      case 'move_mouse': {
        await this.moveMouse(params);
        break;
      }
      case 'trace_mouse': {
        await this.traceMouse(params);
        break;
      }
      case 'click_mouse': {
        await this.clickMouse(params);
        break;
      }
      case 'press_mouse': {
        await this.pressMouse(params);
        break;
      }
      case 'drag_mouse': {
        await this.dragMouse(params);
        break;
      }

      case 'scroll': {
        await this.scroll(params);
        break;
      }
      case 'type_keys': {
        await this.typeKeys(params);
        break;
      }
      case 'press_keys': {
        await this.pressKeys(params);
        break;
      }
      case 'type_text': {
        await this.typeText(params);
        break;
      }
      case 'paste_text': {
        await this.pasteText(params);
        break;
      }
      case 'wait': {
        const waitParams = params;
        await this.delay(waitParams.duration);
        break;
      }
      case 'screenshot':
        return this.screenshot();

      case 'cursor_position':
        return this.cursor_position();

      case 'application': {
        await this.application(params);
        break;
      }

      case 'write_file': {
        return this.writeFile(params);
      }

      case 'read_file': {
        return this.readFile(params);
      }

      case 'browser_session_export': {
        return this.exportBrowserSession(params);
      }

      case 'browser_session_import': {
        return this.importBrowserSession(params);
      }

      case 'browser_session_clear': {
        return this.clearBrowserSession(params);
      }

      case 'audio_devices': {
        return this.audioDevices(params);
      }

      case 'audio_record_start': {
        return this.audioRecordStart(params);
      }

      case 'audio_record_stop': {
        return this.audioRecordStop(params);
      }

      case 'audio_record_status': {
        return this.audioRecordStatus(params);
      }

      case 'audio_chunk_export': {
        return this.audioChunkExport(params);
      }

      default:
        throw new Error(
          `Unsupported computer action: ${(params as any).action}`,
        );
    }
  }

  private async moveMouse(action: MoveMouseAction): Promise<void> {
    await this.nutService.mouseMoveEvent(action.coordinates);
  }

  private async traceMouse(action: TraceMouseAction): Promise<void> {
    const { path, holdKeys } = action;

    // Move to the first coordinate
    await this.nutService.mouseMoveEvent(path[0]);

    // Hold keys if provided
    if (holdKeys) {
      await this.nutService.holdKeys(holdKeys, true);
    }

    // Move to each coordinate in the path
    for (const coordinates of path) {
      await this.nutService.mouseMoveEvent(coordinates);
    }

    // Release hold keys
    if (holdKeys) {
      await this.nutService.holdKeys(holdKeys, false);
    }
  }

  private async clickMouse(action: ClickMouseAction): Promise<void> {
    const { coordinates, button, holdKeys, clickCount } = action;

    // Move to coordinates if provided
    if (coordinates) {
      await this.nutService.mouseMoveEvent(coordinates);
    }

    // Hold keys if provided
    if (holdKeys) {
      await this.nutService.holdKeys(holdKeys, true);
    }

    // Perform clicks
    if (clickCount > 1) {
      // Perform multiple clicks
      for (let i = 0; i < clickCount; i++) {
        await this.nutService.mouseClickEvent(button);
        await this.delay(150);
      }
    } else {
      // Perform a single click
      await this.nutService.mouseClickEvent(button);
    }

    // Release hold keys
    if (holdKeys) {
      await this.nutService.holdKeys(holdKeys, false);
    }
  }

  private async pressMouse(action: PressMouseAction): Promise<void> {
    const { coordinates, button, press } = action;

    // Move to coordinates if provided
    if (coordinates) {
      await this.nutService.mouseMoveEvent(coordinates);
    }

    // Perform press
    if (press === 'down') {
      await this.nutService.mouseButtonEvent(button, true);
    } else {
      await this.nutService.mouseButtonEvent(button, false);
    }
  }

  private async dragMouse(action: DragMouseAction): Promise<void> {
    const { path, button, holdKeys } = action;

    // Move to the first coordinate
    await this.nutService.mouseMoveEvent(path[0]);

    // Hold keys if provided
    if (holdKeys) {
      await this.nutService.holdKeys(holdKeys, true);
    }

    // Perform drag
    await this.nutService.mouseButtonEvent(button, true);
    for (const coordinates of path) {
      await this.nutService.mouseMoveEvent(coordinates);
    }
    await this.nutService.mouseButtonEvent(button, false);

    // Release hold keys
    if (holdKeys) {
      await this.nutService.holdKeys(holdKeys, false);
    }
  }

  private async scroll(action: ScrollAction): Promise<void> {
    const { coordinates, direction, scrollCount, holdKeys } = action;

    // Move to coordinates if provided
    if (coordinates) {
      await this.nutService.mouseMoveEvent(coordinates);
    }

    // Hold keys if provided
    if (holdKeys) {
      await this.nutService.holdKeys(holdKeys, true);
    }

    // Perform scroll
    for (let i = 0; i < scrollCount; i++) {
      await this.nutService.mouseWheelEvent(direction, 1);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    // Release hold keys
    if (holdKeys) {
      await this.nutService.holdKeys(holdKeys, false);
    }
  }

  private async typeKeys(action: TypeKeysAction): Promise<void> {
    const { keys, delay } = action;
    await this.nutService.sendKeys(keys, delay);
  }

  private async pressKeys(action: PressKeysAction): Promise<void> {
    const { keys, press } = action;
    await this.nutService.holdKeys(keys, press === 'down');
  }

  private async typeText(action: TypeTextAction): Promise<void> {
    const { text, delay, sensitive } = action;
    await this.nutService.typeText(text, delay, sensitive);
  }

  private async pasteText(action: PasteTextAction): Promise<void> {
    const { text, sensitive, clearAfter } = action;
    await this.nutService.pasteText(text, sensitive, clearAfter);
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async screenshot(): Promise<{ image: string }> {
    this.logger.log(`Taking screenshot`);
    const buffer = await this.nutService.screendump();
    return { image: `${buffer.toString('base64')}` };
  }

  private async cursor_position(): Promise<{ x: number; y: number }> {
    this.logger.log(`Getting cursor position`);
    return await this.nutService.getCursorPosition();
  }

  private async application(action: ApplicationAction): Promise<void> {
    const execAsync = promisify(exec);

    // Helper to spawn a command and forget about it
    const spawnAndForget = (
      command: string,
      args: string[],
      options: Record<string, any> = {},
    ): void => {
      const child = spawn(command, args, {
        env: this.buildAudioEnv(), // ensure GUI apps inherit the desktop + Pulse runtime
        stdio: 'ignore',
        detached: true,
        ...options,
      });
      child.unref(); // Allow the parent process to exit independently
    };

    if (action.application === 'desktop') {
      spawnAndForget('sudo', ['-u', 'user', 'wmctrl', '-k', 'on']);
      return;
    }

    const commandMap: Record<string, string> = {
      brave: '/usr/local/bin/launch-brave-with-audio.sh',
      firefox: '/usr/local/bin/launch-firefox-with-audio.sh',
      vscode: 'code',
      terminal: 'xfce4-terminal',
      directory: 'thunar',
    };

    const processMap: Record<Application, string> = {
      brave: 'brave-browser.Brave-browser',
      firefox: 'firefox-esr.Firefox-esr',
      vscode: 'code.Code',
      terminal: 'xfce4-terminal.Xfce4-Terminal',
      directory: 'Thunar',
      desktop: 'xfdesktop.Xfdesktop',
    };

    // check if the application is already open using wmctrl -lx
    let appOpen = false;
    try {
      const { stdout } = await execAsync(
        `sudo -u user wmctrl -lx | grep ${processMap[action.application]}`,
        { timeout: 5000 }, // 5 second timeout
      );
      appOpen = stdout.trim().length > 0;
    } catch (error: any) {
      // grep returns exit code 1 when no match is found – treat as "not open"
      // Also handle timeout errors
      if (error.code !== 1 && !error.message?.includes('timeout')) {
        throw error;
      }
    }

    if (appOpen) {
      this.logger.log(`Application ${action.application} is already open`);
      spawnAndForget('sudo', [
        '-u',
        'user',
        'wmctrl',
        '-x',
        '-a',
        processMap[action.application],
      ]);

      spawnAndForget('sudo', [
        '-u',
        'user',
        'wmctrl',
        '-x',
        '-r',
        processMap[action.application],
        '-b',
        'add,maximized_vert,maximized_horz',
      ]);

      return;
    }

    // application is not open, open it - fire and forget
    spawnAndForget('sudo', [
      '-u',
      'user',
      'env',
      'HOME=/home/user',
      'DISPLAY=:0',
      'XDG_RUNTIME_DIR=/tmp/pulse-runtime',
      'PULSE_RUNTIME_PATH=/tmp/pulse-runtime/pulse',
      'PULSE_SERVER=unix:/tmp/pulse-runtime/pulse/native',
      'nohup',
      commandMap[action.application],
    ]);

    this.logger.log(`Application ${action.application} launched`);
    return;
  }

  private async focusAndPrepareApplication(
    application: Application,
    processMap: Record<Application, string>,
  ): Promise<void> {
    try {
      await this.focusAndMaximizeApplication(application, processMap);
    } catch (error: any) {
      if (this.isBrowserApplication(application)) {
        this.logger.warn(
          `Application ${application} launch verification did not fully settle: ${error.message}. Continuing so browser startup does not fail the task.`,
        );
        return;
      }
      throw error;
    }
  }

  private async focusAndMaximizeApplication(
    application: Application,
    processMap: Record<Application, string>,
  ): Promise<void> {
    if (application === 'desktop') {
      return;
    }

    const execAsync = promisify(exec);
    const timeoutMs = 3_000;
    const startedAt = Date.now();
    const displaySize = await this.getRootDisplaySize(execAsync);
    const wantsFullscreen =
      application === 'brave' || application === 'firefox';
    let lastError: string | undefined;
    let sawWindow = false;

    while (Date.now() - startedAt < timeoutMs) {
      const windows = await this.listWindowsForClass(execAsync, processMap[application]);
      const targetWindow = windows[windows.length - 1];

      if (!targetWindow) {
        await this.delay(300);
        continue;
      }
      sawWindow = true;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await this.forceWindowPresentation(
            execAsync,
            targetWindow.id,
            wantsFullscreen,
            displaySize,
          );
        } catch (error: any) {
          lastError = error.message;
        }

        await this.delay(200);

        const refreshed = (
          await this.listWindowsForClass(execAsync, processMap[application])
        ).find((window) => window.id === targetWindow.id);

        if (
          refreshed &&
          this.windowIsLargeEnough(
            refreshed,
            displaySize,
            wantsFullscreen,
          )
        ) {
          this.logger.log(
            `Application ${application} focused and ${wantsFullscreen ? 'fullscreened' : 'maximized'} (window ${refreshed.id})`,
          );
          return;
        }
      }

      await this.delay(200);
    }

    if (sawWindow) {
      this.logger.warn(
        `Application ${application} opened but did not reach the preferred ${wantsFullscreen ? 'fullscreen' : 'maximized'} state in time${lastError ? `: ${lastError}` : ''}. Continuing with the available window.`,
      );
      return;
    }

    throw new Error(
      `Application ${application} did not reach a verified maximized window state${lastError ? `: ${lastError}` : ''}`,
    );
  }

  private async forceWindowPresentation(
    execAsync: (command: string, options?: Record<string, any>) => Promise<{ stdout: string }>,
    windowId: string,
    wantsFullscreen: boolean,
    displaySize: { width: number; height: number } | null,
  ): Promise<void> {
    await execAsync(`sudo -u user wmctrl -i -a ${windowId}`, {
      timeout: 5000,
    });

    await execAsync(
      `sudo -u user wmctrl -i -r ${windowId} -b add,maximized_vert,maximized_horz`,
      { timeout: 5000 },
    ).catch(() => {});

    if (wantsFullscreen) {
      await execAsync(
        `sudo -u user wmctrl -i -r ${windowId} -b add,fullscreen`,
        { timeout: 5000 },
      ).catch(() => {});
    }

    if (displaySize) {
      await execAsync(
        `sudo -u user wmctrl -i -r ${windowId} -e 0,0,0,${displaySize.width},${displaySize.height}`,
        { timeout: 5000 },
      ).catch(() => {});
    }
  }

  private isBrowserApplication(application: Application): boolean {
    return application === 'brave' || application === 'firefox';
  }

  private async listWindowsForClass(
    execAsync: (command: string, options?: Record<string, any>) => Promise<{ stdout: string }>,
    className: string,
  ): Promise<
    Array<{
      id: string;
      x: number;
      y: number;
      width: number;
      height: number;
      title: string;
    }>
  > {
    try {
      const { stdout } = await execAsync(`sudo -u user wmctrl -lGx`, {
        timeout: 5000,
      });
      return stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const parts = line.split(/\s+/);
          if (parts.length < 8) {
            return null;
          }

          return {
            id: parts[0],
            x: Number(parts[2]) || 0,
            y: Number(parts[3]) || 0,
            width: Number(parts[4]) || 0,
            height: Number(parts[5]) || 0,
            className: parts[7],
            title: parts.slice(8).join(' '),
          };
        })
        .filter(
          (
            window,
          ): window is {
            id: string;
            x: number;
            y: number;
            width: number;
            height: number;
            className: string;
            title: string;
          } => !!window && window.className === className,
        )
        .map(({ id, x, y, width, height, title }) => ({
          id,
          x,
          y,
          width,
          height,
          title,
        }));
    } catch {
      return [];
    }
  }

  private async getRootDisplaySize(
    execAsync: (command: string, options?: Record<string, any>) => Promise<{ stdout: string }>,
  ): Promise<{ width: number; height: number } | null> {
    try {
      const { stdout } = await execAsync(`sudo -u user xwininfo -root`, {
        timeout: 5000,
      });
      const widthMatch = stdout.match(/Width:\s+(\d+)/i);
      const heightMatch = stdout.match(/Height:\s+(\d+)/i);
      if (!widthMatch || !heightMatch) {
        return null;
      }

      return {
        width: Number(widthMatch[1]),
        height: Number(heightMatch[1]),
      };
    } catch {
      return null;
    }
  }

  private windowIsLargeEnough(
    window: { x?: number; y?: number; width: number; height: number },
    displaySize: { width: number; height: number } | null,
    wantsFullscreen = false,
  ): boolean {
    if (!displaySize) {
      return (
        window.width >= (wantsFullscreen ? 1200 : 1100) &&
        window.height >= (wantsFullscreen ? 850 : 800)
      );
    }

    const widthThreshold = wantsFullscreen ? 0.97 : 0.9;
    const heightThreshold = wantsFullscreen ? 0.97 : 0.9;
    const originSlack = wantsFullscreen ? 12 : 40;

    return (
      (window.x || 0) <= originSlack &&
      (window.y || 0) <= originSlack &&
      window.width >= Math.floor(displaySize.width * widthThreshold) &&
      window.height >= Math.floor(displaySize.height * heightThreshold)
    );
  }

  private async writeFile(
    action: WriteFileAction,
  ): Promise<{ success: boolean; message: string }> {
    try {
      const execAsync = promisify(exec);

      // Decode base64 data
      const buffer = Buffer.from(action.data, 'base64');

      // Resolve path - if relative, make it relative to user's home directory
      let targetPath = action.path;
      if (!path.isAbsolute(targetPath)) {
        targetPath = path.join('/home/user/Desktop', targetPath);
      }

      // Ensure directory exists using sudo
      const dir = path.dirname(targetPath);
      try {
        await execAsync(`sudo mkdir -p "${dir}"`);
      } catch (error) {
        // Directory might already exist, which is fine
        this.logger.debug(`Directory creation: ${error.message}`);
      }

      // Write to a temporary file first
      const tempFile = `/tmp/bytebot_temp_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      await fs.writeFile(tempFile, buffer);

      // Move the file to the target location using sudo
      try {
        await execAsync(`sudo cp "${tempFile}" "${targetPath}"`);
        await execAsync(`sudo chown user:user "${targetPath}"`);
        await execAsync(`sudo chmod 644 "${targetPath}"`);
        // Clean up temp file
        await fs.unlink(tempFile).catch(() => {});
      } catch (error) {
        // Clean up temp file on error
        await fs.unlink(tempFile).catch(() => {});
        throw error;
      }

      this.logger.log(`File written successfully to: ${targetPath}`);
      return {
        success: true,
        message: `File written successfully to: ${targetPath}`,
      };
    } catch (error) {
      this.logger.error(`Error writing file: ${error.message}`, error.stack);
      return {
        success: false,
        message: `Error writing file: ${error.message}`,
      };
    }
  }

  private async readFile(action: ReadFileAction): Promise<{
    success: boolean;
    data?: string;
    name?: string;
    size?: number;
    mediaType?: string;
    message?: string;
  }> {
    try {
      const execAsync = promisify(exec);

      // Resolve path - if relative, make it relative to user's home directory
      let targetPath = action.path;
      if (!path.isAbsolute(targetPath)) {
        targetPath = path.join('/home/user/Desktop', targetPath);
      }

      // Copy file to temp location using sudo to read it
      const tempFile = `/tmp/bytebot_read_${Date.now()}_${Math.random().toString(36).substring(7)}`;

      try {
        // Copy the file to a temporary location we can read
        await execAsync(`sudo cp "${targetPath}" "${tempFile}"`);
        await execAsync(`sudo chmod 644 "${tempFile}"`);

        // Read file as buffer from temp location
        const buffer = await fs.readFile(tempFile);

        // Get file stats for size using sudo
        const { stdout: statOutput } = await execAsync(
          `sudo stat -c "%s" "${targetPath}"`,
        );
        const fileSize = parseInt(statOutput.trim(), 10);

        // Clean up temp file
        await fs.unlink(tempFile).catch(() => {});

        // Convert to base64
        const base64Data = buffer.toString('base64');

        // Extract filename from path
        const fileName = path.basename(targetPath);

        // Determine media type based on file extension
        const ext = path.extname(targetPath).toLowerCase().slice(1);
        const mimeTypes: Record<string, string> = {
          pdf: 'application/pdf',
          docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          doc: 'application/msword',
          txt: 'text/plain',
          html: 'text/html',
          json: 'application/json',
          xml: 'text/xml',
          csv: 'text/csv',
          rtf: 'application/rtf',
          odt: 'application/vnd.oasis.opendocument.text',
          epub: 'application/epub+zip',
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          webp: 'image/webp',
          gif: 'image/gif',
          svg: 'image/svg+xml',
        };

        const mediaType = mimeTypes[ext] || 'application/octet-stream';

        this.logger.log(`File read successfully from: ${targetPath}`);
        return {
          success: true,
          data: base64Data,
          name: fileName,
          size: fileSize,
          mediaType: mediaType,
        };
      } catch (error) {
        // Clean up temp file on error
        await fs.unlink(tempFile).catch(() => {});
        throw error;
      }
    } catch (error) {
      this.logger.error(`Error reading file: ${error.message}`, error.stack);
      return {
        success: false,
        message: `Error reading file: ${error.message}`,
      };
    }
  }

  private async exportBrowserSession(
    action: BrowserSessionExportAction,
  ): Promise<{ success: boolean; archive: string; message: string }> {
    const execAsync = promisify(exec);
    const browser = this.normalizeBrowser(action.browser);
    await this.closeBrowser(browser);
    const archivePath = `/tmp/${browser}_session_${Date.now()}.tar.gz`;

    try {
      if (browser === 'brave') {
        const browserBaseDir = await this.resolveBrowserBaseDir(browser);
        await execAsync(
          `sudo -u user tar -C "${browserBaseDir}" -czf "${archivePath}" .`,
        );
      } else {
        const profileDir = await this.findBrowserProfileDir(browser);
        await execAsync(
          `sudo -u user tar -C "${path.dirname(profileDir)}" -czf "${archivePath}" "${path.basename(profileDir)}"`,
        );
      }
      const archive = await fs.readFile(archivePath, 'base64');
      await fs.unlink(archivePath).catch(() => {});
      return {
        success: true,
        archive,
        message: `${this.browserLabel(browser)} browser session exported successfully`,
      };
    } catch (error: any) {
      await fs.unlink(archivePath).catch(() => {});
      throw new Error(
        `Failed to export ${this.browserLabel(browser)} session: ${error.message}`,
      );
    }
  }

  private async importBrowserSession(
    action: BrowserSessionImportAction,
  ): Promise<{ success: boolean; message: string }> {
    const execAsync = promisify(exec);
    const browser = this.normalizeBrowser(action.browser);
    const browserBaseDir = await this.resolveBrowserBaseDir(browser);
    const archivePath = `/tmp/${browser}_import_${Date.now()}.tar.gz`;

    await this.closeBrowser(browser);

    try {
      await fs.writeFile(archivePath, Buffer.from(action.archive, 'base64'));
      await execAsync(`sudo mkdir -p "${browserBaseDir}"`);
      await execAsync(`sudo rm -rf "${browserBaseDir}"/*`);
      await execAsync(`sudo tar -C "${browserBaseDir}" -xzf "${archivePath}"`);
      await execAsync(`sudo chown -R user:user "${browserBaseDir}"`);
      await fs.unlink(archivePath).catch(() => {});
      return {
        success: true,
        message: `${this.browserLabel(browser)} browser session restored successfully`,
      };
    } catch (error: any) {
      await fs.unlink(archivePath).catch(() => {});
      throw new Error(
        `Failed to import ${this.browserLabel(browser)} session: ${error.message}`,
      );
    }
  }

  private async clearBrowserSession(
    action: BrowserSessionClearAction,
  ): Promise<{ success: boolean; message: string }> {
    const execAsync = promisify(exec);
    const browser = this.normalizeBrowser(action.browser);
    const browserBaseDir = await this.resolveBrowserBaseDir(browser);
    await this.closeBrowser(browser);
    await execAsync(`sudo mkdir -p "${browserBaseDir}"`);
    await execAsync(`sudo rm -rf "${browserBaseDir}"/*`);
    await execAsync(`sudo chown -R user:user "${browserBaseDir}"`);
    return {
      success: true,
      message: `${this.browserLabel(browser)} browser session cleared successfully`,
    };
  }

  private async resolveBrowserBaseDir(
    browser: 'brave' | 'firefox',
  ): Promise<string> {
    const candidateDirs =
      browser === 'firefox'
        ? ['/home/user/.mozilla/firefox-esr', '/home/user/.mozilla/firefox']
        : ['/home/user/.config/BraveSoftware/Brave-Browser'];

    for (const dir of candidateDirs) {
      try {
        const stats = await fs.stat(dir);
        if (stats.isDirectory()) {
          return dir;
        }
      } catch {
        // Try the next candidate.
      }
    }

    const fallbackDir = candidateDirs[0];
    await fs.mkdir(fallbackDir, { recursive: true });
    return fallbackDir;
  }

  private async closeBrowser(browser: 'brave' | 'firefox'): Promise<void> {
    const execAsync = promisify(exec);
    try {
      if (browser === 'firefox') {
        await execAsync(`sudo pkill -f firefox-esr`);
      } else {
        await execAsync(`sudo pkill -f brave-browser`);
      }
    } catch {
      // Browser not running is fine.
    }
  }

  private async findBrowserProfileDir(
    browser: 'brave' | 'firefox',
  ): Promise<string> {
    const browserBaseDir = await this.resolveBrowserBaseDir(browser);
    if (browser === 'brave') {
      const defaultDir = path.join(browserBaseDir, 'Default');
      try {
        const stats = await fs.stat(defaultDir);
        if (stats.isDirectory()) {
          return defaultDir;
        }
      } catch {
        // Fall through to a clearer error below.
      }
      throw new Error('No Brave profile directory found');
    }

    const entries = await fs.readdir(browserBaseDir, { withFileTypes: true });
    const profile = entries.find(
      (entry) =>
        entry.isDirectory() &&
        (entry.name.includes('.default') || entry.name.includes('.profile')),
    );

    if (!profile) {
      throw new Error('No Firefox profile directory found');
    }

    return path.join(browserBaseDir, profile.name);
  }

  private normalizeBrowser(browser?: string): 'brave' | 'firefox' {
    return browser === 'firefox' ? 'firefox' : this.defaultBrowser;
  }

  private browserLabel(browser: 'brave' | 'firefox'): string {
    return browser === 'firefox' ? 'Firefox' : 'Brave';
  }

  private async audioDevices(
    _action: AudioDevicesAction,
  ): Promise<{
    success: boolean;
    sinks: Array<{ name: string; description: string }>;
    sources: Array<{ name: string; description: string }>;
    defaultMonitorSource: string;
    activeRecording: {
      filePath: string;
      startedAt: string;
      source: string;
      format: string;
      purpose?: string;
    } | null;
  }> {
    const sinks = await this.listPulseDevices('sinks');
    const sources = await this.listPulseDevices('sources');

    return {
      success: true,
      sinks,
      sources,
      defaultMonitorSource: this.audioOutputMonitor,
      activeRecording: this.activeAudioRecording
        ? {
            filePath: this.activeAudioRecording.filePath,
            startedAt: this.activeAudioRecording.startedAt,
            source: this.activeAudioRecording.source,
            format: this.activeAudioRecording.format,
            purpose: this.activeAudioRecording.purpose,
          }
        : null,
    };
  }

  private async audioRecordStart(
    action: AudioRecordStartAction,
  ): Promise<{
    success: boolean;
    message: string;
    filePath: string;
    source: string;
    startedAt: string;
    format: 'wav' | 'flac';
  }> {
    if (this.activeAudioRecording) {
      return {
        success: true,
        message: 'Audio recording is already in progress.',
        filePath: this.activeAudioRecording.filePath,
        source: this.activeAudioRecording.source,
        startedAt: this.activeAudioRecording.startedAt,
        format: this.activeAudioRecording.format,
      };
    }

    await fs.mkdir(this.audioRecordingsDir, { recursive: true });

    const format = action.format || 'wav';
    const source = action.source || this.audioOutputMonitor;
    const filePath = path.join(
      this.audioRecordingsDir,
      `meeting-audio-${Date.now()}.${format}`,
    );

    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'pulse',
      '-i',
      source,
      '-ac',
      '1',
      '-ar',
      '16000',
      ...(format === 'flac'
        ? ['-c:a', 'flac']
        : ['-c:a', 'pcm_s16le']),
      filePath,
    ];

    const child = spawn('ffmpeg', ffmpegArgs, {
      env: this.buildAudioEnv(),
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), 1200);

      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(
          new Error(
            `Audio recording exited early with code ${code}: ${stderr || 'unknown error'}`,
          ),
        );
      });
    });

    this.activeAudioRecording = {
      process: child,
      filePath,
      startedAt: new Date().toISOString(),
      source,
      format,
      purpose: action.purpose,
    };

    return {
      success: true,
      message: `Audio recording started from source ${source}.`,
      filePath,
      source,
      startedAt: this.activeAudioRecording.startedAt,
      format,
    };
  }

  private async audioRecordStop(
    _action: AudioRecordStopAction,
  ): Promise<{
    success: boolean;
    message: string;
    filePath?: string;
    startedAt?: string;
    stoppedAt?: string;
    durationMs?: number;
    sizeBytes?: number;
    source?: string;
    format?: string;
    purpose?: string;
  }> {
    const recording = this.activeAudioRecording;
    if (!recording) {
      return {
        success: false,
        message: 'No active audio recording to stop.',
      };
    }

    const startedAt = recording.startedAt;
    const stoppedAt = new Date().toISOString();

    await new Promise<void>((resolve) => {
      recording.process.once('exit', () => resolve());
      recording.process.kill('SIGINT');
      setTimeout(() => {
        if (!recording.process.killed) {
          recording.process.kill('SIGKILL');
        }
        resolve();
      }, 2000);
    });

    this.activeAudioRecording = null;

    let sizeBytes = 0;
    let message = 'Audio recording stopped successfully.';
    try {
      const stats = await fs.stat(recording.filePath);
      sizeBytes = stats.size;
      if (stats.size === 0) {
        message =
          'Audio recording stopped, but no audio frames were captured yet.';
      }
    } catch {
      message =
        'Audio recording stopped, but no audio file was finalized. This usually means no audio was playing yet.';
    }

    return {
      success: true,
      message,
      filePath: recording.filePath,
      startedAt,
      stoppedAt,
      durationMs:
        new Date(stoppedAt).getTime() - new Date(startedAt).getTime(),
      sizeBytes,
      source: recording.source,
      format: recording.format,
      purpose: recording.purpose,
    };
  }

  private async audioRecordStatus(
    _action: AudioRecordStatusAction,
  ): Promise<{
    success: boolean;
    active: boolean;
    filePath?: string;
    startedAt?: string;
    source?: string;
    format?: string;
    purpose?: string;
  }> {
    if (!this.activeAudioRecording) {
      return {
        success: true,
        active: false,
      };
    }

    return {
      success: true,
      active: true,
      filePath: this.activeAudioRecording.filePath,
      startedAt: this.activeAudioRecording.startedAt,
      source: this.activeAudioRecording.source,
      format: this.activeAudioRecording.format,
      purpose: this.activeAudioRecording.purpose,
    };
  }

  private async audioChunkExport(
    action: AudioChunkExportAction,
  ): Promise<{
    success: boolean;
    message: string;
    outputDir?: string;
    chunkDurationSeconds?: number;
    format?: 'wav' | 'flac';
    chunks?: Array<{
      index: number;
      filePath: string;
      name: string;
      sizeBytes: number;
      format: 'wav' | 'flac';
    }>;
  }> {
    const sourcePath = path.resolve(action.path);
    const chunkDurationSeconds = Math.max(
      30,
      Math.floor(action.chunkDurationSeconds || 480),
    );
    const format = action.format || 'flac';
    const maxChunks = Math.max(1, Math.floor(action.maxChunks || 24));

    try {
      const sourceStats = await fs.stat(sourcePath);
      if (!sourceStats.isFile()) {
        throw new Error('source audio path is not a file');
      }
    } catch (error: any) {
      throw new Error(
        `Unable to access source audio file for chunk export: ${error.message}`,
      );
    }

    const outputDir = path.join(
      this.audioRecordingsDir,
      `chunks-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    await fs.mkdir(outputDir, { recursive: true });

    const outputPattern = path.join(outputDir, `chunk-%03d.${format}`);
    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      sourcePath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      ...(format === 'flac'
        ? ['-c:a', 'flac']
        : ['-c:a', 'pcm_s16le']),
      '-f',
      'segment',
      '-segment_time',
      String(chunkDurationSeconds),
      '-reset_timestamps',
      '1',
      outputPattern,
    ];

    await new Promise<void>((resolve, reject) => {
      const child = spawn('ffmpeg', ffmpegArgs, {
        env: this.buildAudioEnv(),
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      let stderr = '';
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.once('error', (error) => {
        reject(error);
      });

      child.once('exit', (code) => {
        if (code && code !== 0) {
          reject(
            new Error(stderr || `ffmpeg exited with code ${code}`),
          );
          return;
        }
        resolve();
      });
    });

    const chunkEntries = (await fs.readdir(outputDir))
      .filter((entry) => entry.endsWith(`.${format}`))
      .sort();

    if (chunkEntries.length === 0) {
      throw new Error('ffmpeg did not produce any audio chunks');
    }

    if (chunkEntries.length > maxChunks) {
      throw new Error(
        `Chunk export would create ${chunkEntries.length} chunks, which exceeds the configured limit of ${maxChunks}`,
      );
    }

    const chunks = await Promise.all(
      chunkEntries.map(async (entry, index) => {
        const filePath = path.join(outputDir, entry);
        const stats = await fs.stat(filePath);
        return {
          index,
          filePath,
          name: entry,
          sizeBytes: stats.size,
          format,
        };
      }),
    );

    return {
      success: true,
      message: `Exported ${chunks.length} audio chunk(s) from ${path.basename(sourcePath)}.`,
      outputDir,
      chunkDurationSeconds,
      format,
      chunks,
    };
  }

  private async listPulseDevices(
    kind: 'sinks' | 'sources',
  ): Promise<Array<{ name: string; description: string }>> {
    const execAsync = promisify(exec);
    try {
      const { stdout } = await execAsync(`pactl list short ${kind}`, {
        env: this.buildAudioEnv(),
      });

      return stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const parts = line.split(/\s+/);
          return {
            name: parts[1] || '',
            description: parts.slice(1).join(' '),
          };
        })
        .filter((device) => device.name);
    } catch (error: any) {
      this.logger.warn(
        `Unable to list PulseAudio ${kind}: ${error.message || 'unknown error'}`,
      );
      return [];
    }
  }

  async audioLiveStatus(source?: string): Promise<{
    source: string;
    hasSignal: boolean;
    peakDb: number | null;
    rmsDb: number | null;
    zeroCrossingRate: number | null;
    signature: string | null;
    sampledAt: string;
    message: string;
  }> {
    const selectedSource = source || this.audioOutputMonitor;

    return await new Promise((resolve) => {
      const ffmpegArgs = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'pulse',
        '-i',
        selectedSource,
        '-t',
        '1',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-f',
        's16le',
        'pipe:1',
      ];

      const child = spawn('ffmpeg', ffmpegArgs, {
        env: this.buildAudioEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const chunks: Buffer[] = [];
      let stderr = '';
      let settled = false;
      let totalBytes = 0;
      const targetBytes = 32000;
      const timeout = setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGTERM');
        }
        finalize(stderr || 'audio probe timed out');
      }, 3500);

      const finalize = (errorMessage?: string) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);

        const audioBuffer = Buffer.concat(chunks);
        const peakDb = this.calculatePeakDbFromPcm(audioBuffer);
        const rmsDb = this.calculateRmsDbFromPcm(audioBuffer);
        const zeroCrossingRate = this.calculateZeroCrossingRate(audioBuffer);
        const signature = this.buildAudioSignature(audioBuffer);
        const hasSignal =
          rmsDb !== null && Number.isFinite(rmsDb) && rmsDb > -50;
        const sampledAt = new Date().toISOString();

        if (errorMessage && audioBuffer.length === 0) {
          this.logger.warn(
            `Unable to probe live desktop audio status: ${errorMessage}`,
          );
          resolve({
            source: selectedSource,
            hasSignal: false,
            peakDb: null,
            rmsDb: null,
            zeroCrossingRate: null,
            signature: null,
            sampledAt,
            message:
              'Unable to confirm desktop audio signal yet. The stream may still be starting or silent.',
          });
          return;
        }

        resolve({
          source: selectedSource,
          hasSignal,
          peakDb,
          rmsDb,
          zeroCrossingRate,
          signature,
          sampledAt,
          message: hasSignal
            ? 'Audible media signal detected from the desktop container.'
            : audioBuffer.length > 0
              ? 'Desktop audio stream is reachable, but no strong audible signal was detected yet.'
              : 'Unable to confirm desktop audio signal yet. The stream may still be starting or silent.',
        });
      };

      child.stdout?.on('data', (chunk) => {
        const buffer = Buffer.from(chunk);
        chunks.push(buffer);
        totalBytes += buffer.length;
        if (totalBytes >= targetBytes && !child.killed) {
          child.kill('SIGTERM');
          finalize();
        }
      });

      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.once('error', (error) => {
        finalize(error.message || 'unknown error');
      });

      child.once('exit', (code) => {
        if (code && code !== 0) {
          finalize(stderr || `ffmpeg exited with code ${code}`);
          return;
        }
        finalize();
      });
    });
  }

  async mediaSessionState(): Promise<{
    success: boolean;
    sampledAt: string;
    activeWindowTitle?: string;
    activeWindowClass?: string;
    session: {
      available: boolean;
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
  }> {
    const sampledAt = new Date().toISOString();
    const activeWindow = await this.getActiveWindowSnapshot();
    const session = await this.getPreferredNativeMediaSession(activeWindow);

    return {
      success: true,
      sampledAt,
      activeWindowTitle: activeWindow.title,
      activeWindowClass: activeWindow.className,
      session: session
        ? {
            available: true,
            source: session.source,
            playerName: session.playerName,
            status: session.status,
            positionMs: session.positionMs,
            lengthMs: session.lengthMs,
            title: session.title,
            artist: session.artist,
            album: session.album,
            url: session.url,
            message: 'Native desktop media session is available.',
          }
        : {
            available: false,
            message:
              activeWindow.title || activeWindow.className
                ? 'No native MPRIS media session was detected for the active window yet.'
                : 'No active window or native media session could be detected yet.',
          },
    };
  }

  createLiveAudioStream(source?: string): ReturnType<typeof spawn> {
    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-fflags',
      'nobuffer',
      '-flush_packets',
      '1',
      '-flags',
      'low_delay',
      '-f',
      'pulse',
      '-i',
      source || this.audioOutputMonitor,
      '-af',
      'volume=2.2,aresample=async=1:first_pts=0',
      '-ac',
      '2',
      '-ar',
      '44100',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '128k',
      '-write_xing',
      '0',
      '-f',
      'mp3',
      'pipe:1',
    ];

    return spawn('ffmpeg', ffmpegArgs, {
      env: this.buildAudioEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  private async getPreferredNativeMediaSession(
    activeWindow: ActiveWindowSnapshot,
  ): Promise<NativeMediaSessionSnapshot | null> {
    const sessions = await this.listNativeMediaSessions();
    if (sessions.length === 0) {
      return null;
    }

    const activeTitle = (activeWindow.title || '').toLowerCase();
    const activeClass = (activeWindow.className || '').toLowerCase();

    const scored = sessions
      .map((session) => ({
        session,
        score: this.scoreNativeMediaSession(session, activeTitle, activeClass),
      }))
      .sort((left, right) => right.score - left.score);

    return scored[0]?.session || null;
  }

  private scoreNativeMediaSession(
    session: NativeMediaSessionSnapshot,
    activeTitle: string,
    activeClass: string,
  ): number {
    let score = 0;
    const normalizedPlayer = (session.playerName || '').toLowerCase();
    const normalizedTitle = (session.title || '').toLowerCase();
    const normalizedUrl = (session.url || '').toLowerCase();
    const normalizedStatus = (session.status || '').toLowerCase();

    if (normalizedStatus === 'playing') {
      score += 30;
    } else if (normalizedStatus === 'paused') {
      score += 20;
    } else if (normalizedStatus === 'stopped') {
      score += 5;
    }

    if (normalizedPlayer && activeClass.includes(normalizedPlayer)) {
      score += 20;
    }

    if (normalizedTitle && activeTitle.includes(normalizedTitle)) {
      score += 18;
    }

    if (normalizedUrl.includes('youtube.com')) {
      score += 8;
    }

    if (session.lengthMs && session.lengthMs > 0) {
      score += 4;
    }

    if (session.positionMs && session.positionMs > 0) {
      score += 3;
    }

    return score;
  }

  private async listNativeMediaSessions(): Promise<NativeMediaSessionSnapshot[]> {
    const execAsync = promisify(exec);
    try {
      const { stdout } = await execAsync(
        "sudo -u user playerctl -a metadata --format '{{playerName}}|||{{status}}|||{{position}}|||{{mpris:length}}|||{{xesam:title}}|||{{xesam:artist}}|||{{xesam:album}}|||{{xesam:url}}'",
        {
          env: this.buildAudioEnv(),
          maxBuffer: 1024 * 1024,
        },
      );

      return stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [
            playerName,
            status,
            position,
            length,
            title,
            artist,
            album,
            url,
          ] = line.split('|||');

          return {
            playerName: playerName || undefined,
            status: status || undefined,
            positionMs: this.parsePlayerctlPositionMs(position),
            lengthMs: this.parsePlayerctlLengthMs(length),
            title: title || undefined,
            artist: artist || undefined,
            album: album || undefined,
            url: url || undefined,
            source: 'playerctl' as const,
          };
        })
        .filter(
          (session) =>
            session.playerName ||
            session.title ||
            session.url ||
            session.status,
        );
    } catch (error: any) {
      this.logger.debug(
        `Native media session probe unavailable: ${error.message || 'unknown error'}`,
      );
      return [];
    }
  }

  private async getActiveWindowSnapshot(): Promise<ActiveWindowSnapshot> {
    const execAsync = promisify(exec);
    try {
      const { stdout: activeWindowStdout } = await execAsync(
        'sudo -u user xprop -root _NET_ACTIVE_WINDOW',
        {
          env: this.buildAudioEnv(),
          maxBuffer: 1024 * 1024,
        },
      );
      const match = /window id # (0x[0-9a-f]+)/i.exec(activeWindowStdout);
      const windowId = match?.[1];
      if (!windowId || windowId === '0x0') {
        return {};
      }

      const { stdout } = await execAsync(
        `sudo -u user xprop -id ${windowId} _NET_WM_NAME WM_NAME WM_CLASS`,
        {
          env: this.buildAudioEnv(),
          maxBuffer: 1024 * 1024,
        },
      );

      const titleMatch =
        /_NET_WM_NAME\([^)]+\)\s*=\s*"([^"]+)"/.exec(stdout) ||
        /WM_NAME\([^)]+\)\s*=\s*"([^"]+)"/.exec(stdout);
      const classMatch = /WM_CLASS\([^)]+\)\s*=\s*"([^"]+)",\s*"([^"]+)"/.exec(
        stdout,
      );

      return {
        id: windowId,
        title: titleMatch?.[1] || undefined,
        className: classMatch
          ? `${classMatch[1]}.${classMatch[2]}`
          : undefined,
      };
    } catch (error: any) {
      this.logger.debug(
        `Unable to read active window snapshot: ${error.message || 'unknown error'}`,
      );
      return {};
    }
  }

  private parsePlayerctlPositionMs(value?: string): number | undefined {
    if (!value) {
      return undefined;
    }

    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return undefined;
    }

    return Math.max(0, Math.round(numeric * 1000));
  }

  private parsePlayerctlLengthMs(value?: string): number | undefined {
    if (!value) {
      return undefined;
    }

    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return undefined;
    }

    return Math.max(0, Math.round(numeric / 1000));
  }

  private buildAudioEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      DISPLAY: ':0',
      HOME: '/home/user',
      XDG_RUNTIME_DIR: '/tmp/pulse-runtime',
      PULSE_RUNTIME_PATH: '/tmp/pulse-runtime/pulse',
      PULSE_SERVER: 'unix:/tmp/pulse-runtime/pulse/native',
    };
  }

  private calculatePeakDbFromPcm(audioBuffer: Buffer): number | null {
    if (!audioBuffer.length || audioBuffer.length < 2) {
      return null;
    }

    let peak = 0;
    for (let index = 0; index + 1 < audioBuffer.length; index += 2) {
      const sample = Math.abs(audioBuffer.readInt16LE(index));
      if (sample > peak) {
        peak = sample;
      }
    }

    if (peak <= 0) {
      return -120;
    }

    return 20 * Math.log10(peak / 32768);
  }

  private calculateRmsDbFromPcm(audioBuffer: Buffer): number | null {
    if (!audioBuffer.length || audioBuffer.length < 2) {
      return null;
    }

    let sampleCount = 0;
    let sumSquares = 0;
    for (let index = 0; index + 1 < audioBuffer.length; index += 2) {
      const sample = audioBuffer.readInt16LE(index) / 32768;
      sumSquares += sample * sample;
      sampleCount += 1;
    }

    if (sampleCount === 0) {
      return null;
    }

    const rms = Math.sqrt(sumSquares / sampleCount);
    if (rms <= 0) {
      return -120;
    }

    return 20 * Math.log10(rms);
  }

  private calculateZeroCrossingRate(audioBuffer: Buffer): number | null {
    if (!audioBuffer.length || audioBuffer.length < 4) {
      return null;
    }

    let crossings = 0;
    let sampleCount = 0;
    let previous = audioBuffer.readInt16LE(0);

    for (let index = 2; index + 1 < audioBuffer.length; index += 2) {
      const current = audioBuffer.readInt16LE(index);
      if (
        (previous >= 0 && current < 0) ||
        (previous < 0 && current >= 0)
      ) {
        crossings += 1;
      }
      previous = current;
      sampleCount += 1;
    }

    if (sampleCount === 0) {
      return null;
    }

    return crossings / sampleCount;
  }

  private buildAudioSignature(audioBuffer: Buffer): string | null {
    if (!audioBuffer.length || audioBuffer.length < 2) {
      return null;
    }

    const bucketCount = 24;
    const totalSamples = Math.floor(audioBuffer.length / 2);
    if (totalSamples <= 0) {
      return null;
    }

    const bucketSize = Math.max(1, Math.floor(totalSamples / bucketCount));
    const buckets: number[] = [];

    for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
      const startSample = bucketIndex * bucketSize;
      if (startSample >= totalSamples) {
        buckets.push(0);
        continue;
      }

      const endSample = Math.min(totalSamples, startSample + bucketSize);
      let sum = 0;
      let count = 0;
      for (
        let sampleIndex = startSample;
        sampleIndex < endSample;
        sampleIndex += 1
      ) {
        sum += Math.abs(audioBuffer.readInt16LE(sampleIndex * 2)) / 32768;
        count += 1;
      }

      buckets.push(count > 0 ? sum / count : 0);
    }

    const maxBucket = Math.max(...buckets, 0);
    if (maxBucket <= 0) {
      return '0'.repeat(bucketCount);
    }

    return buckets
      .map((value) => {
        const normalized = Math.max(
          0,
          Math.min(35, Math.round((value / maxBucket) * 35)),
        );
        return normalized.toString(36);
      })
      .join('');
  }
}
