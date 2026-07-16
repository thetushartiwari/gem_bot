import { Logger } from '@nestjs/common';
import { DEFAULT_DISPLAY_SIZE } from './agent.constants';

const BYTEBOT_DESKTOP_BASE_URL = process.env
  .BYTEBOT_DESKTOP_BASE_URL as string;

const SCREEN_W = DEFAULT_DISPLAY_SIZE.width;
const SCREEN_H = DEFAULT_DISPLAY_SIZE.height;

export type ActionResult = {
  output: string;
  currentUrl?: string;
};

type SecretResolution = {
  text: string;
  isSensitive: boolean;
};

type ActionExecutionOptions = {
  resolveSecretText?: (text: string) => SecretResolution;
};

function normalizeUrlCandidate(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (/^[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(trimmed)) {
    return `https://${trimmed}`;
  }

  return undefined;
}

/**
 * Denormalize a 0-999 coordinate to pixel space.
 */
function px(norm: number, screenSize: number): number {
  return Math.round((norm / 999) * screenSize);
}

async function desktopCall(payload: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${BYTEBOT_DESKTOP_BASE_URL}/computer-use`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(
      `Desktop API ${payload.action} failed: ${response.statusText}`,
    );
  }
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Maps each Gemini Computer Use function_call to one or more
 * POST /computer-use payloads and executes them sequentially.
 */
export class ActionMapper {
  private readonly logger = new Logger(ActionMapper.name);

  async execute(fnCall: {
    name: string;
    args: Record<string, unknown>;
  }, options: ActionExecutionOptions = {}): Promise<ActionResult> {
    const { name, args } = fnCall;
    this.logger.debug(
      `ActionMapper: ${name} ${JSON.stringify(this.sanitizeArgsForLogging(name, args))}`,
    );

    switch (name) {
      case 'click_at':
        return this.clickAt(args);
      case 'type_text_at':
        return this.typeTextAt(args, options);
      case 'hover_at':
        return this.hoverAt(args);
      case 'scroll_at':
        return this.scrollAt(args);
      case 'scroll_document':
        return this.scrollDocument(args);
      case 'key_combination':
        return this.keyCombination(args);
      case 'drag_and_drop':
        return this.dragAndDrop(args);
      case 'navigate':
        return this.navigate(args);
      case 'go_back':
        return this.goBack();
      case 'go_forward':
        return this.goForward();
      case 'open_web_browser':
        return this.openWebBrowser();
      case 'search':
        return this.search();
      case 'wait_5_seconds':
        return this.wait5Seconds();
      default:
        this.logger.warn(`Unknown Computer Use action: ${name}`);
        return { output: `Unknown action: ${name}` };
    }
  }

  private async clickAt(args: Record<string, unknown>): Promise<ActionResult> {
    const x = px(args.x as number, SCREEN_W);
    const y = px(args.y as number, SCREEN_H);
    await desktopCall({
      action: 'click_mouse',
      coordinates: { x, y },
      button: 'left',
      clickCount: 1,
    });
    return { output: `Clicked at (${x}, ${y})` };
  }

  private async typeTextAt(
    args: Record<string, unknown>,
    options: ActionExecutionOptions,
  ): Promise<ActionResult> {
    const x = px(args.x as number, SCREEN_W);
    const y = px(args.y as number, SCREEN_H);
    const rawText = args.text as string;
    const resolved = options.resolveSecretText?.(rawText) || {
      text: rawText,
      isSensitive: false,
    };
    const pressEnter = args.press_enter as boolean | undefined;
    const clearBefore = args.clear_before_typing as boolean | undefined;

    await desktopCall({
      action: 'click_mouse',
      coordinates: { x, y },
      button: 'left',
      clickCount: 1,
    });

    if (clearBefore) {
      await desktopCall({
        action: 'type_keys',
        keys: ['LeftControl', 'A'],
      });
      await desktopCall({
        action: 'type_keys',
        keys: ['Delete'],
      });
    }

    if (resolved.isSensitive) {
      await desktopCall({
        action: 'paste_text',
        text: resolved.text,
        sensitive: true,
        clearAfter: true,
      });
    } else {
      await desktopCall({
        action: 'type_text',
        text: resolved.text,
        sensitive: false,
      });
    }

    if (pressEnter) {
      await desktopCall({
        action: 'type_keys',
        keys: ['Return'],
      });
    }

    return {
      output: `${resolved.isSensitive ? 'Entered sensitive text' : 'Typed text'} at (${x}, ${y})${pressEnter ? ' + Enter' : ''}`,
      ...(pressEnter && {
        currentUrl: normalizeUrlCandidate(resolved.text),
      }),
    };
  }

  private async hoverAt(args: Record<string, unknown>): Promise<ActionResult> {
    const x = px(args.x as number, SCREEN_W);
    const y = px(args.y as number, SCREEN_H);
    await desktopCall({
      action: 'move_mouse',
      coordinates: { x, y },
    });
    return { output: `Hovered at (${x}, ${y})` };
  }

  private async scrollAt(args: Record<string, unknown>): Promise<ActionResult> {
    const x = px(args.x as number, SCREEN_W);
    const y = px(args.y as number, SCREEN_H);
    const direction = args.direction as string;
    const magnitude = (args.magnitude as number) || 200;
    const scrollCount = Math.max(1, Math.ceil(magnitude / 200));
    await desktopCall({
      action: 'scroll',
      coordinates: { x, y },
      direction,
      scrollCount,
    });
    return { output: `Scrolled ${direction} ${scrollCount}x at (${x}, ${y})` };
  }

  private async scrollDocument(
    args: Record<string, unknown>,
  ): Promise<ActionResult> {
    const direction = args.direction as string;
    await desktopCall({
      action: 'scroll',
      coordinates: {
        x: Math.round(SCREEN_W / 2),
        y: Math.round(SCREEN_H / 2),
      },
      direction,
      scrollCount: 3,
    });
    return { output: `Scrolled document ${direction}` };
  }

  private async keyCombination(
    args: Record<string, unknown>,
  ): Promise<ActionResult> {
    const rawKeys = args.keys as string;
    const keys = this.parseKeyCombination(rawKeys);
    await desktopCall({
      action: 'type_keys',
      keys,
    });
    return { output: `Key combination: ${rawKeys}` };
  }

  private async dragAndDrop(
    args: Record<string, unknown>,
  ): Promise<ActionResult> {
    const x1 = px(args.x as number, SCREEN_W);
    const y1 = px(args.y as number, SCREEN_H);
    const x2 = px(args.dst_x as number, SCREEN_W);
    const y2 = px(args.dst_y as number, SCREEN_H);
    await desktopCall({
      action: 'drag_mouse',
      path: [
        { x: x1, y: y1 },
        { x: x2, y: y2 },
      ],
      button: 'left',
    });
    return { output: `Dragged from (${x1}, ${y1}) to (${x2}, ${y2})` };
  }

  private async navigate(args: Record<string, unknown>): Promise<ActionResult> {
    const url = args.url as string;
    await desktopCall({
      action: 'type_keys',
      keys: ['Escape'],
    });
    await delay(100);
    await desktopCall({
      action: 'type_keys',
      keys: ['LeftControl', 'L'],
    });
    await delay(100);
    await desktopCall({
      action: 'type_text',
      text: url,
    });
    await desktopCall({
      action: 'type_keys',
      keys: ['Return'],
    });
    await delay(1500);
    return {
      output: `Navigated to ${url} - page load wait complete`,
      currentUrl: url,
    };
  }

  private async goBack(): Promise<ActionResult> {
    await desktopCall({
      action: 'type_keys',
      keys: ['LeftAlt', 'Left'],
    });
    await delay(1200);
    return { output: 'Went back - page load wait complete' };
  }

  private async goForward(): Promise<ActionResult> {
    await desktopCall({
      action: 'type_keys',
      keys: ['LeftAlt', 'Right'],
    });
    await delay(1200);
    return { output: 'Went forward - page load wait complete' };
  }

  private async openWebBrowser(): Promise<ActionResult> {
    await desktopCall({
      action: 'application',
      application: 'brave',
    });
    await delay(700);
    return { output: 'Opened web browser', currentUrl: 'about:blank' };
  }

  private async search(): Promise<ActionResult> {
    await desktopCall({
      action: 'type_keys',
      keys: ['Escape'],
    });
    await delay(100);
    await desktopCall({
      action: 'type_keys',
      keys: ['LeftControl', 'L'],
    });
    return {
      output: 'Focused browser address bar for search',
    };
  }

  private async wait5Seconds(): Promise<ActionResult> {
    await desktopCall({
      action: 'wait',
      duration: 1500,
    });
    return { output: 'Paused briefly for page settle' };
  }

  /**
   * Parse "Control+C" style key combo into nut-js key names.
   */
  private parseKeyCombination(raw: string): string[] {
    const keyMap: Record<string, string> = {
      control: 'LeftControl',
      ctrl: 'LeftControl',
      alt: 'LeftAlt',
      shift: 'LeftShift',
      meta: 'LeftCmd',
      command: 'LeftCmd',
      cmd: 'LeftCmd',
      super: 'LeftSuper',
      win: 'LeftWin',
      enter: 'Return',
      return: 'Return',
      esc: 'Escape',
      escape: 'Escape',
      tab: 'Tab',
      space: 'Space',
      backspace: 'Backspace',
      delete: 'Delete',
      up: 'Up',
      down: 'Down',
      left: 'Left',
      right: 'Right',
      home: 'Home',
      end: 'End',
      pageup: 'PageUp',
      pagedown: 'PageDown',
    };

    return raw.split('+').map((k) => {
      const lower = k.trim().toLowerCase();
      return keyMap[lower] || k.trim();
    });
  }

  private sanitizeArgsForLogging(
    actionName: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    if (actionName !== 'type_text_at') {
      return args;
    }

    const sanitized = { ...args };
    if (typeof sanitized.text === 'string') {
      sanitized.text = '[redacted text]';
    }
    return sanitized;
  }
}
