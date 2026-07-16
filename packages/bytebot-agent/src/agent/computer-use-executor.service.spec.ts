import { ComputerUseExecutorService } from './computer-use-executor.service';

describe('ComputerUseExecutorService auth placeholder grounding', () => {
  const createExecutor = (secrets?: {
    username?: string;
    password?: string;
    otp?: string;
    site?: string;
  }) =>
    new ComputerUseExecutorService(
      {
        get: (key: string) => {
          if (key === 'GEMINI_API_KEY') {
            return 'test-key';
          }
          if (key === 'COMPUTER_USE_MODEL') {
            return 'test-model';
          }
          if (key === 'COMPUTER_USE_MAX_TURNS') {
            return '5';
          }
          return undefined;
        },
      } as any,
      {
        get: () => secrets,
      } as any,
      {} as any,
    ) as any;

  it('does not guess a username placeholder for a generic sign-in field', () => {
    const executor = createExecutor({
      site: 'proton.me',
      username: 'user@example.com',
      password: 'secret',
    });

    const args = executor.prepareAuthActionArgs(
      'task-1',
      {
        description: 'Sign in to Proton Mail using the provided secure placeholders.',
      },
      'type_text_at',
      {
        x: 414,
        y: 443,
        text: 'redacted',
        press_enter: true,
      },
      'https://mail.proton.me',
    );

    expect(args.text).toBe('redacted');
    expect(args.clear_before_typing).toBeUndefined();
    expect(args.press_enter).toBe(true);
  });

  it('does not guess a password placeholder for a later generic sign-in field', () => {
    const executor = createExecutor({
      site: 'proton.me',
      username: 'user@example.com',
      password: 'secret',
    });

    const args = executor.prepareAuthActionArgs(
      'task-2',
      {
        description: 'Sign in to Proton Mail using the provided secure placeholders.',
      },
      'type_text_at',
      {
        x: 414,
        y: 544,
        text: 'redacted',
        press_enter: true,
      },
      'https://mail.proton.me',
    );

    expect(args.text).toBe('redacted');
    expect(args.press_enter).toBe(true);
  });

  it('does not invent a field mapping for repeated typing on the same generic login row', () => {
    const executor = createExecutor({
      site: 'proton.me',
      username: 'user@example.com',
      password: 'secret',
    });

    const firstArgs = executor.prepareAuthActionArgs(
      'task-3',
      {
        description: 'Sign in to Proton Mail using the provided secure placeholders.',
      },
      'type_text_at',
      {
        x: 414,
        y: 443,
        text: 'redacted',
      },
      'https://mail.proton.me',
    );

    const retryArgs = executor.prepareAuthActionArgs(
      'task-3',
      {
        description: 'Sign in to Proton Mail using the provided secure placeholders.',
      },
      'type_text_at',
      {
        x: 420,
        y: 445,
        text: 'redacted',
      },
      'https://mail.proton.me',
    );

    expect(firstArgs.text).toBe('redacted');
    expect(retryArgs.text).toBe('redacted');
  });

  it('does not override combined username/password instructions that are still ambiguous', () => {
    const executor = createExecutor({
      site: 'proton.me',
      username: 'user@example.com',
      password: 'secret',
    });

    const usernameArgs = executor.prepareAuthActionArgs(
      'task-4',
      {
        description:
          'Navigate to Proton Mail and sign in. Enter username [[secure:username]] and password [[secure:password]] to log in to the inbox.',
      },
      'type_text_at',
      {
        x: 495,
        y: 433,
        text: 'redacted',
        press_enter: true,
      },
      'https://mail.proton.me',
    );

    const passwordArgs = executor.prepareAuthActionArgs(
      'task-4',
      {
        description:
          'Navigate to Proton Mail and sign in. Enter username [[secure:username]] and password [[secure:password]] to log in to the inbox.',
      },
      'type_text_at',
      {
        x: 495,
        y: 534,
        text: 'redacted',
        press_enter: true,
      },
      'https://mail.proton.me',
    );

    expect(usernameArgs.text).toBe('redacted');
    expect(usernameArgs.press_enter).toBe(true);
    expect(passwordArgs.text).toBe('redacted');
  });

  it('overrides only an explicit username-field instruction', () => {
    const executor = createExecutor({
      site: 'proton.me',
      username: 'user@example.com',
      password: 'secret',
    });

    const args = executor.prepareAuthActionArgs(
      'task-4b',
      {
        description:
          'Enter username [[secure:username]] in the email or username field. Do not submit yet.',
      },
      'type_text_at',
      {
        x: 495,
        y: 433,
        text: 'redacted',
        press_enter: true,
      },
      'https://account.proton.me/login',
    );

    expect(args.text).toBe('[[secure:username]]');
    expect(args.clear_before_typing).toBe(true);
    expect(args.press_enter).toBe(false);
  });

  it('overrides only an explicit password-field instruction', () => {
    const executor = createExecutor({
      site: 'proton.me',
      username: 'user@example.com',
      password: 'secret',
    });

    const args = executor.prepareAuthActionArgs(
      'task-4c',
      {
        description:
          'Enter password [[secure:password]] in the password field and continue the sign-in flow.',
      },
      'type_text_at',
      {
        x: 495,
        y: 534,
        text: 'redacted',
        press_enter: true,
      },
      'https://account.proton.me/login',
    );

    expect(args.text).toBe('[[secure:password]]');
    expect(args.clear_before_typing).toBe(true);
    expect(args.press_enter).toBe(true);
  });

  it('rewrites generic no-credentials narration into automatic login continuation when saved secrets exist', () => {
    const executor = createExecutor({
      site: 'proton.me',
      username: 'user@example.com',
      password: 'secret',
    });

    const result = executor['finalizeStepResult'](
      'task-5',
      {
        description: 'Open Proton Mail inbox',
        executionMode: 'internal',
      },
      'Open Proton Mail inbox',
      'I am now on the "account.proton.me/login" page. The page presents a "Sign in" form asking for "Email or username" and "Password". To proceed and open the inbox, I need to enter the login credentials. However, as an AI agent browsing the web, I do not possess personal login credentials for Proton Mail or any other service. I cannot invent them, nor should I attempt to guess or use placeholders unless explicitly provided.',
      'completed',
      undefined,
      'https://account.proton.me/login',
      [],
    );

    expect(result.summary).toContain('Continue the login flow automatically');
    expect(result.status).toBe('in_progress');
    expect(result.outcome).toEqual({ kind: 'step_in_progress' });
  });

  it('does not claim automatic login continuation when the required password is missing', () => {
    const executor = createExecutor({
      site: 'proton.me',
      username: 'user@example.com',
    });

    const result = executor['finalizeStepResult'](
      'task-6',
      {
        description: 'Open Proton Mail inbox',
        executionMode: 'internal',
      },
      'Open Proton Mail inbox',
      'I am now on the "account.proton.me/login" page. The page presents a "Sign in" form asking for "Email or username" and "Password". To proceed and open the inbox, I need to enter the login credentials.',
      'completed',
      undefined,
      'https://account.proton.me/login',
      [],
    );

    expect(result.summary).toContain('Email or username');
    expect(result.summary).not.toContain('Continue the login flow automatically');
    expect(result.outcome).toEqual({ kind: 'step_completed' });
  });

  it('does not invent a Google search URL when typed text is submitted from an unknown page', () => {
    const executor = createExecutor();

    expect(
      executor['deriveCurrentUrl'](
        'type_text_at',
        {
          text: 'proton mail',
          press_enter: true,
        },
        {
          output: 'Typed text',
        },
        undefined,
      ),
    ).toBeUndefined();
  });

  it('detects CAPTCHA-like visible state as immediate human attention', () => {
    const executor = createExecutor();

    expect(
      executor['getHumanAttentionPromptFromVisibleState'](
        'Google is showing an I am not a robot verification challenge.',
        'https://www.google.com/sorry/index',
      ),
    ).toContain('human verification');
  });

  it('classifies provider-capacity failures into a structured executor outcome', () => {
    const executor = createExecutor();

    const result = executor['finalizeStepResult'](
      'task-7',
      {
        description: 'Open Google Flights and search for flights.',
        executionMode: 'guarded',
        expectedState: {},
      },
      'Open Google Flights and search for flights.',
      'Computer Use step failed: temporary model/provider capacity limit. 0 actions executed before this.',
      'failed',
      undefined,
      'https://www.google.com/travel/flights',
      [],
    );

    expect(result.outcome).toEqual({
      kind: 'step_failed',
      failureKind: 'provider_capacity',
    });
  });

  it('does not treat generic blocked language as a CAPTCHA challenge', () => {
    const executor = createExecutor();

    expect(
      executor['getHumanAttentionPromptFromVisibleState'](
        'The page looks blocked and unusable, but no challenge text is visible.',
        'https://www.ted.com',
      ),
    ).toBeNull();
  });

  it('auto-approves ordinary YouTube media-selection safety decisions', () => {
    const executor = createExecutor();

    expect(
      executor['shouldAutoApproveSafetyDecision'](
        'task-1',
        {
          description:
            'Open YouTube and get to a useful search, results, or player state for selecting the requested item this turn.',
          executionMode: 'guarded',
          expectedState: {},
        },
        'click_at',
        {
          safety_decision: {
            decision: 'confirm before clicking the visible candidate',
          },
        },
        'https://www.youtube.com/results?search_query=ted+talk',
      ),
    ).toBe(true);
  });

  it('auto-approves ordinary YouTube watch-page continuation even when currentUrl is missing', () => {
    const executor = createExecutor();

    expect(
      executor['shouldAutoApproveSafetyDecision'](
        'task-1',
        {
          description:
            'Open YouTube and get to a useful search, results, or player state for selecting the requested item this turn.',
          executionMode: 'guarded',
          expectedState: {},
        },
        'click_at',
        {
          safety_decision: {
            decision: 'confirm before clicking the visible player control on the YouTube watch page that is ready for playback',
          },
        },
        undefined,
      ),
    ).toBe(true);
  });

  it('auto-approves ordinary YouTube filter-selection safety decisions without a currentUrl', () => {
    const executor = createExecutor();

    expect(
      executor['shouldAutoApproveSafetyDecision'](
        'task-1',
        {
          description:
            'Open YouTube and get to a useful search, results, or player state for selecting the requested item this turn.',
          executionMode: 'guarded',
          expectedState: {},
        },
        'click_at',
        {
          safety_decision: {
            decision: 'confirm before clicking the Filters button on the YouTube search results page to narrow results by duration',
          },
        },
        undefined,
      ),
    ).toBe(true);
  });

  it('treats planner and recovery briefs as multi-phase execution briefs', () => {
    const executor = createExecutor();

    expect(
      executor['isMultiPhaseExecutionBrief'](
        'Planner execution brief: Open Google Flights, inspect the current form, set the multicity route, and stop at visible results.',
      ),
    ).toBe(true);
    expect(
      executor['isMultiPhaseExecutionBrief'](
        'Recovery brief: fix the blocked travel form from the current page.',
      ),
    ).toBe(true);
  });

  it('uses sparse checkpointing for fast planner-managed phases', () => {
    const executor = createExecutor();

    const plannerSettings = executor['getModeSettings'](
      'fast',
      'Planner execution brief: Open Google Flights, inspect the current form, set the multicity route, and stop at visible results.',
    );
    const recoverySettings = executor['getModeSettings'](
      'fast',
      'Recovery brief: fix the blocked travel form from the current page.',
    );

    expect(plannerSettings.captureInitialCheckpoint).toBe(false);
    expect(plannerSettings.checkpointEvery).toBe(Number.MAX_SAFE_INTEGER);
    expect(recoverySettings.captureInitialCheckpoint).toBe(false);
    expect(recoverySettings.checkpointEvery).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('uses shorter post-action delays for fast typing and clicking actions', () => {
    const executor = createExecutor();

    expect(
      executor['getPostActionDelayMs']('type_text_at', {
        text: 'machine learning books',
      }),
    ).toBe(70);
    expect(
      executor['getPostActionDelayMs']('type_text_at', {
        text: 'amazon.com',
        press_enter: true,
      }),
    ).toBe(110);
  });

  it('normalizes raw set_task_status call-like summaries', () => {
    const executor = createExecutor();

    expect(
      executor['normalizeComputerUseSummaryText'](
        'call:set_task_status{description: <ctrl46> Added the selected item to cart. <ctrl46> ,status: <ctrl46> completed <ctrl46> }',
      ),
    ).toBe('Added the selected item to cart.');
  });
});
