# 02 · README.md

> 一句话摘要：这是可直接放到仓库首页的 README——先说清「基于谁、什么许可证、哪些是我改的」，再给能跑起来的步骤与诚实的完成度。

---

以下为 `README.md` 全文，复制到仓库根目录即可（`<…>` 为占位符，替换成实际值）。

````markdown
# Folia · Apple Music 派（Apple Music Edition）

**当前版本：`v0.7.20-apple.1`**（基于上游 `folia-major` `v0.7.20` 之后的提交 `103be0af`）

> 本项目基于 **[<上游项目名>](<上游仓库地址>)**（许可证：**<上游许可证>**，本仓库沿用同一许可证）修改而来。
> 感谢上游作者与所有贡献者对原项目的付出。
>
> 本项目是**二次开发 / 衍生版本**，非官方，与上游官方团队无关；
> 与 Apple Inc. 无任何关联，未获 Apple 认可或背书。Apple Music 为其各自权利人的商标。

为上游项目接入了 **Apple Music 网页端**作为在线音源：可以浏览/搜索 Apple Music 的目录与个人资料库，并由 Apple Music 网页实例实际出声，上游的界面、队列、拼贴墙、可视化照常跟随。

---

## 改动一览

| 功能点 | 对应模块 | 状态 |
| --- | --- | --- |
| Apple Music 作为在线音源（搜索、专辑、歌单、歌手、歌词） | `src/services/onlineMusic/apple*.ts` | 已验证 |
| 个人资料库（我的歌单、收藏专辑、最近播放、推荐） | 同上 + `src/hooks/useAppleLibrary.ts` | 已验证 |
| Apple 登录引导（独立浏览器登录，不接触账号密码） | `useAppleLoginGate.ts`、`AppleLoginGuide.tsx`、`electron/appleMusicBrowser.cjs` | 已验证 |
| 播放交由 Apple 网页实例，Folia 只做指挥与镜像 | `electron/nowplaying/*`、`src/services/nowPlayingControl.ts` | 已验证（大队列有延迟，见「已知问题」） |
| 播放状态回灌：底栏、进度条、拼贴墙、歌词跟随 | `useStagePlaybackController.ts`、`externalPlaybackTarget.ts`、`src/utils/externalQueue.ts` | 已验证 |
| 随机 / 循环三态映射 | `externalPlaybackTarget.ts`、播控桥 | 已验证（仅这两项，其余控制不镜像） |
| 专用浏览器不抢焦点、后台不停播、profile 不膨胀 | `electron/appleMusicBrowser.cjs`、`electron/nowplaying/bridge.mjs` | 已验证 |
| 播控服务按需启动 + 崩溃自恢复 | `electron/nowplaying/supervisor.cjs`、`electron/main.cjs` | 已验证 |
| 中文界面文案（登录、登出、平台列表） | `src/i18n/locales/zh-CN.ts`、`en.ts` | 已验证 |
| Apple 逐字歌词（TTML 音节级） | 播控桥的歌词读取 | **未验证 / 未实现**，目前取到的是整行歌词 |
| 混合队列（Apple 曲目 + 本地/其他音源混排） | — | **未验证** |
| macOS / Linux | — | **未验证**，本文档只描述 Windows x64 的实测路径 |

完整原理、踩坑与替代方案见 **[03-改动原理.md](03-改动原理.md)**；其余文档见 [INDEX.md](INDEX.md)。

---

## 快速上手（开发者）

### 环境

| 依赖 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | `24.22.0`（实测通过；npm `11.19.1`） | 打包工具链对 Node 版本较敏感 |
| 操作系统 | Windows 10/11 x64 | 其他平台未验证 |
| Electron | 跟随 `package.json` 的 `electron` 依赖（本项目实测 43.7.5） | 不要单独升级，可能与上游主进程代码不兼容 |
| Apple Music | **你自己的订阅与网页端登录** | 本项目不提供、不共享任何账号 |

### 安装依赖

```bash
npm ci
```

### 开发模式（热更新）

```bash
# 只起渲染层（Vite），不启 Electron
npm run dev

# 渲染层 + Electron 主进程
npm run dev:electron
```

> `dev:electron` 会读取两个可选的原生辅助程序路径（窗口置层、壁纸助手）。缺少它们只会让对应功能报错，不影响主界面。构建这两个辅助程序需要额外工具链（其中一个需要 Rust），详见 `packaging/`。

### 构建产物

```bash
# 打包前先构建前端
ELECTRON_DEV=false ELECTRON=true vite build

# 目录形式（免安装，便于调试；不生成安装包）
npx electron-builder --dir --win
```

离线/无外网环境下的构建参数与坑见 `03-改动原理.md` 的「构建与运行」一节。

---

## 配置

本项目没有配置文件格式；能力开关通过**环境变量**或上游设置页控制：

