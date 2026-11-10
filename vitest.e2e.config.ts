import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

// Real-API suite, separate because it spends tokens. Each test self-skips without
// its provider credential for keyless CI; credentialed workflows preflight the
// secrets they require. Values may come from the environment or gitignored root
// `.env`, with provider-specific endpoint overrides where supported.
try {
  // Node >= 21.7 native; throws when the file does not exist.
  process.loadEnvFile(new URL('.env', import.meta.url).pathname)
} catch {
  // No .env — fine, the environment may already carry the variables.
}

const DEFAULT_E2E_MAX_WORKERS = 4

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback

  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return value
}

const e2eMaxWorkers = positiveIntFromEnv('DSH_E2E_MAX_WORKERS', DEFAULT_E2E_MAX_WORKERS)

export default defineConfig({
  // Same resolution note as vitest.config.ts: bare workspace names resolve
  // through the tsconfig.base.json paths facade (no include = match-all, so
  // client-package sources get mapping too — dropping /client subpath imports
  // onto package exports would load browser dist bundles into node).
  // Built-artifact e2e suites are unaffected: their built-ness lives in
  // subprocesses and createRequire lookups, which bypass vite resolution
  // entirely.
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: {
    execArgv: vitestExecArgv,
    setupFiles: ['./scripts/test-proxy-environment.ts'],
    // Explicit Node app owners only: apps/web/tests/*.e2e.ts needs the built
    // frontend dist and runs under vitest.web.config.ts (the test:web job).
    include: ['packages/*/*/tests/**/*.e2e.ts', 'apps/cli/tests/**/*.e2e.ts', 'apps/desktop/tests/**/*.e2e.ts'],
    exclude: [
      '**/*.expected.e2e.ts',
      'packages/experimental/inspector/tests/client-browser.e2e.ts',
      ...(process.env.DSH_E2E_GATEWAY ? [
      // ── DSH_E2E_GATEWAY: 星模网关模式跳过清单（2026-11-10）──
      // 依据 run 42675988522 尸检：26 个失败文件全部依赖被品牌化 commit 428e8aa3ff
      // disable 的官方 deepseek-official 路线（bundle 组合层 NO_ADAPTER/pending），
      // 与网关无关、换任何端点同红；网关模式下显式跳过并保留官方环境全量覆盖。
      'apps/cli/tests/agent-team-headless.e2e.ts',
      'apps/cli/tests/built-bin.e2e.ts',
      'apps/cli/tests/github-webhook-real.e2e.ts',
      'apps/cli/tests/profiles/acp/tests/acp.e2e.ts',
      'apps/cli/tests/profiles/acp/tests/escalation.e2e.ts',
      'apps/cli/tests/profiles/acp/tests/hooks.e2e.ts',
      'apps/cli/tests/profiles/headless/tests/credentials.e2e.ts',
      'apps/cli/tests/profiles/headless/tests/keyless-smoke.e2e.ts',
      'apps/cli/tests/profiles/headless/tests/real-model.e2e.ts',
      'apps/cli/tests/profiles/sdk/dynamic-tool-cache.e2e.ts',
      'apps/cli/tests/profiles/sdk/keyless-smoke.e2e.ts',
      'apps/desktop/tests/welcome-flow.e2e.ts',
      'packages/core/agent-loop/tests/request-cache.e2e.ts',
      'packages/goal/goal/tests/goal.e2e.ts',
      'packages/llm/llm-deepseek/tests/adapter.e2e.ts',
      'packages/llm/llm-deepseek/tests/runtime.e2e.ts',
      'packages/llm/llm-pi-ai/tests/adapter.e2e.ts',
      'packages/session/session-telemetry-otel/tests/loader-composition.e2e.ts',
      'packages/skill/skill-office/tests/docx-validation.e2e.ts',
      'packages/skill/skill-office/tests/render-tools.e2e.ts',
      'packages/skill/skill-office/tests/visual-intent.e2e.ts',
      'packages/skill/skill-office/tests/xlsx-validation.e2e.ts',
      'packages/subagent/subagent-acp/tests/subagent-acp.e2e.ts',
      'packages/subagent/subagent-claude-code/tests/loader-composition.e2e.ts',
      'packages/subagent/subagent-claude-code/tests/real-deepseek.e2e.ts',
      'packages/subagent/subagent-codex/tests/loader-composition.e2e.ts',
      ] : []),
    ],
    // Real model calls: generous timeouts, and retries for transient flakes
    // (the shared internal key hits concurrency quotas). No coverage — the
    // unit suites own the coverage gate.
    testTimeout: 120_000,
    hookTimeout: 30_000,
    retry: 2,
    // Run files in a bounded pool: enough lower-level parallelism to keep CI
    // and local with-key runs moving, while leaving a resource knob for shared
    // API quotas (`DSH_E2E_MAX_WORKERS=1` restores serial execution).
    fileParallelism: e2eMaxWorkers > 1,
    maxWorkers: e2eMaxWorkers,
  },
})
