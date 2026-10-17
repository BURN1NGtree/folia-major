# 01 · 仓库结构与 `.gitignore`

> 一句话摘要：这个仓库是上游 `folia-major` 的完整 fork，**能一眼分清哪些文件来自上游、哪些是本项目新增或改写**是本篇的全部目的。

---

## 1. 仓库形态

```
<your-repo>                     ← 完整 fork，保留上游全部提交历史
├─ main                         ← 跟随上游，不放入本项目改动
├─ apple                        ← 本项目功能线（日常开发在这里）
└─ v0.7.20-apple.1              ← 发布标签（本次；命名约定 v0.7.20-apple.N）
```

采用完整 fork 而非「补丁 + 子模块」的原因：上游更新时可以直接 `git fetch upstream && git merge`；同时上游的版权声明、历史贡献者在仓库里原样保留，符合 AGPL 与 Git 惯例。

```bash
git remote add upstream https://github.com/chthollyphile/folia-major.git
git fetch upstream --tags
```

---

## 2. 三类文件的边界

本项目对上游的改动分三类：**新增（本项目的代码）**、**修改（上游文件被改写）**、**上游原样**。判断标准只有一条：`git diff <上游提交>` 有没有它。

### 2.1 新增文件（本项目的核心资产）

**Electron 主进程 / 外部服务**

| 文件 | 行数 | 作用 |
| --- | --- | --- |
| `electron/appleMusicBridge.cjs` | 503 | 主进程内的 Apple Music 数据桥：在专用浏览器的页面上下文里请求 Apple 的公开 Web 接口，做归一化前的搬运与错误翻译 |
| `electron/appleMusicBrowser.cjs` | 442 | 专用浏览器进程管理：启动参数、登录页导航、会话（Cookie）探测与清理、显示/隐藏 |
| `electron/nowplaying/bridge.mjs` | 1156 | **播控桥**：通过 Chrome DevTools 协议指挥 Apple Music 网页实例建队列、播/停/切、读状态与歌词 |
| `electron/nowplaying/cdp-lib.mjs` | 62 | 零依赖的 CDP（DevTools 协议）客户端 |
| `electron/nowplaying/supervisor.cjs` | 190 | 播控服务的守护：按需启动、崩溃退避重启、端口被占时让位 |

**渲染进程：音源适配**

| 文件 | 行数 | 作用 |
| --- | --- | --- |
| `src/services/onlineMusic/appleProvider.ts` | 219 | 实现上游的在线音源 Provider 契约（搜索、歌单、专辑、歌手、歌词等） |
| `src/services/onlineMusic/appleTransport.ts` | 126 | 渲染进程 → 主进程的唯一通道；操作白名单、参数边界、错误码映射 |
| `src/services/onlineMusic/appleNormalize.ts` | 261 | 把 Apple 的 `data[] + attributes` 形状映射成上游的 `OnlineSong/OnlineAlbum/OnlinePlaylist` |
| `src/services/onlineMusic/appleCatalog.ts` | 68 | catalog 相关请求的组装与分页 |
| `src/services/onlineMusic/appleLibrary.ts` | 26 | 资料库（library）入口 |
| `src/services/onlineMusic/appleLocalData.ts` | 96 | 「本地可用数据」探测：判断哪些内容能在不依赖播放的情况下展示 |
| `src/services/onlineMusic/appleBrowserSession.ts` | 82 | 与专用浏览器会话状态打交道（是否已登录、清理会话） |
| `src/services/onlineMusic/externalPlaybackTarget.ts` | 105 | 判定「这首歌由外部播放器出声」，并做 Folia ↔ Apple 的循环模式映射、镜像歌曲构造 |
| `src/services/nowPlayingControl.ts` | — | 播控桥（9863）的客户端封装 |
| `src/services/systemAudioSpectrum.ts` | — | 系统音频频谱来源（Apple 播放时可视化用） |
| `src/utils/externalQueue.ts` | 53 | 外部队列与 Folia 队列的对应关系（顺序、位置） |
| `src/hooks/useAppleLibrary.ts` | 159 | 资料库页签的数据装配 |
| `src/hooks/useAppleLoginGate.ts` | 138 | 登录引导卡的显示条件与动作 |
| `src/components/app/AppleLoginGuide.tsx` | — | 登录引导卡组件 |

**测试**

