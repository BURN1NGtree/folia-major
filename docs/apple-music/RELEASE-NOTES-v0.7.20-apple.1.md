# Folia Apple Music（v0.7.20-apple.1）

**非官方衍生版**：基于 [chthollyphile/folia-major](https://github.com/chthollyphile/folia-major) 上游 `103be0af`（v0.7.20 之后 15 个提交）修改，新增 Apple Music 音源支持。与上游作者无隶属关系，未获 Apple 或上游背书。

## 这是什么

在 Folia 原有（网易云/QQ/酷狗/酷我/波点）之外，新增一路 **Apple Music** 音源：浏览器里用你自己的 Apple 账号登录网页版，Folia 通过调试协议读取曲库、搜索、封面与歌词，并把播放指令转成网页版队列操作。

## 新增

- **Apple Music 音源**：搜索、推荐、我的歌单、专辑歌手名、逐字歌词与纯音乐兜底
- **专用浏览器**：独立 profile，后台实例置于屏幕外（不抢前台、不占任务栏），播放/登录时升为可见窗口
- **播放桥**：队列快照一致性校验、断线重连、外部队列拼接与舞台播放状态发布
- **登录引导**：不代填账号密码，凭据只留在本机浏览器 profile

## 需要你知道的

- 需要你有 **Apple Music 订阅**，并自行在浏览器里登录；
- 自动化操作第三方网页属于 Apple 条款的灰色地带，**账号风险自负**，详见仓库 `DISCLAIMER.md`；
- 仅 Windows 实测通过；其他平台未验证；
- 播放路径依赖 Apple 网页版实现，Apple 改版可能导致失效——这不是本项目能控制的。

## 安装（绿色免安装）

1. 解压 `Folia-prod.rar` 到**纯英文路径**（如 `D:\Folia`）；
2. 双击 `Folia.exe` 启动；
3. 设置 → 在线音乐平台 → Apple Music → 按引导登录。

## 源码与许可

- 许可：**AGPL-3.0**（`LICENSE` 原样保留，修改声明见 `NOTICE`）
- 对应源码：本 tag 的完整源码树，或附件 `folia-major-src.tar.gz`
- 相对上游的改动：`folia-major-changes.patch`（89 文件）

## 校验和（SHA-256 前 16 位）

```
f363a2d3113dc088  Folia-prod.rar
17f4379fd0284084  folia-major-src.tar.gz
5c59cd123aa80fd8  folia-major-changes.patch
```
