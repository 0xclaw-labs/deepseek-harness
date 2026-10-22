# 桌面端自动更新：两种构建与验收

本文是随身搭子桌面端（`apps/desktop`）自动更新的运维说明。它记录**已经实现**
的策略，不描述尚未存在的服务。

**决策（2026-10-22）：当前发布的未签名构建不提供自动更新；已签名构建必须显式
提供 PaiNuo 更新源。二者不可混为一谈——"禁用更新"不等于"已提供更新源"。**

理由：

1. 目前没有 PaiNuo 自有的更新分发服务。上游的 `download.deepseek.com` 是
   DeepSeek 运营的服务，品牌构建永不回退到它。
2. GitHub Releases 被评估为候选 feed，但未采用：`0xclaw-labs/*` 仓库的可见性
   未确认，generic feed 需要一个对终端用户公开可达、由我们控制的 HTTPS origin；
   而且未签名构建即使拿到新版本也无法用代码签名验证更新包，等于开通一条把
   未签名产物投递到用户机器的通道。
3. 因此未签名构建保持"无 feed"，但**不再伪装成检查失败**：UI 明确说明本构建
   不提供自动更新（见下）；已签名构建仍 fail-closed，缺 origin 直接拒绝打包。

## 1. 两种构建的验收标准

| | 未签名 / 无 feed 构建（当前发布） | 已签名 + PaiNuo feed 构建 |
|---|---|---|
| 打包 | `--unsigned`，`publish: null`，包内无 `app-update.yml` | 必须显式 `DSH_DESKTOP_UPDATE_ORIGIN`（非 DeepSeek host），包内写入 `app-update.yml` |
| 运行时 | `update-source.ts` 判定 `absent`：不发任何网络请求 | 判定 `configured`：校验 provider/URL/channel 后才允许检查 |
| UI | "本构建不提供自动更新"（`updateUnavailableAbsent*`），无重试按钮 | 正常检查/下载/安装流程 |
| 检查更新菜单 | 显示上述说明，不调用 updater | 正常检查 |
| 失败表现 | 无失败状态、无 error phase | 网络/下载/安装失败按既有分类展示 |
| 禁止 | 任何 `no packaged update source` 原始报错、假检查、"已是最新" | 回退 DeepSeek host、非 generic provider、channel 不一致 |

验收命令（未签名构建）：

```sh
# 1) 运行时策略：无 env fail-closed、DeepSeek host 拒绝、品牌 host 接受
npx vitest run apps/desktop/tests/update-source.spec.ts
# 2) coordinator 在无 feed 时不联网、不发布失败
npx vitest run apps/desktop/tests/update-coordinator.spec.ts
# 3) UI 诚实（菜单路径 + 双语文案）
npx vitest run apps/desktop/tests/update-presentation.spec.ts apps/desktop/tests/main-startup.spec.ts -t "update source"
# 4) 打包侧 fail-closed（production 必须显式 origin；拒绝 deepseek.com）
npx vitest run apps/desktop/tests/desktop-auto-update-environment.spec.ts apps/desktop/tests/desktop-publish-config.spec.ts
```

真机确认（已安装的未签名包）：

```sh
ls "/Applications/随身搭子.app/Contents/Resources/app-update.yml"   # 应不存在
```

## 2. 已签名 feed 的发布流程（首次签名发布前必须完成）

feed 布局由 `desktop-auto-update-environment.mjs` 与 `desktop-upload-plan.ts`
共同决定：

```text
<origin>/<DSH_DESKTOP_UPDATE_RELEASE_PREFIX>/feeds/<target>/<channel>[-mac].yml
<origin>/<DSH_DESKTOP_UPDATE_RELEASE_PREFIX>/bin/<target>[/latest]/<artifact>
```

- `target`：`mac-arm64` | `mac-x64` | `win-x64`
- `channel`：`nightly`（默认，允许预发布）| `latest`（必须稳定版本）
- 元数据文件名：`nightly-mac.yml` / `latest.yml` 等，由
  `desktopUpdateMetadataFilename()` 生成
- 打包时 electron-builder 生成原始元数据，上传时 `desktop-upload-plan.ts` 把
  `files[].url` / `path` 改写为公开对象 URL 后再上传

发布步骤：

1. 打包（已签名）：`DSH_DESKTOP_UPDATE_ORIGIN=https://<PaiNuo origin>` +
   `DSH_DESKTOP_AUTO_UPDATE_ENV=production`，走
   `pnpm run package:mac:arm64`（或 win）——缺 origin 会在打包前报错。
2. 上传：`pnpm run upload:mac:arm64` 等（需要 COS 凭据与 `publishing/production.json`）。
3. 校验已发布的 feed（本仓库脚本，只读）：

   ```sh
   node scripts/custom/verify-brand-update-feed.mjs \
     --dir <下载回来的 feeds/<target> 目录> \
     --target mac-arm64 --origin https://<PaiNuo origin> --version <版本>
   ```

   校验项：元数据 `version` 合法；`files[]` 的 `url`/`path` 均为 HTTPS 且非
   DeepSeek host；本地产物的 `size`/`sha512` 与元数据一致；产物文件名使用
   `custom/branding/brand.json` 的 `artifactPrefix`；channel 与 target 一致；
   `latest` 不发布预发布版本。
4. 安装上一版本，确认"检查更新"能看到新版本、下载、安装、重启后版本号更新。

已知阻塞（首个签名发布前必须解决，未签名构建不受影响）：
`signed 打包/上传/保留` 路径中仍有上游硬编码前缀 `deepseek-harness-`，与品牌
`artifactPrefix`（`suishendazi-harness`）不一致，会导致上传阶段找不到产物：

- `apps/desktop/scripts/desktop-upload-plan.ts`（`<prefix>-${version}-...`）
- `apps/desktop/scripts/package-macos.ts`
- `apps/desktop/scripts/package-target.ts`
- `apps/desktop/scripts/retain-desktop-ci.ts`
- `apps/desktop/scripts/installed-update-distribution.ts`
- `apps/desktop/scripts/desktop-build-version-discovery.ts`

`verify-brand-update-feed.mjs` 会把该不一致判为失败，因此它同时也是一道发布闸门。
修复方向：把 artifact prefix 解析收敛到一个函数（`DSH_DESKTOP_ARTIFACT_PREFIX`
→ 品牌默认值），六处共同引用，而不是各自硬编码。

## 3. 运行时校验（已实现）

`apps/desktop/src/update-source.ts` 在 coordinator 构造时解析一次
`Contents/Resources/app-update.yml`（Windows: `resources/app-update.yml`）：

- `provider` 必须是 `generic`，否则拒绝（不下放给其他传输层）；
- `url` 必须是含路径的 HTTPS origin，且无凭据/query/fragment；
- host 命中 DeepSeek deny-list（`deepseek.com`、`deepseeksvc.com` 及其子域）→ 拒绝；
- `channel` 与包内 manifest 的 `dshDesktopUpdateChannel` 不一致 → 拒绝；
- 文件不存在 → `absent`（未签名/dev/源码启动的正常状态）；读失败 → 拒绝。

任何拒绝都不会回退到第二个 feed：品牌构建只有一个受审阅的目的地。拒绝原因只进入
日志与诊断，用户看到的是本地化说明（`updateUnavailableRejected*`）。