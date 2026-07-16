param(
  [string[]]$Specs = @(
    'agent.processor.spec.ts',
    'computer-use-executor.service.spec.ts'
  )
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$agentPath = Join-Path $repoRoot 'packages\bytebot-agent'
$sharedPath = Join-Path $repoRoot 'packages\shared'
$specArgs = $Specs -join ' '

docker run --rm `
  -v "${agentPath}:/src/bytebot-agent" `
  -v "${sharedPath}:/src/shared" `
  ghcr.io/bytebot-ai/bytebot-agent:edge `
  sh -lc "rm -rf /tmp/bytebot-agent && mkdir -p /tmp/bytebot-agent && cp -R /src/bytebot-agent/. /tmp/bytebot-agent && ln -s /app/bytebot-agent/node_modules /tmp/bytebot-agent/node_modules && cd /tmp/bytebot-agent && npm test -- $specArgs"