| 文件 | 覆盖点 |
| --- | --- |
| `test/unit/electron/appleMusicBridge.test.ts` | 数据桥参数校验、操作白名单、错误映射 |
| `test/unit/electron/appleMusicBrowser.test.ts` | 启动参数、登录 URL、会话清理 |
| `test/unit/electron/nowplayingSupervisor.test.ts` | 并发只启动一次、退避重启、端口让位、停止清理 |
| `test/unit/onlineMusic/appleProvider.test.ts` | Provider 契约与分页/类型映射 |
| `test/unit/onlineMusic/appleTransport.test.ts` | 与桥的白名单漂移比对、错误码 |
| `test/unit/onlineMusic/appleNormalize.test.ts` | 归一化规则（含专辑歌手名） |
| `test/unit/onlineMusic/appleLocalData.test.ts` | 可用性探测规则 |
| `test/unit/playback/externalQueue.test.ts` | 外部队列映射 |
| `test/unit/hooks/useAppleLibrary.test.ts` | 资料库装配 |
| `test/unit/app/buildPlayerViewFlags.test.ts` | 外部播放时播放键可点性 |
| `test/manual/apple_provider_live.mts` | 手动联调脚本（真实账号，不参与 CI） |

### 2.2 被修改的上游文件

（完整清单以 `git diff <上游提交> --stat` 为准，下面是按职责分组。）

| 分组 | 文件 | 改动性质 |
| --- | --- | --- |
| 应用入口 | `src/App.tsx` | 挂登录引导、Apple 登录回调、外部歌词清理、播放入口分流 |
| 播放控制器 | `src/hooks/usePlaybackQueueController.ts` | 队列播放时把 Apple 曲目交给外部播放器 |
| 舞台/镜像 | `src/hooks/useStagePlaybackController.ts` | 放开三处 `stageSource !== 'now-playing'` 门控；把 `externalMirrorActive` 并入状态发布条件 |
| 播放键可点性 | `src/components/app/presentation/buildPlayerViewFlags.ts` | 外部播放时允许点击播放键 |
| 播放交互 | `src/hooks/usePlaybackInteractionBridge.ts`、`src/hooks/usePlaybackVisualizerBridge.ts` | 外部播放时把交互与可视化接到外部源 |
| 音源注册 | `src/services/onlineMusic/providerRegistry.ts`、`src/services/onlineMusic/omni.ts` | 注册 Apple、聚合搜索纳入 Apple |
| 音源类型 | `src/types/onlineMusic.ts`、`src/types.ts` | 新 Provider 类型与外部播放标记 |
| 账号/平台规则 | `src/library/core/model/accountRules.ts`、`src/library/core/contracts/account.ts` | 新增 `apple-login` 选择结果 |
| 账号控制器 | `src/library/core/services/providerAccountController.ts`、`providerAccountDeps.ts`、`useLibraryAccountController.ts` | 回调 `onAppleLoginRequired` |
| 音源列表 UI | `src/library/suites/grid/account/OnlineProviderSwitcher.tsx` | Apple 未登录时的副标题与点击行为 |
| 首页/卡片 | `src/library/core/model/homeCards.ts`、`src/library/app/createLibraryHomePort.ts`、`src/library/core/bindings/useLibraryHomeOnline*.ts`、`onlineHomeFeed*.ts`、`libraryHomeActions.ts`、`contracts/homeModel.ts` | Apple 资料库/推荐进首页；专辑歌手名读取 |
| 底栏/面板 | `src/components/FloatingPlayerControls.tsx`、`src/components/UnifiedPanel.tsx`、`src/components/floating-player/TrackTitleNavigator.tsx`、`src/components/panelTab/QueueTab.tsx`、`src/components/app/*` 三个模型文件、`src/components/command-palette/*` | 外部播放时的显示与命令 |
| 文案 | `src/i18n/locales/zh-CN.ts`、`en.ts` | Apple 相关文案（含此前缺失的 key） |
| 设置 | `src/stores/useAudioSettingsStore.ts` | 外部播放相关设置 |
| 主进程 | `electron/main.cjs` | 注册 Apple IPC、按需启动播控服务、退出清理 |
| 预加载 | `electron/preload.cjs` | 暴露 Apple 相关 IPC |
| 依赖 | `package.json` | 手动联调脚本等（`ws` 为播控桥的依赖，需确认是否已声明） |

> 判断规则：**能通过 `git log` 追溯到上游提交的文件，就是上游代码**。本项目只在少数文件上做增量修改，其余 3000+ 文件与上游逐字节一致。

### 2.3 上游原样文件

除 2.1、2.2 之外的所有文件。特别提醒，以下目录属于上游基础设施，**不要**放进本项目文档或改动版说明里当成自己的东西：

- `src/library/**`（上游的 UI 套件与 Library Core，本项目只读它、注入音源）
- `dev/**`、`packaging/**`、`docs/**`、`api/**`、`public/**`
- 上游的构建脚本（`vite.config.*`、`electron-builder` 配置段、`packaging/ffmpeg/*`）

