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
      // ── DSH_E2E_GATEWAY: 星模网关模式跳过清单（2026-11-10 簇 A composition 根治后收缩：26 → 12）──
      // 簇 A 真根因（branding commit 428e8aa3ff 在 base bundle 关闭 extensions 组合行但漏关
      // plugin-package-inventory-deepseek → 插件永远 pending + 子进程无 deepseek-official
      // adapter）已由 base patch 修正 + 各套件组合构造处显式恢复官方 adapter 治愈。
      // 原 26 项中 14 项本地真跑全绿并移出本清单（治愈优先于隔离）；保留 12 项的真因
      // 与组合无关，逐项注释如下。title 相关条目另有专人；e2e.yml 不在本战役范围。
      'apps/cli/tests/profiles/sdk/dynamic-tool-cache.e2e.ts',
      // ↑ 组合已修（adapter + extensions 恢复，turn 真跑通过）；红因=网关 Anthropic 根拒绝
      //   in-history system 角色（systemPromptUpdate: 'in-history' 的协议语义），官方环境绿。
      'apps/desktop/tests/welcome-flow.e2e.ts',
      // ↑ 需 built Desktop 产物（skipIf 缺产物自跳）；结构缺，非组合因子。
      'packages/core/agent-loop/tests/request-cache.e2e.ts',
      // ↑ 非 composition：turn 真跑全绿；红因=网关不回 prompt_cache_hit_tokens，cache 命中断言必红。
      'packages/llm/llm-deepseek/tests/adapter.e2e.ts',
      // ↑ 非 composition（进程内直连 adapter）：红因=/v1/files 与 in-history 模型门控（网关结构缺）。
      'packages/llm/llm-deepseek/tests/runtime.e2e.ts',
      // ↑ 非 composition：红因=vision/files 上传门控（DEEPSEEK_VISION_E2E / 网关结构缺）。
      'packages/llm/llm-pi-ai/tests/adapter.e2e.ts',
      // ↑ 非 composition：红因=网关端点协议语义（/v1 files、模型目录在册性）。
      'packages/session/session-telemetry-otel/tests/loader-composition.e2e.ts',
      // ↑ 品牌结构性：品牌 base 硬编码 telemetry mode:DISABLED（无自有 collector），
      //   FULL/FEEDBACK 激活语义与品牌组合不兼容；产品 telemetry 另有归属。
      'packages/skill/skill-office/tests/docx-validation.e2e.ts',
      // ↑ 组合 enable 已打（real-office.ts）；本地无 DSH_PRIMARY_RUNTIME 自跳未验，待 CI 终验。
      'packages/skill/skill-office/tests/render-tools.e2e.ts',
      // ↑ 同 docx-validation。
      'packages/skill/skill-office/tests/visual-intent.e2e.ts',
      // ↑ 同 docx-validation；另需网关 vision 语义。
      'packages/skill/skill-office/tests/xlsx-validation.e2e.ts',
      // ↑ 同 docx-validation。
      'packages/subagent/subagent-claude-code/tests/real-deepseek.e2e.ts',
      // ↑ 非 composition：claude-agent-sdk 经网关 Anthropic 根的端点语义因子。
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
