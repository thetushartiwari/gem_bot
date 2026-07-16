# Allyra Architecture

This document describes the current `gem_bot` architecture after the recent planner/executor simplification patches.

The product is Allyra. The codebase still uses many Bytebot names internally.

## Main Services

| Service | Internal name | Role |
|---|---|---|
| UI | `bytebot-ui` | Task creation, task chat, live desktop, execution trace display |
| Agent | `bytebot-agent` | Task lifecycle, preflight, planning, Gemini calls, execution orchestration, summaries, media finalization |
| Desktop | `bytebot-desktop` | Screenshots, browser/app launch, mouse/keyboard, file actions, audio recording, desktop stream |
| Database | `postgres` | Tasks, messages, files, summaries, saved sessions, saved credentials |

## Current High-Level Execution Model

The current model is:

1. create a task
2. store the initial user message
3. scheduler picks a runnable task
4. preflight decides whether to ask one startup question or proceed
5. planner stores a short plan, plan steps, and guidelines for the turn
6. Gemini computer use executes on the desktop
7. runtime verifies progress and only escalates on real blockers
8. task parks for review when the result is ready

The key simplification is that the system is trying to behave more like:

- one startup question
- one plan
- one main executor handoff
- recovery only when needed

and less like:

- planner loop
- parser loop
- setup summary treated as completion
- repeated `needs attention` for ordinary browsing

## Task State Model

Task state lives partly in normal task columns and partly in the JSON security state.

### Important Task Statuses

- `PENDING`
  created and waiting to be run
- `RUNNING`
  currently owned by the assistant/runtime
- `NEEDS_REVIEW`
  waiting for user input, either for preflight or after a finished result
- `NEEDS_HELP`
  real human-needed blocker
- `COMPLETED`
  closed terminal task
- `FAILED`
  runtime/provider failure
- `CANCELLED`
  cancelled by user or system action

### Important Security State Areas

#### `session`

Tracks the task-level conversational state:

- whether the task should stay open until the user says `done`
- whether the session is `active`, `waiting_user`, `needs_attention`, `paused`, or `closed`
- whether Allyra is in `normal`, `media`, or `meeting` mode
- the latest `currentTurnGoal`

#### `preflight`

Tracks the per-turn startup/planning state:

- `turnId`
- `turnKind`
- `questionAsked`
- `questionAnswered`
- `executionStarted`
- `awaitingUserResponse`
- `followUpPending`
- `question`
- `plan`
- `planSteps`
- `guidelines`
- `reason`
- `askedAt`
- `confirmedAt`

This is the part that enforces the "one startup question per turn" contract.

#### `media`

Tracks media-specific routing, monitoring, recording, transcription, summary, and end-state details.

## Scheduler And Queue Behavior

The current repo allows multiple immediate tasks to exist at the same time.

The scheduler then finds the next runnable task from tasks in:

- `RUNNING`
- `PENDING`

ordered by:

- `executedAt`
- `priority`
- `queuedAt`
- `createdAt`

Practical effect:

- a newer task does not automatically cancel older interactive tasks
- an older runnable task can still get picked before a newer one
- if a stale task is still `RUNNING` or `PENDING`, it can make the app feel stuck on older work

## Preflight Architecture

Preflight lives mainly in [agent.processor.ts](/c:/Users/tushx/Downloads/gembot/gem_bot/packages/bytebot-agent/src/agent/agent.processor.ts) and the resume logic in [tasks.service.ts](/c:/Users/tushx/Downloads/gembot/gem_bot/packages/bytebot-agent/src/tasks/tasks.service.ts).

### Current Normal-Task Flow

For non-media tasks:

1. if preflight is already confirmed for the current turn, continue
2. otherwise run one planner preflight pass
3. if the request is clear and low-risk, the planner should proceed or ask one short confirmation question
4. if the planner asks, the task is parked in `NEEDS_REVIEW`
5. when the user replies or clicks `Proceed`, `resume()` marks that existing preflight as answered instead of starting a second startup loop
6. the second pass should proceed and store the plan, plan steps, and guidelines

Important current behaviors:

- generic second-pass startup questions are normalized back to `proceed`
- parse failure on the second pass now proceeds instead of looping
- parse failure on the first pass falls back to one clarification question

### Media Preflight

Media tasks use a dedicated media preflight path first.

That path:

1. tries to infer enough route and preference data from the original request
2. if not enough is known, asks one combined media startup question
3. after the reply, applies the parsed reply or conservative defaults
4. stores a media-focused plan and continues

This is meant to preserve:

- one startup question
- no second startup question after the reply

## Planning Model

The planner prompt currently returns structured JSON with:

- `decision`
- `reason`
- `question`
- `plan`
- `plan_steps`
- `guidelines`

The current prompt direction is deliberately calmer than before:

- keep plan steps short
- keep guidelines short
- reuse useful current state
- verify between steps
- stop once the requested result is visible
- ask for help only on real blockers

The planner is supposed to produce:

- usually 2 to 3 plan steps
- never more than 5
- query-derived steps rather than hardcoded domain templates

## Executor Architecture

Execution lives mainly in [computer-use-executor.service.ts](/c:/Users/tushx/Downloads/gembot/gem_bot/packages/bytebot-agent/src/agent/computer-use-executor.service.ts).

### Current Direction

