# PR 描述草稿（可直接粘贴到 GitHub）

> 用法：Fork `chthollyphile/folia-major` → 从 `103be0af` 拉分支 → 用 `源码/folia-major-changes.patch` 打上 → **把 `package.json` 的 `version` 改回 `0.7.20`** → 提交 → 提 PR。标题和正文如下。
>
> 参考对象：#357（PengLx，桌面 MusicKit + 开发者令牌）与 #419（Aiymsore，Chrome 扩展 + SMTC helper）。这两个 PR 都已被关闭，本 PR 是**第三条路线**，不是它们的替代实现。

---

## 标题

```
feat(apple-music): 通过 CDP 驱动官方网页播放器接入 Apple Music（Windows 实机验证）
```

---

## 正文

Apple Music 目前在 Folia 里没有 provider。这个 PR 加了一条接入路线：**Folia 仍然拥有队列和界面，实际出声的是你自己登录的 `music.apple.com` 网页版播放器**，由本机 Electron 主进程通过 Chrome DevTools Protocol（CDP）观察状态、下发播放指令。

**为什么不走前两个 PR 的路线**

- #357 用桌面版 MusicKit SDK + 维护者签发的开发者令牌，需要 CastLabs 运行时、Widevine 签名与一个自建令牌服务；
- #419 用 Chrome 扩展 + Rust SMTC helper，需要装扩展、写 Rust、只支持 Windows 观察层；
- 本 PR 不申请开发者令牌、不引入 Widevine/CastLabs、不装扩展、不写 Rust helper：**只要用户能在浏览器里登录 Apple Music 网页版，就能用**。

代价同样明确：只对「用户本机那个浏览器」有效，依赖页面与 amp-api 的稳定性，并且存在 Apple 服务条款风险（见文末）。

### 架构：数据走页面内 fetch，播控走 CDP

```
Folia 渲染进程
   │  provider 目录：搜索 / 歌单 / 专辑 / 电台 / 歌词
   ▼
electron/appleMusicBridge.cjs ── 页面内 fetch(amp-api) ──▶ music.apple.com 同源接口
   │  （Node 侧直连返回 401，必须借页面身份）
   │
   │  队列 + 播控命令（setQueue / changeToMediaAtIndex / play / pause / seek）
   ▼
electron/nowplaying/supervisor.cjs ── fork ──▶ nowplaying/bridge.mjs（127.0.0.1:9863）
                                                      │ CDP 9222
                                                      ▼
                                        Electron 拉起的浏览器窗口（官方网页播放器）
```

- **数据面**：`electron/appleMusicBridge.cjs`（503 行）在页面上下文里执行 `fetch`，复用用户已登录的会话，不落任何令牌。
- **控制面**：`nowplaying/bridge.mjs`（1156 行）+ 62 行零依赖 CDP 客户端 `cdp-lib.mjs`，通过 `Runtime.evaluate` 调 MusicKit。
- **守护**：`nowplaying/supervisor.cjs`（190 行）用 `utilityProcess.fork` 拉起桥，退避重启（1/2/4/8/30s），端口被占用时让位给外部实例。

### 主要改动

**新增（约 2,700 行）**

- `electron/appleMusicBridge.cjs`、`electron/appleMusicBrowser.cjs` —— 数据桥与专用浏览器实例管理（拉起、复用、升级、退出清理）。
- `electron/nowplaying/`（`bridge.mjs` / `cdp-lib.mjs` / `supervisor.cjs`）—— 播放控制桥、CDP 客户端、进程守护。
- `src/services/onlineMusic/apple*.ts`（6 个文件，约 800 行）—— provider、目录、资料库、归一化、传输层、本地数据。
- `src/services/onlineMusic/externalPlaybackTarget.ts` —— 把「外部播放目标」抽象成 Folia 能理解的目标。
- `src/hooks/useAppleLibrary.ts`、`src/hooks/useAppleLoginGate.ts` —— 资料库视图与登录引导。
- `test/unit/electron/appleMusic{Bridge,Browser}.test.ts`、`nowplayingSupervisor.test.ts`（3 个文件，约 600 行）。

**改动（约 1,800 行）**

- `src/hooks/usePlaybackQueueController.ts`：Apple 曲目分流到外部目标，不进入取流。
- `src/hooks/useStagePlaybackController.ts`：放开外部镜像的三处门控，让状态能回灌。
- `src/components/.../buildPlayerViewFlags.ts`：`canToggleCurrentPlayback` 对无音源的 Apple 曲目放行。
- `src/library/core/model/accountRules.ts` 等：Apple 登录走独立引导，不落进扫码流程。
- `src/i18n/locales/{zh-CN,en}.ts`：Apple 相关文案与错误提示。

### 关键设计决策

