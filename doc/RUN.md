# Run Allyra Locally

This guide matches the current `gem_bot` repo.

Repo paths on this machine:

- repo root: `c:\Users\tushx\Downloads\gembot`
- app root: `c:\Users\tushx\Downloads\gembot\gem_bot`

## Prerequisites

- Docker Desktop
- at least one supported model provider key
- Gemini key strongly recommended for current desktop execution and media flow

## Environment File

Edit [docker/.env](/c:/Users/tushx/Downloads/gembot/gem_bot/docker/.env).

Minimal example:

```env
GEMINI_API_KEY=your_gemini_key_here
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
```

Useful model overrides:

```env
COMPUTER_USE_MODEL=gemini-2.5-computer-use-preview-10-2025
MEDIA_TRANSCRIPTION_MODEL=gemini-2.5-flash
MEDIA_SUMMARY_MODEL=gemini-2.5-flash
```

## Start The Stack

From `c:\Users\tushx\Downloads\gembot\gem_bot`:

```powershell
docker compose -f .\docker\docker-compose.yml --env-file .\docker\.env up -d
```

From `c:\Users\tushx\Downloads\gembot`:

```powershell
docker compose -f .\gem_bot\docker\docker-compose.yml --env-file .\gem_bot\docker\.env up -d
```

Open:

- UI: `http://localhost:9992`
- agent API: `http://localhost:9991`
- desktop API: `http://localhost:9990`

If `localhost` is flaky on Windows here, try `http://127.0.0.1:9992`.

## Rebuild When Code Changes

Rebuild only the service you changed if possible.

Rebuild all three main app services:

```powershell
docker compose -f .\gem_bot\docker\docker-compose.yml build --no-cache bytebot-agent bytebot-desktop bytebot-ui
docker compose -f .\gem_bot\docker\docker-compose.yml up -d --force-recreate bytebot-agent bytebot-desktop bytebot-ui
```

Rebuild only the agent:

```powershell
docker compose -f .\gem_bot\docker\docker-compose.yml build --no-cache bytebot-agent
docker compose -f .\gem_bot\docker\docker-compose.yml up -d --force-recreate bytebot-agent
```

Rebuild only the desktop runtime:

```powershell
docker compose -f .\gem_bot\docker\docker-compose.yml build --no-cache bytebot-desktop
docker compose -f .\gem_bot\docker\docker-compose.yml up -d --force-recreate bytebot-desktop
```

Rebuild only the UI:

```powershell
docker compose -f .\gem_bot\docker\docker-compose.yml build --no-cache bytebot-ui
docker compose -f .\gem_bot\docker\docker-compose.yml up -d --force-recreate bytebot-ui
```

## Verify The Stack

Check service state:

```powershell
docker compose -f .\gem_bot\docker\docker-compose.yml ps
```

Expected services:

- `bytebot-agent`
- `bytebot-desktop`
- `bytebot-ui`
- `bytebot-postgres`

Quick health checks:

- open the UI
- create a short task
- confirm the task appears in the list
- confirm the desktop loads

## What A Healthy Task Should Look Like

For a normal task you should expect:

1. your prompt
2. one startup question
3. your reply or `Proceed`
4. one `Plan:` preview
5. step progress while Allyra works
6. a real result
7. parked review in the same task

For a follow-up in the same task:

1. send the next instruction
2. Allyra asks one startup question for that follow-up turn
3. you reply or click `Proceed`
4. it continues on the new goal

For a media task:

1. one combined startup question if needed
2. route to the platform
3. verify playback or join state
4. record if transcript or summary is requested
5. monitor until the real end
6. transcribe and summarize if requested
7. park for review

## Current Behavioral Notes

- `NEEDS_REVIEW` can mean either:
  - waiting for the startup-question answer
  - final parked result waiting for the user
- `NEEDS_HELP` should mean a true human-needed blocker
- setup-only summaries should auto-continue instead of parking as a final result
- browser/app startup now favors speed over deep verification
- saved sessions and credentials auto-resolve mainly for explicit auth or open-existing-account tasks, not for every generic task

## Current Limitations You Should Know

- Older runnable tasks can block newer ones. If a stale task is still `RUNNING` or `PENDING`, the scheduler may keep picking it first.
- Media completion still depends partly on heuristics.
- Browser launch is faster now, but not strictly verified before every task continues.
- If the running Docker containers are stale, behavior may not match the current source tree until the right services are rebuilt.

## Troubleshooting

### Tasks Feel Stuck Or A New Task Does Not Start

- check whether an older task is still `RUNNING` or `PENDING`
- cancel stale tasks before retrying
- if you recently changed backend code, rebuild `bytebot-agent`

Useful log command:

```powershell
docker logs bytebot-agent --tail 200
```

### UI Loads But The Desktop Flow Is Laggy

- rebuild `bytebot-desktop`
- confirm desktop service is reachable on `http://localhost:9990`
- remember that the current desktop runtime returns faster from app-open actions, so some visible settling still happens after launch

### Startup Question Loops

That is not expected current behavior.

Check whether:

- the running agent container is stale
- the task resumed from an older build
- the same task is carrying old state from before the latest patch

Best retry path:

1. cancel the stale task
2. rebuild `bytebot-agent`
3. create a fresh task

### Setup Was Treated As Completion

That is also not expected current behavior.

The current source has setup-summary auto-continue protection. If you still see this, inspect the latest task run and confirm the deployed agent build includes the patch.

### Saved Credentials Were Not Reused

Check whether the task wording clearly signals:

- sign in
- log in
- open inbox
- open account
- open calendar
- continue in meet, teams, drive, or similar account surface

Generic wording may not trigger auto-resolution.

### Audio Is Silent

Rebuild `bytebot-desktop`, refresh the UI, and check audio status:

```powershell
Invoke-RestMethod http://localhost:9992/api/proxy/desktop-audio/status
```

### Rate Limits Or Provider Latency

- prefer Gemini Flash for repetitive tasks when possible
- keep fewer long-running tasks active
- inspect `bytebot-agent` logs
- remember the current repo now has Gemini timeout protection, so some failures should now surface as faster errors instead of silent hangs