---

## 3. `.gitignore` 方案

上游已自带一份 `.gitignore`（含 `node_modules`、`dist`、`dist-ssr`、`release/`、`dev-dist/`、`test-results/`、`.dev-credentials/`、`test/test-song/*`、`scripts/*` 等）。本项目在其基础上**追加**以下段，理由逐条写：

```gitignore
# ---- 本项目新增 ----

# 主进程/脚本的临时产物与日志
/apple-profile*/
!/apple-profile*/.gitkeep

# 打包与资源暂存
/build/ffmpeg/
/build/*.exe
/build/thumbar/cache/

# 本地构建产物与安装包（上游已忽略 release/，这里补目录被改名的情况）
/out/
/dist-electron/

# 手动联调产物（真实账号截图、原始接口返回样本）
/test/manual/apple-*.json
/test/manual/*-sample.ndjson
/evidence/

# 图标/资源的中间件与备份
*.iconbak
*.ico.tmp

# 本地备份点（每次改动前的快照）
/_backups/
/backups/

# 密钥、会话、本机配置
.env
.env.*
!.env.example
*.pem
*.key
.secrets/
```

**几条硬规则：**

1. 任何真实接口返回样本、登录态快照（Cookie / localStorage 导出）、带账号的截图都**不得进入仓库**，一律靠忽略规则挡住；需要示例就用脱敏后的手写 JSON。
2. `package.json` 里新增脚本若引用了只在本机存在的路径（例如某个 dist 目录），要改成相对路径或环境变量，否则别人 clone 后跑不通。
3. 不要忽略 `test/unit/**` 下的任何测试文件——它们是「可复刻」的证据。
4. 上游已忽略的路径不要重复添加，除非你要覆盖语义（这种情况用 `!` 例外要写注释说明理由）。

---

## 4. 提交与标签约定

| 约定 | 说明 |
| --- | --- |
| 提交前缀 | `feat(apple):`、`fix(apple):`、`chore(apple):`，便于过滤出「哪些提交是本项目的」 |
| 上游同步提交 | `merge: upstream v<版本> → apple`，冲突解决说明写在提交正文 |
| 标签 | 本次 `v0.7.20-apple.1`；约定 `v0.7.20-apple.N`，N 为功能线累加序号 |
| 发布说明 | 用 `CHANGELOG.md` 的段落，不在标签里写长文 |

```bash
# 查一个文件是不是本项目改的
git log --oneline <上游提交>..HEAD -- src/hooks/useStagePlaybackController.ts
```

### 4.1 版本号写在哪些地方（重要，避免误判）

本项目采用「**文档与标签声明版本，程序本体沿用上游**」的做法，原因是改 `package.json` 会与上游每次发版的 bump 冲突，且会干扰上游的更新通道逻辑。

| 位置 | 值 | 是否改动 |
| --- | --- | --- |
| 本次发布标签 | `v0.7.20-apple.1` | ✅ 本项目打 |
| `CHANGELOG.md` / `NOTICE` / README / 本套文档 | `v0.7.20-apple.1` | ✅ 本项目写 |
| `package.json` 的 `version` | `0.7.20`（上游发版号） | ❌ 保持上游原值 |
| 可执行文件的版本资源（ProductName / FileVersion） | `Electron` / `43.7.5` | ❌ 未改（换图标时只替换了图标资源） |

因此：**判断「这是哪个版本」的唯一依据是 Git 标签**，不是 `package.json`，也不是 exe 的属性面板。发布说明里要写清这一点，否则使用者会以为版本停在 `0.7.20`。

---

## 5. 自检结果

**TODO：**

| 位置 | TODO | 需要你补 |
| --- | --- | --- |
| 1 | `<your-repo>`、`<上游提交>` 为占位 | 新仓库地址、你 fork 时的具体提交（当前记录为 `103be0af`） |
| 2.1 | `nowPlayingControl.ts`、`systemAudioSpectrum.ts`、`AppleLoginGuide.tsx` 行数标 `—` | 若你希望精确到行，我按实际文件补 |
| 2.2 | `package.json` 是否已把 `ws` 加入 `dependencies` 待确认 | 播控桥运行需要它，缺失会导致 `MODULE_NOT_FOUND` |

**本篇无编造项**：文件清单来自 `git status --porcelain` 的实际输出（73 项改动，其中新增 28 项），行数来自 `wc -l` 实测；`.gitignore` 追加段的每条理由都对应一个真实产物或真实风险。上游原有条目为直接引用。
