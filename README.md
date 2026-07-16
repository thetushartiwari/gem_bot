# Allyra Docs

This folder is the local source of truth for the current `gem_bot` repo.

Allyra is the product name. Many packages, Docker services, APIs, and internal imports still use `bytebot-*`.

## Read These First

- [FLOW.md](/c:/Users/tushx/Downloads/gembot/gem_bot/doc/FLOW.md)
  The easiest end-to-end explanation of how a task should behave.
- [ARCHITECTURE.md](/c:/Users/tushx/Downloads/gembot/gem_bot/doc/ARCHITECTURE.md)
  The current service layout, task state model, planner flow, executor flow, media flow, and known caveats.
- [RUN.md](/c:/Users/tushx/Downloads/gembot/gem_bot/doc/RUN.md)
  How to run, rebuild, verify, and troubleshoot the local stack.

## Current Local Stack

- `bytebot-ui`
  Allyra web UI on `http://localhost:9992`
- `bytebot-agent`
  Planner, task orchestration, execution loop, saved-session logic, media orchestration, summaries, and result parking on `http://localhost:9991`
- `bytebot-desktop`
  Desktop runtime, VNC/live desktop stream, app launch/focus, screenshots, mouse/keyboard, browser actions, and audio capture on `http://localhost:9990`
- `postgres`
  Tasks, messages, files, summaries, saved sessions, and saved credentials

On this Windows machine, `http://127.0.0.1:9992` may work better than `http://localhost:9992` if `localhost` resolves to IPv6 first.

## What The Current Repo Is Trying To Do

The current patched flow is:

1. user creates a task or sends a follow-up
2. planner asks one startup question for that turn
3. user replies or clicks `Proceed`
4. planner stores a short turn plan plus execution guidelines
5. Gemini computer use executes that turn on the desktop
6. runtime verifies meaningful progress and only escalates on real blockers
7. when the visible result is ready, the task parks for review so the user can continue or close it

That same pattern is meant to apply to both:

- a brand-new task
- a follow-up inside an already open task

The key rule is:

- exactly one startup question per turn
- no second startup question after the user replies or clicks `Proceed`

## What Is True In The Current Code

- Preflight state is stored explicitly in task security with fields like `turnId`, `turnKind`, `questionAsked`, `questionAnswered`, `awaitingUserResponse`, `followUpPending`, `planSteps`, and `guidelines`.
- `NEEDS_REVIEW` is used both for:
  - preflight waiting state
  - final parked result waiting state
- `NEEDS_HELP` is the human-blocker state.
- Setup-only summaries such as "desktop is visible" or "browser needs to be opened" are supposed to auto-continue instead of being treated as a finished result.
- Follow-up turns create a new preflight turn and should again ask only one startup question.
- Gemini calls now have a hard timeout wrapper in the current repo, which is one of the important improvements kept from the newer code.

## Important Current Caveats

- Multiple open immediate tasks can coexist in the database. The scheduler still pulls one runnable task at a time, so an older `PENDING` or `RUNNING` task can delay a newer one until the older one completes, is canceled, or parks.
- Saved browser sessions and saved credentials are not auto-restored for every generic browser task. Auto-resolution is mainly for:
  - explicit sign-in tasks
  - tasks that clearly ask to open an already signed-in surface like inbox, calendar, drive, account, chat, or meet
- Browser startup is now optimized for speed. The desktop service tries to focus/maximize quickly, but the hot path no longer waits for strict verified fullscreen/maximize success before returning.
- Media flow is better than before, but it still uses heuristics for end detection, silence classification, and autoplay handling.
- The larger top-level `docs/` site is not fully aligned with the current local runtime. Prefer this `doc/` folder.

## What A Healthy Task Should Feel Like

- one short startup question
- one visible `Plan:` preview
- progress updates while Allyra works
- no startup-question loop
- no fake finalization on setup-only states
- result parked in the same task for review or follow-up

If the runtime instead does this:

- asks the same startup question again after `Proceed`
- says the desktop is open and parks as if the task is done
- moves into `needs attention` during ordinary search/navigation/filtering
- keeps repeating the same plan without visible forward progress

that is not the intended current behavior.