1. **Folia 的队列是唯一权威**。`next` / `previous` 绝不透传给网页播放器；否则它会按自己的内部队列续播，两边争夺控制权。曲末靠「结束邻域 + 身份变化」判定。
2. **建队列用 `setQueue({ album })` 再 `changeToMediaAtIndex`**。用 `{ song }` 只会得到长度 1 的队列，上一首/下一首无处可去。
3. **播控验证窗口随队列长度放大**：`windowMs = min(30000, 8000 + max(0, ids.length − 20) × 40)`。固定 8 秒对大队列是假阴性，会触发整条重发（实测 477 首因此多花 13 秒）。
4. **后台实例放屏幕外，而不是 headless 或最小化**。实测：`--headless=new` 或 `--mute-audio` 时进度照走但不出声；最小化后 `document.visibilityState === 'hidden'`，MusicKit 直接拒绝播放。最终用 `--window-position=-32000,-32000` + `--autoplay-policy=no-user-gesture-required`。
5. **失败必须报错，不静默**。队列重建超时、实例升级失败都会给出可见提示，而不是「显示在放但听不到」。
6. **只在选用 Apple 音源时才启动 9863 服务**；不使用 Apple 时主进程不建桥、不开端口。

### 已知限制（实测记录，不是没做完）

- 大队列重建需要 2–6 秒：17 首 2.3s、99 首 6.4s、486 首 4.0s（服务端展开成本，与本地性能无关）。
- 只镜像待播清单的前两个控制（随机开关、循环三态）。「清空待播列表」和「无限播放」Folia 没有对应功能，**不镜像、不推断、不干扰**；也正因如此，队列长度断言不能写死。
- 无下载、无离线、无 EQ；Apple 曲目没有可播放的音频 URL（DRM）。
- 依赖网页版页面结构与 amp-api；Apple 改版会让选择器失效。
- 打包/运行的目录必须是纯 ASCII 路径（Electron 自身的限制，与本 PR 无关，但会被误认为本 PR 的 bug）。

### 验证

- `npx tsc --noEmit`：通过
- 全量单测：`npx vitest run`，共 **7,791 个用例 / 692 个文件**。连跑两遍结果不同（7,786 通过 与 7,784 通过），失败项在两遍之间会变化，属于并发下的偶发：
  - `mod-system/modSignature`（树哈希）：在纯净基线 `103be0af` 上同样失败，属既有环境问题（Windows 文件系统哈希/排序）；
  - `sync/themeSyncRegistry`（2 个）与 `onlineMusic/qqQrDiagnostics.integration`（2 个）：单文件串行运行全部通过（7 passed），只在全量并发时偶发。
- `git diff --check`：通过
- 实机（Windows 11 + Edge 43.x）：登录跳转、播放/暂停/拖进度、上一首/下一首、曲末自动下一首、歌词与逐字高亮、随机/循环镜像、队列跟随（477 首）、无声音 bug 回归验证（见下）

**关于「没声音」这条回归**：之前打包版会拉起 `--headless=new --mute-audio` 的后台实例，导致进度走但没有声音、登录也弹不出窗口。本 PR 已改为屏幕外真实窗口，并保留可见实例用于登录；相关断言写在 `test/unit/electron/appleMusicBrowser.test.ts`。

### 需要维护者定夺

1. **是否接受 CDP 控制网页播放器这条路线**。它的稳定性依赖第三方页面，且可能触及 Apple 服务条款；若不接受，我会把它保留为独立 fork（AGPL 允许），不作为上游功能。
2. **是否需要默认关闭的 feature flag**。目前行为是「选中 Apple 音源才启动」；若希望像 #419 那样加显式开关，我可以补。
3. **`package.json` 的版本号**：本分支曾改为 `1.0.0` 用于自己的发布，提交 PR 前会回退为 `0.7.20`。
4. **是否拆分非核心改动**：`electron/appleMusicBrowser.cjs` 里的浏览器启动参数（禁用扩展、禁止组件更新、防后台节流）可独立成一个小 PR。

### 本 PR 不含什么

不含 Cider 桥、不含第三方开发者令牌、不含扩展安装、不含 Widevine/CastLabs 运行时替换、不解 DRM、不下载音频、不做 Origin/Referer 改写、不关同源策略、不含 telemetry。

Apple 登录页与播放均由用户自己的浏览器与订阅完成；Folia 不接触账号密码，也不保存令牌。

---

## 截图建议（3 张）

1. 账号菜单里 Apple 的登录引导（中文文案）；
2. 歌单页与正在播放的 Apple 曲目（含歌词）；
3. 待播队列里 477 首的跟随效果。

---

## 提交前检查（写给提交者，不进 PR 正文）

- [ ] `package.json` 版本回退到 `0.7.20`
- [ ] 删除 `backups/`、`release/`、`docs/` 之外的本机私有文件
- [ ] `git status` 只应有本 PR 的 74 个文件（不含 `package.json` 版本改动）
- [ ] 分支名：`feat/apple-music-cdp`
- [ ] 提交信息按仓库习惯：`feat(apple-music): ...`，每个逻辑单元一个 commit
- [ ] 提 PR 前先在 issue #226 下留一句「我提了另一条路线」，避免与 #357/#419 讨论冲突