The current patched executor is intentionally less aggressive than the newer over-classifying version.

Main changes now in effect:

- simpler mode settings
- less repeated-action escalation in the hot path
- less eager human-attention escalation in ordinary checkpoints
- fallback verification uses a simpler screenshot review path
- auth context detection is simpler

### What The Executor Should Do

1. use the planner step currently being executed
2. inspect the current visible state
3. take actions on the desktop
4. verify the result of the step
5. continue, recover, or escalate depending on what is visible

### Setup-Only State Protection

The agent now has a setup-summary guard.

If the assistant text is just a setup-only summary such as:

- desktop is visible
- browser needs to be opened
- app was opened but task work has not started

the runtime should auto-continue instead of treating that summary as a final result.

That protection lives in [agent.processor.ts](/c:/Users/tushx/Downloads/gembot/gem_bot/packages/bytebot-agent/src/agent/agent.processor.ts).

## Desktop Runtime

Desktop execution lives in [computer-use.service.ts](/c:/Users/tushx/Downloads/gembot/gem_bot/packages/bytebotd/src/computer-use/computer-use.service.ts).

The recent patch changed the hot app-open path.

### Current Startup Behavior

If an application is already open:

- desktop tries to focus it
- desktop tries to maximize it
- desktop returns quickly without waiting for deep verification

If an application is not open:

- desktop launches it
- desktop returns quickly without waiting for strict verified fullscreen/maximize success

This makes startup faster and reduces lag, but it also means:

- browser/window polish is best-effort
- the agent must still verify useful visible state after launch

## Action Mapping

Action translation lives in [action-mapper.ts](/c:/Users/tushx/Downloads/gembot/gem_bot/packages/bytebot-agent/src/agent/action-mapper.ts).

Relevant current choices:

- browser open returns `about:blank`
- navigation waits are longer than before to reduce racing page loads
- short wait actions are no longer effectively no-ops

This is part of the "be slightly slower between browser actions so the whole run is more stable" strategy.

## Saved Sessions And Credentials

Saved session and credential behavior is split between:

- [tasks.controller.ts](/c:/Users/tushx/Downloads/gembot/gem_bot/packages/bytebot-agent/src/tasks/tasks.controller.ts)
- [browser-sessions.service.ts](/c:/Users/tushx/Downloads/gembot/gem_bot/packages/bytebot-agent/src/tasks/browser-sessions.service.ts)

### Current Matching Rules

Automatic saved-auth resolution mainly happens only when the task clearly looks like:

- explicit sign-in
- opening an already signed-in account surface

The browser-session matcher was recently relaxed:

- lower non-explicit threshold than before
- softer provider-family bonuses for Google and Microsoft account surfaces

But generic browser tasks still do not blindly auto-attach saved auth.

### Why That Matters

This keeps the system from overfitting every task to saved auth, but it also means some tasks may still start cold unless the wording clearly signals:

- sign in
- open inbox
- open calendar
- open drive
- continue in account

## UI Architecture

The UI currently groups visible progress messages such as:

- `Plan:`
- `Planner:`
- `Verification:`
- `Watchdog:`
- `Progress:`
- `Completed:`
- `Task result ready:`
- `I hit a blocker:`
- `I need your attention:`

Execution traces now show the raw step description more directly instead of heavily rewriting it.

That makes debugging easier because the UI hides less planner/executor context than before.

## Media Architecture

Media state lives in both:

- `security.media`
- execution state inside the task

The current media path is:

1. route the task
2. get through one media preflight turn
3. open the platform
4. verify the requested media or meeting
5. record audio when appropriate
6. monitor using audio-first logic plus periodic visual checks
7. transcribe and summarize after the real end

Current defaults:

- video-like tasks tend to route to YouTube
- meetings use the named platform or Google Meet

Current caveat:

- completion still depends partly on heuristics such as silence, autoplay detection, short-form replay detection, and near-end timing checks

## Model Split

Current model roles are:

- UI-selected task model for preflight, planning, and general reasoning
- Gemini computer use for desktop action execution
- Gemini Flash for lighter screenshot interpretation and media transcription/summary paths

The current repo also keeps a hard timeout wrapper around Gemini calls so provider stalls fail faster instead of hanging forever.

## What A Healthy End-To-End Task Looks Like

For a normal task:

1. task is created
2. one startup question is shown
3. user replies or clicks `Proceed`
4. a short `Plan:` preview is shown
5. execution progresses through the browser/app
6. setup-only states do not park the task
7. result is summarized
8. task parks for review in the same session

For a follow-up:

1. user sends more instructions in the parked task
2. the latest instruction becomes the new turn goal
3. one startup question is asked for that follow-up turn
4. after reply, execution continues against the new goal

For a media task:

1. one combined startup question if needed
2. route/platform choice
3. playback or join verification
4. recording if requested
5. monitoring
6. transcription/summary after the real end
7. parked result for review

## Current Known Weak Spots

- The security state and planner flow are still more complex than the old backup repo. The current patches simplify behavior, but the code is not fully reduced yet.
- `NEEDS_REVIEW` still carries two meanings: startup-question waiting and final parked result.
- Older runnable tasks can still block newer ones because the scheduler picks one runnable task at a time.
- Saved-auth auto-resolution is still conservative by design.
- Media flow is improved, but not fully free from heuristic edge cases.
