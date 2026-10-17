# 免责声明 / Disclaimer

本文件适用于本仓库及随附发布物（以下简称“本软件”）。使用前请完整阅读；下载、安装或使用本软件，即视为你已阅读并接受以下内容。

## 1. 非官方版本，与上游无隶属关系

本软件是**基于开源项目 Folia（`chthollyphile/folia-major`）修改的非官方衍生版本**（unofficial downstream fork）。

- Folia 由 `chthollyphile` 等上游贡献者开发，著作权归其所有；
- 本仓库只包含“接入 Apple Music 网页播放器”相关的改动，**不是**上游官方发布渠道；
- 上游作者**未参与**本版本的开发，**未审阅**这些改动，也**未对本版本作出任何背书或担保**；
- 本软件不使用 Apple Inc. 的名称、商标或图标暗示任何官方关联、赞助或认可。

## 2. 按现状提供，不作任何担保

本软件依 **GNU Affero General Public License v3.0（AGPL-3.0）** 分发，适用该许可证第 15、16、17 条的免责条款：

- 不提供任何明示或默示担保，包括但不限于适销性、特定用途适用性与不侵权担保；
- 作者与贡献者**不对**因使用或无法使用本软件产生的任何直接、间接、偶然、必然损失承担责任，包括数据丢失、账号受限、设备损坏或业务中断；
- 你需自行评估并承担使用风险。

## 3. 不包含音频内容，不绕过任何付费机制

- 本软件**不分发、不内置、不缓存、不转存**任何音频文件、歌词或专辑封面数据；
- 播放行为发生在**你本人登录的官方 Apple Music 网页播放器**中，由该网页按 Apple 的服务条款与订阅状态执行；
- 本软件**不提供**任何解密、去 DRM、下载音频、模拟会员、绕过地区限制或共享账号的功能；
- 你需要**自己的合法 Apple Music 订阅**才能播放完整曲目；无订阅时的试听限制由 Apple 决定，与本软件无关。

## 4. 第三方服务条款与账号风险（重要）

本软件通过 Chrome DevTools Protocol 等自动化方式控制一个由你本机启动的浏览器窗口，从而观察播放状态、下发播放指令。**这类自动化控制可能被视为违反 Apple 的服务条款**（例如《Apple Media Services 条款与条件》中关于自动化访问、非官方客户端的规定）。

由此可能产生的后果包括但不限于：

- Apple Music 账号被限制功能、暂停或封禁；
- 订阅权益受影响；
- 浏览器会话被要求重新验证登录。

**作者无法保证你的账号安全，也不对上述后果承担责任。** 若你对此有顾虑，请不要使用本软件。

## 5. 隐私

- 本软件在**本机**处理你的登录会话与播放状态，不上传你的账号、密码、Cookie 或听歌记录到任何作者控制的服务器；
- 登录用的浏览器配置文件保存在你本机的用户目录中，删除该目录即可清除登录状态；
- 本软件不含统计、遥测或广告 SDK。

## 6. 无维护承诺

本软件按现状提供，作者**不承诺**：

- 修复任何缺陷或安全问题的时限；
- 跟进上游新版本或 Apple 网页端改版；
- 提供技术支持、定制或迁移协助。

上游更新、Apple 网页播放器改版均可能随时导致本软件部分功能失效。

## 7. 侵权与下架

若你是权利人或其授权代表，认为本仓库内容侵犯你的权利，请通过仓库 Issue 或本说明中给出的联系方式提出，并附上权利证明与具体指向。核实后作者将及时修改或移除相关内容。

---

# English summary

This project is an **unofficial downstream fork** of Folia (`chthollyphile/folia-major`, AGPL-3.0). The upstream authors did not participate in, review, or endorse these changes.

The software is provided **"AS IS", without warranty of any kind**, under AGPL-3.0 §§15–17. It does **not** bundle, download, decrypt, or redistribute any audio content. Playback happens in the official Apple Music web player that **you** sign in to, under Apple's own terms and your subscription.

Automating that web player may violate Apple's Terms of Service; account restrictions or bans are **your risk**, and the authors disclaim all liability for them. No telemetry is collected; all session data stays on your machine.
