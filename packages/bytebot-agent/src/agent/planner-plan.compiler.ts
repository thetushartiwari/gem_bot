import { TaskSecurityState } from '../tasks/task-security.types';

export class PlannerPlanCompiler {
  derivePlanStepsFromPlanText(plan: string): string[] {
    const normalized = (plan || '').trim();
    if (!normalized) {
      return [];
    }

    const lineSteps = normalized
      .split(/\r?\n/)
      .map((line) =>
        line
          .replace(/^\s*(?:\d+[\).\:-]|[-*])\s*/, '')
          .trim(),
      )
      .filter(Boolean);
    if (lineSteps.length >= 2) {
      return lineSteps;
    }

    const numberedInline = normalized
      .split(/\s+(?=\d+[\).\:-]\s+)/)
      .map((part) => part.replace(/^\s*\d+[\).\:-]\s*/, '').trim())
      .filter(Boolean);
    if (numberedInline.length >= 2) {
      return numberedInline;
    }

    const separated = normalized
      .split(/\s*(?:->|=>|\|)\s*/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (separated.length >= 2) {
      return separated;
    }

    return [normalized];
  }

  refinePlannerStepsForGoal(goal: string, steps: string[]): string[] {
    const cleaned = steps
      .flatMap((step) => this.splitSinglePlannerStep(step))
      .map((step) => this.stripPlannerStepBoilerplateStopClause(step))
      .map((step) => step.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    if (cleaned.length === 0) {
      return [];
    }

    return this.enforcePlannerStepCount(goal, Array.from(new Set(cleaned)));
  }

  buildQueryDerivedFallbackPlanSteps(input: {
    currentGoal: string;
    taskDescription: string;
    security: TaskSecurityState;
  }): string[] {
    const currentGoal = input.currentGoal.trim();
    const derivedGoalSteps = this.deriveGoalOnlyPlanCandidates(
      currentGoal || input.taskDescription,
    );
    const candidates = Array.from(
      new Set(
        [
          ...(input.security.preflight?.planSteps || []),
          ...this.derivePlanStepsFromPlanText(
            input.security.preflight?.plan || '',
          ),
          ...derivedGoalSteps,
        ]
          .map((step) => step.replace(/\s+/g, ' ').trim())
          .filter(
            (step) =>
              Boolean(step) &&
              !/^(open the browser|continue the task|complete the task|open the needed site|open the correct site|open or reuse the right page)\b/i.test(
                step,
              ),
          ),
      ),
    );

    if (candidates.length === 0) {
      return currentGoal ? [currentGoal] : [];
    }

    return this.refinePlannerStepsForGoal(
      currentGoal || input.taskDescription,
      candidates,
    );
  }

  deriveGoalOnlyPlanCandidates(goal: string): string[] {
    const normalizedGoal = (goal || '').replace(/\s+/g, ' ').trim();
    if (!normalizedGoal) {
      return [];
    }

    const splitGoal = this.splitGoalIntoActionPhases(normalizedGoal);
    const surface = this.extractGoalSurface(normalizedGoal);
    const searchTarget = this.extractGoalSearchTarget(normalizedGoal);
    const comparisonCriteria = this.extractGoalComparisonCriteria(normalizedGoal);
    const commitAction = this.extractGoalCommitAction(normalizedGoal);

    if (splitGoal.length >= 2) {
      const canonicalized = this.canonicalizeGoalPhases(
        splitGoal,
        surface,
        searchTarget,
        comparisonCriteria,
        commitAction,
      );
      if (canonicalized.length >= 2) {
        return canonicalized;
      }
    }

    const actionMarkers = this.extractGoalActionMarkers(normalizedGoal);
    const derivedSteps: string[] = [];

    if (actionMarkers.includes('open_or_start')) {
      derivedSteps.push(
        surface
          ? `Open or reuse ${surface}.`
          : 'Open or navigate to the correct working surface for the request.',
      );
    }

    if (actionMarkers.includes('search')) {
      derivedSteps.push(
        surface
          ? `Open or reuse ${surface} and search for ${searchTarget || 'the requested item or information'}.`
          : `Search for ${searchTarget || 'the requested item or information'} on the correct visible surface.`,
      );
    }

    if (actionMarkers.includes('compare')) {
      derivedSteps.push(
        `Compare the visible candidates or details that match the request${
          comparisonCriteria ? ` using ${comparisonCriteria}` : ''
        }.`,
      );
    }

    if (actionMarkers.includes('select')) {
      derivedSteps.push(
        `Choose the best visible candidate${
          comparisonCriteria
            ? ` using ${comparisonCriteria}`
            : ' using the requested criteria'
        }.`,
      );
    }

    if (actionMarkers.includes('commit')) {
      derivedSteps.push(
        commitAction
          ? `Open the selected result and ${commitAction}.`
          : 'Open the selected result and perform the requested final action.',
      );
    }

    if (actionMarkers.includes('monitor')) {
      derivedSteps.push(
        'Monitor the current session until the requested endpoint is visibly reached.',
      );
    }

    if (actionMarkers.includes('transcript')) {
      derivedSteps.push(
        'Capture or generate the requested transcript from the visible result.',
      );
    }

    if (actionMarkers.includes('summary')) {
      derivedSteps.push(
        'Prepare the requested summary or final answer from the grounded visible result.',
      );
    }

    return derivedSteps.length > 0 ? derivedSteps : [normalizedGoal];
  }

  scorePlannerStepQuality(
    goal: string,
    steps: string[],
  ): {
    score: number;
    weak: boolean;
    reasons: string[];
  } {
    const normalizedSteps = steps
      .map((step) => step.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const reasons: string[] = [];
    let score = 100;

    if (normalizedSteps.length < 2 || normalizedSteps.length > 5) {
      score -= 25;
      reasons.push('step_count_out_of_range');
    }

    const goalTokens = this.extractGoalSignalTokens(goal);
    const stepCorpus = normalizedSteps.join(' ').toLowerCase();
    const goalOverlap = goalTokens.filter((token) =>
      stepCorpus.includes(token),
    ).length;

    if (goalTokens.length > 0 && goalOverlap === 0) {
      score -= 40;
      reasons.push('no_goal_overlap');
    }

    const goalActionMarkers = this.extractGoalActionMarkers(goal);
    const missingGoalActions = goalActionMarkers.filter((marker) => {
      switch (marker) {
        case 'search':
          return !normalizedSteps.some((step) =>
            /\b(search|find|look up|browse)\b/i.test(step),
          );
        case 'compare':
          return !normalizedSteps.some((step) =>
            /\b(compare|review|inspect|evaluate|narrow|top \d+|popular|rating|reviews?)\b/i.test(
              step,
            ),
          );
        case 'select':
          return !normalizedSteps.some((step) =>
            /\b(pick|choose|select|finali[sz]e|narrow)\b/i.test(step),
          );
        case 'commit':
          return !normalizedSteps.some((step) =>
            /\b(add to cart|cart|checkout|buy|purchase|book|pay|submit|send)\b/i.test(
              step,
            ),
          );
        case 'open_or_start':
          return !normalizedSteps.some((step) =>
            /\b(open|go to|navigate|play|watch|listen|join|attend|start|resume)\b/i.test(
              step,
            ),
          );
        case 'monitor':
          return !normalizedSteps.some((step) =>
            /\b(monitor|wait|stay|continue)\b/i.test(step),
          );
        case 'transcript':
          return !normalizedSteps.some((step) =>
            /\b(transcript|transcribe)\b/i.test(step),
          );
        case 'summary':
          return !normalizedSteps.some((step) =>
            /\b(summary|summari[sz]e|summarise|recap|notes?)\b/i.test(step),
          );
        default:
          return false;
      }
    });

    if (missingGoalActions.length > 0) {
      score -= missingGoalActions.length * 18;
      for (const marker of missingGoalActions) {
        reasons.push(`missing_goal_action:${marker}`);
      }
    }

    const normalizedGoalPhases = this.splitGoalIntoActionPhases(goal)
      .map((phase) => phase.replace(/\s+/g, ' ').trim().toLowerCase())
      .filter(Boolean);
    const literalFragmentCount = normalizedSteps.filter((step) => {
      const normalized = step.toLowerCase();
      return normalizedGoalPhases.some(
        (phase) =>
          phase === normalized ||
          phase.includes(normalized) ||
          normalized.includes(phase),
      );
    }).length;

    if (
      normalizedGoalPhases.length >= 2 &&
      literalFragmentCount >= Math.max(2, Math.ceil(normalizedSteps.length / 2))
    ) {
      score -= 24;
      reasons.push('literal_goal_fragment_copy');
    }

    for (const step of normalizedSteps) {
      const normalized = step.toLowerCase();
      const wordCount = step.split(/\s+/).filter(Boolean).length;
      const hasActionVerb =
        /\b(open|reuse|inspect|review|check|search|find|fill|enter|set|select|apply|launch|open|compare|verify|join|play|summari[sz]e|read|reach|choose|stop)\b/i.test(
          step,
        );
      const isVague =
        this.isTooGenericNavigationStep(step) ||
        /^(inspect current state|continue from current state|open the needed site|open the correct site|go to the relevant page|open or reuse the right page|continue the task|complete the task)\b/.test(
          normalized,
        );

      if (wordCount < 4) {
        score -= 10;
        reasons.push(`too_short:${step}`);
      }

      if (!hasActionVerb) {
        score -= 12;
        reasons.push(`missing_action:${step}`);
      }

      if (isVague) {
        score -= 20;
        reasons.push(`vague:${step}`);
      }
    }

    return {
      score,
      weak:
        score < 70 ||
        reasons.includes('no_goal_overlap') ||
        reasons.includes('literal_goal_fragment_copy') ||
        reasons.some((reason) => reason.startsWith('missing_goal_action:')) ||
        reasons.some((reason) => reason.startsWith('vague:')),
      reasons,
    };
  }

  extractGoalSignalTokens(text: string): string[] {
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

  private canonicalizeGoalPhases(
    phases: string[],
    surface: string | null,
    searchTarget: string | null,
    comparisonCriteria: string | null,
    commitAction: string | null,
  ): string[] {
    const canonicalized: string[] = [];

    for (const phase of phases) {
      const normalizedPhase = phase.replace(/\s+/g, ' ').trim();
      if (!normalizedPhase) {
        continue;
      }

      const markers = this.extractGoalActionMarkers(normalizedPhase);
      if (markers.includes('search')) {
        const phaseTarget =
          this.extractGoalSearchTarget(normalizedPhase) || searchTarget;
        canonicalized.push(
          surface
            ? `Open or reuse ${surface} and search for ${phaseTarget || 'the requested item or information'}.`
            : `Search for ${phaseTarget || 'the requested item or information'} on the correct visible surface.`,
        );
        continue;
      }

      if (markers.includes('compare')) {
        canonicalized.push(
          `Compare the visible candidates or details that match the request${
            comparisonCriteria ? ` using ${comparisonCriteria}` : ''
          }.`,
        );
        continue;
      }

      if (markers.includes('select')) {
        canonicalized.push(
          `Choose the best visible candidate${
            comparisonCriteria
              ? ` using ${comparisonCriteria}`
              : ' using the requested criteria'
          }.`,
        );
        continue;
      }

      if (markers.includes('commit')) {
        canonicalized.push(
          commitAction
            ? `Open the selected result and ${commitAction}.`
            : 'Open the selected result and perform the requested final action.',
        );
        continue;
      }

      if (markers.includes('summary')) {
        canonicalized.push(
          'Prepare the requested summary or final answer from the grounded visible result.',
        );
        continue;
      }

      if (markers.includes('transcript')) {
        canonicalized.push(
          'Capture or generate the requested transcript from the visible result.',
        );
        continue;
      }

      if (markers.includes('monitor')) {
        canonicalized.push(
          'Monitor the current session until the requested endpoint is visibly reached.',
        );
        continue;
      }

      if (markers.includes('open_or_start')) {
        canonicalized.push(
          surface
            ? `Open or reuse ${surface}.`
            : 'Open or navigate to the correct working surface for the request.',
        );
        continue;
      }

      canonicalized.push(normalizedPhase);
    }

    return Array.from(
      new Set(
        canonicalized
          .map((step) => step.replace(/\s+/g, ' ').trim())
          .filter(Boolean),
      ),
    );
  }

  private extractGoalSurface(goal: string): string | null {
    const match = goal.match(
      /\b(?:on|in|at)\s+([A-Za-z0-9][A-Za-z0-9 .&'/-]*?)(?:\s+(?:then|and then|after that|finally|pick|choose|select|finali[sz]e|add|buy|purchase|submit|send|book|review|compare|check)\b|$)/i,
    );

    return match?.[1]
      ? match[1]
          .trim()
          .split(/\s+/)
          .map((part) =>
            part.length > 1
              ? `${part[0].toUpperCase()}${part.slice(1)}`
              : part.toUpperCase(),
          )
          .join(' ')
      : null;
  }

  private extractGoalSearchTarget(goal: string): string | null {
    const patterns = [
      /\bsearch(?:\s+about|\s+for)?\s+(.+?)(?:\s+on\s+[A-Za-z0-9][A-Za-z0-9 .&'/-]*)?(?:\s+(?:then|and then|after that|finally|and\s+(?:summari[sz]e|compare|review|inspect|pick|choose|select|finali[sz]e|add|buy|purchase|submit|send|book))\b|$)/i,
      /\bfind\s+(.+?)(?:\s+on\s+[A-Za-z0-9][A-Za-z0-9 .&'/-]*)?(?:\s+(?:then|and then|after that|finally|and\s+(?:summari[sz]e|compare|review|inspect|pick|choose|select|finali[sz]e|add|buy|purchase|submit|send|book))\b|$)/i,
      /\blook up\s+(.+?)(?:\s+on\s+[A-Za-z0-9][A-Za-z0-9 .&'/-]*)?(?:\s+(?:then|and then|after that|finally|and\s+(?:summari[sz]e|compare|review|inspect|pick|choose|select|finali[sz]e|add|buy|purchase|submit|send|book))\b|$)/i,
    ];

    for (const pattern of patterns) {
      const match = goal.match(pattern);
      if (match?.[1]) {
        return match[1].trim().replace(/[.]+$/g, '');
      }
    }

    return null;
  }

  private extractGoalComparisonCriteria(goal: string): string | null {
    const normalized = goal.toLowerCase();
    const criteria: string[] = [];

    if (/\b(latest|recent|newest|today'?s)\b/.test(normalized)) {
      criteria.push('recency');
    }
    if (/\b(review|reviews|rating|ratings|star|stars)\b/.test(normalized)) {
      criteria.push('ratings and reviews');
    }
    if (
      /\b(popular|top \d+|best seller|bestseller|most popular)\b/.test(normalized)
    ) {
      criteria.push('popularity');
    }
    if (/\b(price|cheap|cheapest|lowest price|budget)\b/.test(normalized)) {
      criteria.push('price');
    }

    return criteria.length > 0
      ? Array.from(new Set(criteria)).join(' and ')
      : null;
  }

  private extractGoalCommitAction(goal: string): string | null {
    const match = goal.match(
      /\b(add(?: it)? to (?:the )?cart|checkout|buy(?: it)?|purchase(?: it)?|book(?: it)?|submit(?: it)?|send(?: it)?|place the order)\b/i,
    );

    if (!match?.[1]) {
      return null;
    }

    return match[1]
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^./, (char) => char.toLowerCase());
  }

  private splitGoalIntoActionPhases(goal: string): string[] {
    const primarySplit = goal
      .split(
        /\s*(?:;\s*|(?:^|\s)then\s+|(?:^|\s)and then\s+|(?:^|\s)after that\s+|(?:^|\s)finally\s+)\s*/i,
      )
      .map((part) => part.trim())
      .filter(Boolean);

    const secondarySplit = primarySplit.flatMap((part) => {
      const andParts = part
        .split(/\s+\band\b\s+/i)
        .map((candidate) => candidate.trim())
        .filter(Boolean);

      if (andParts.length < 2) {
        return [part];
      }

      const rebuilt: string[] = [];
      let current = andParts[0];

      for (let index = 1; index < andParts.length; index += 1) {
        const candidate = andParts[index];
        if (this.startsWithActionClause(candidate)) {
          rebuilt.push(current.trim());
          current = candidate;
          continue;
        }

        current = `${current} and ${candidate}`.trim();
      }

      rebuilt.push(current.trim());
      return rebuilt.filter(Boolean);
    });

    return secondarySplit.filter(Boolean);
  }

  private startsWithActionClause(text: string): boolean {
    return /^(search|find|open|go to|navigate|compare|review|inspect|check|pick|choose|finali[sz]e|select|narrow|filter|sort|add|send|submit|book|buy|purchase|pay|join|attend|play|start|resume|monitor|wait|generate|create|prepare|summari[sz]e|summarise|transcribe)\b/i.test(
      text.trim(),
    );
  }

  private extractGoalActionMarkers(goal: string): string[] {
    const normalized = goal.toLowerCase();
    const markers: string[] = [];

    if (/\b(search|find|look up|browse)\b/.test(normalized)) {
      markers.push('search');
    }
    if (
      /\b(compare|review|inspect|evaluate|top \d+|most popular|best|positive reviews|ratings?)\b/.test(
        normalized,
      )
    ) {
      markers.push('compare');
    }
    if (/\b(pick|choose|select|finali[sz]e|narrow)\b/.test(normalized)) {
      markers.push('select');
    }
    if (/\b(add to cart|cart|checkout|buy|purchase|book|pay|submit|send)\b/.test(normalized)) {
      markers.push('commit');
    }
    if (/\b(play|watch|listen|join|attend|open)\b/.test(normalized)) {
      markers.push('open_or_start');
    }
    if (/\b(monitor|wait|until it ends|until it finishes|stay in)\b/.test(normalized)) {
      markers.push('monitor');
    }
    if (/\b(transcript|transcribe)\b/.test(normalized)) {
      markers.push('transcript');
    }
    if (/\b(summary|summari[sz]e|summarise|recap|notes?)\b/.test(normalized)) {
      markers.push('summary');
    }

    return markers;
  }

  private enforcePlannerStepCount(goal: string, steps: string[]): string[] {
    void goal;
    const normalized = steps
      .map((step) => step.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    if (normalized.length <= 5) {
      return normalized;
    }

    const kept = normalized.slice(0, 4);
    kept.push(normalized.slice(4).join(' Then '));
    return kept;
  }

  private isTooGenericNavigationStep(step: string): boolean {
    const normalized = step.toLowerCase();
    return (
      /^(open|go to|navigate to|visit|reuse)\b/.test(normalized) &&
      !/\b(search|type|enter|fill|select|sort|filter|compare|review|choose|add|cart|results|form|visible|stop|until|when)\b/.test(
        normalized,
      )
    );
  }

  private splitSinglePlannerStep(step: string): string[] {
    const normalizedStep = step.trim();
    if (!normalizedStep) {
      return [];
    }

    const splitOnStrongConnectors = normalizedStep
      .split(
        /\s*(?:;\s*then|;\s*|(?:^|\s)then\s+|(?:^|\s)next\s+|(?:^|\s)after that\s+)\s*/i,
      )
      .map((part) => part.trim())
      .filter(Boolean);

    if (splitOnStrongConnectors.length >= 2) {
      return splitOnStrongConnectors;
    }

    return [normalizedStep];
  }

  private stripPlannerStepBoilerplateStopClause(step: string): string {
    return step
      .replace(/\s+and\s+stop\s+when\s+.+$/i, '')
      .replace(/\s+and\s+stop\s+once\s+.+$/i, '')
      .replace(
        /\s+stop\s+when\s+the\s+(?:relevant|needed|visible|requested).+$/i,
        '',
      )
      .replace(
        /\s+stop\s+once\s+the\s+(?:relevant|needed|visible|requested).+$/i,
        '',
      )
      .trim();
  }
}
