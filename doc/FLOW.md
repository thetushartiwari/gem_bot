# Allyra Flow

This is the shortest end-to-end description of how tasks are supposed to work in the current patched repo.

## Core Turn Contract

Each user turn should behave like this:

1. planner evaluates the turn
2. planner asks one startup question for that turn
3. user replies or clicks `Proceed`
4. planner stores one turn plan and execution guidelines
5. Gemini computer use executes the turn
6. runtime verifies progress and only escalates on real blockers
7. Allyra reports the result and parks the task for review

The most important rule is:

- one startup question per turn
- no second startup question after the reply for that same turn

## What Counts As A Turn

A turn can be either:

- the first task request
- a follow-up instruction inside an already open task

Examples:

- first turn: `Open my Gmail inbox`
- follow-up turn: `search for invoices from last month`

The second message is a new turn inside the same task. It should get its own single startup question, then execute against the new goal.

## Preflight

Preflight decides whether the task can start now or needs one short question first.

### If the request is clear

Allyra should ask one short confirmation-style question such as:

- `I understand the task. Should I execute it now, or do you want to add more info first?`

### If the request is missing something important

Allyra should ask one combined clarification question that gathers the missing detail in one shot.

### After the user replies

The same turn should continue straight into planning and execution.

It should not:

- ask another startup question
- restart the same turn from scratch
- park as if a setup-only state is the final result

## Plan Shape

The planner stores:

- a short plan summary
- a short list of `planSteps`
- a short list of `guidelines`

The current target shape is:

- usually 2 to 3 steps
- never more than 5
- query-derived rather than hardcoded by task category

Good plan shape:

1. open the right place
2. do the main task work
3. verify the result

The runtime may normalize weak plans, but it should still preserve the user turn goal and the planner's intent.

## Normal Browser Tasks

Examples:

- sign in
- open inbox
- search on the web
- compare options
- fill a form
- summarize what is on screen

Healthy flow:

1. inspect the current visible state
2. reuse useful state if it helps the task
3. navigate only when needed
4. execute the current step
5. verify before moving on
6. stop as soon as the requested result is visibly ready

What should not happen:

- parking because the browser is merely open
- parking because the desktop is visible
- `needs attention` during ordinary safe browsing
- repeated planner loops in the middle of healthy progress

## Follow-Up Turns

When a task is parked and the user sends more instructions:

1. a new follow-up turn is created
2. planner asks one startup question for that follow-up turn
3. user replies or clicks `Proceed`
4. execution continues against the latest goal

The latest turn goal should dominate older context.

## Result Parking

The current repo uses parking deliberately.

### `NEEDS_REVIEW`

This can mean either:

- preflight is waiting for the user to answer the startup question
- the result is ready and the task is parked for user review or follow-up

### `NEEDS_HELP`

This should mean a real human-needed blocker such as:

- CAPTCHA
- verification challenge
- login or permission wall the agent cannot safely pass
- destructive or highly sensitive confirmation

Ordinary search, browsing, result clicks, and form navigation should not become `NEEDS_HELP`.

## Media And Meeting Tasks

Media and meeting turns still follow the same turn contract:

1. one startup question
2. one reply or `Proceed`
3. one planner-owned plan
4. executor carries it forward

Then the flow becomes more specialized:

1. choose the route
2. open the platform
3. find the requested item or meeting
4. verify playback or join state
5. record audio if transcript or summary is requested
6. monitor until the real end
7. transcribe and summarize if needed
8. park for review

Current route defaults:

- video-like tasks usually go to YouTube
- meetings use the named platform, or Google Meet if none is named

## Saved Sessions And Credentials

The current repo will try to auto-resolve saved session or saved credential state mainly for:

- explicit sign-in tasks
- tasks that clearly ask to open an existing signed-in surface

It does not currently auto-restore saved auth for every generic browser task.

## Browser Startup

Browser launch and app focus now favor speed over strict verification.

Current behavior:

- if the app looks open, desktop tries to focus/maximize it and returns quickly
- if the app is not open, desktop launches it and returns quickly

That means startup should feel faster, but strict verified fullscreen is no longer guaranteed before execution continues.

## What You Should Expect End To End

For a healthy task, you should expect:

1. your prompt
2. one startup question
3. your reply or `Proceed`
4. one visible `Plan:`
5. execution progress
6. a real result
7. the task staying open for follow-up or `done`

If the system instead:

- loops back to the same startup question
- treats setup as completion
- goes to `needs attention` during ordinary work
- repeats the same plan without visible movement

that is a bug, not the desired flow.