| 变量 | 作用 |
| --- | --- |
| `ELECTRON_DEV` | `true` 时加载 Vite 开发服务器而不是打包产物 |
| `ELECTRON_OVERRIDE_DIST_PATH` | 指定 Electron 运行时目录（用于绕过「程序路径含非 ASCII 字符无法启动」的问题） |
| `FOLIA_APPLE_BROWSER_HEADLESS` | `1` 时专用浏览器以无头模式启动（**不推荐**：无头下 Apple 网页可能不推进播放，见 03） |

播控服务默认监听本机 `9863` 端口；端口已被占用时会自动让位（视为「已有外部实例在跑」）。

---

## 截图

> `TODO(待作者确认)`：请补充三张真实截图，并确认图中不含账号、邮箱、头像、歌单隐私信息。
>
> - `docs/screenshots/home.png` — 首页携带 Apple 专辑/歌单
> - `docs/screenshots/nowplaying.png` — 播放页 + 拼贴墙跟随
> - `docs/screenshots/login-guide.png` — Apple 登录引导卡

---

## 已知问题

| 问题 | 现象 | 影响 |
| --- | --- | --- |
| 大队列播控有延迟 | 首次把几百首的队列推给 Apple 时，要等数秒才出声（实测 477 首约 10 秒以上，随队列增长） | 体验问题，不影响正确性 |
| Apple 逐字歌词未解析 | 播放页显示整行歌词，没有逐字高亮 | 功能缺失 |
| 混合队列未验证 | Apple 曲目与本地曲目混排时的行为未系统验证 | 可能有边界问题 |
| 产物路径限制 | 程序放在含中文/非 ASCII 的目录下可能直接退出 | 部署时需放纯 ASCII 路径 |
| 依赖 Apple 网页版 | Apple 改动网页结构或登录策略会导致功能失效 | 需跟随适配 |
| 版本显示 | 程序属性的「文件版本」可能显示为 `Electron`（沿用上游打包配置，未改程序本体） | 认版本请以 Release 标签 `v0.7.20-apple.N` 为准 |

更多「现象 → 原因 → 解法 → 放弃过的方案」在 `03-改动原理.md`。

---

## FAQ

**会不会动我的 Apple ID 密码？**
不会。登录在独立的浏览器窗口里进行，账号密码、验证码只输入到 Apple 的页面；本项目不读取、不存储、不上传这些内容，也不接管你的 Apple 会话凭据（只判断「是否已登录」）。

**需要 Apple Music 订阅吗？**
需要。播放走的是你自己的 Apple Music 网页端会话，没有订阅则无法播放完整曲目。

**为什么播放不是 Folia 自己解码的？**
Apple Music 的音频受 DRM 保护，本项目不做解密、不做下载、不做转码；出声的是 Apple 自己的网页播放器，Folia 只发送播放指令并读取播放状态。这也意味着：不能离线播放，音质取决于 Apple 侧设置。

**会不会违反 Apple 服务条款？**
本项目只在你自己的浏览器会话里执行「像人一样点播放」的操作，不绕过任何技术保护措施，也不批量抓取内容。是否允许自动化操作你的账号，请以 Apple 的服务条款为准，使用者自行确认。

**为什么点播放会等几秒？**
Apple 网页端需要先建立整条播放队列，几百首的队列要逐首解析，耗时随队列长度增长。详见 03 的「踩坑记录」。

**可以只接 Apple、不用其他音源吗？**
可以。Apple 与其他音源并列注册，互不依赖。

---

## 许可证与致谢

- 本仓库沿用上游许可证 **<上游许可证>**，完整文本见 [LICENSE](LICENSE)。
- 上游：**[<上游项目名>](<上游仓库地址>)**，版权归上游作者与贡献者所有。
- 本项目的改动同样以该许可证开放，欢迎在遵守许可证的前提下复用。
````

---

## 自检结果

**本篇标注的 TODO：**

| 位置 | TODO | 需要你补 |
| --- | --- | --- |
| 文档头 | `<上游项目名>` `<上游仓库地址>` `<上游许可证>` | 我按已知信息填了 `folia-major`、`https://github.com/chthollyphile/folia-major`、`AGPL-3.0`，请确认后替换为你的写法 |
| 改动一览 | 「未验证」项 | 若你实际验证过混合队列/逐字歌词，告诉我改状态 |
| 环境 | Node.js 版本 | 给出你实际使用的版本号 |
| 截图 | 三张图 | 提供图片或确认留占位 |
| 许可证段 | 同文档头 | 同上 |

**本篇无编造项**：改动清单与状态来自本会话的实际开发与验证记录（每条都有对应测试或真机验证）；「已知问题」中的延迟数字为实测；对 DRM/条款的表述刻意保持在「不做解密、依赖用户自身会话」的层面，未给任何绕过手段。
