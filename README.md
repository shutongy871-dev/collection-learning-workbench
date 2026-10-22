# 收藏学习工作台

把自己的抖音收藏整理为可复习的题目。首页提供「开始学习」、每日学习数量、收藏增长趋势和「同步并分类」。系统自动处理内容、生成题卡，使用 FSRS 安排逐题复习。

这是运行在使用者电脑上的 **Node.js 服务 + 专用 Chrome 浏览器 + 学习网页**。GitHub 分发代码；启动本地服务后，可以随时打开网页学习。GitHub Pages 无法独立提供浏览器登录、收藏同步和本地存储能力。

## 快速开始

需要 Node.js 20.12 或更高版本、Google Chrome。配置密钥和本地语音转写需要 Python 3。日常流程按 macOS 验证；Windows/Linux 没有完整验证，自动定时安装目前仅支持 macOS。

下载并解压仓库，进入项目目录：

```bash
npm ci
npm start
```

打开 **http://127.0.0.1:7790**：

1. 点击右上角「我」，选择「登录抖音」。在打开的专用 Chrome 中完成扫码登录。
2. 返回学习网页，点击「检查登录」。核验成功后，右上角可查看昵称和最近核验日期。日期表示最近一次实际核验，登录失效后需要重新登录、核验。
3. 点击「同步并分类」。这会读取你的收藏与目录、执行规则分类、回读验证，并更新本地学习库。已有收藏夹使用你自己的目录；没有收藏夹时会创建通用主题目录。无法确定分类的内容保留待处理。
4. 完成下面的模型与转写配置后，后台按每日数量自动准备题目；有题目即可点击「开始学习」。首次下载不会附带任何人的收藏或题目，视频处理可能需要一些时间。

服务运行时网页可反复访问；退出终端停止服务后，重新运行 `npm start` 恢复，学习记录保留在本机。

## 配置自动出题

每个使用者使用自己的模型 API Key。推荐点击右上角「我 → 模型配置」：

1. 选择百炼（北京）或豆包（北京），填写自己的 API Key。
2. 百炼预填 `qwen-vl-plus`，同时用于图片理解和文字出题；豆包填写控制台中支持图片的模型接入点 ID。
3. 在「费用设置」核对供应商当前输入/输出单价和每条视频预算。
4. 点击「保存并开始出题」，配置立即生效并恢复后台准备，无需重启服务。

密钥输入隐藏，保存至被 Git 忽略的 `.data/model-settings.json`（权限 600），接口不会返回密钥，也不会放入学习备份。再次打开时留空可保留原密钥。网页保存的模型配置优先于 `.env.content`，网页、定时批处理和内容命令共用同一配置。保存成功表示本机配置已保存；实际供应商认证、模型可用性、转写依赖和视频证据仍会在处理时检查。

也可继续通过终端配置百炼：

```bash
npm run content:configure-key
```

密钥隐藏输入，保存在被 Git 忽略的 `.env.content`，无需发送给项目维护者。配置脚本只填写视觉密钥；还需要在该文件中填写文本出题模型及供应商当前单价：

```dotenv
CONTENT_QUESTION_MODEL=填写控制台实际可用的文本模型
CONTENT_QUESTION_INPUT_CNY_PER_MILLION=填写输入单价
CONTENT_QUESTION_OUTPUT_CNY_PER_MILLION=填写输出单价
CONTENT_QUESTION_MAX_COST_CNY=填写单次请求预留金额
```

单价单位为人民币/百万 tokens。预留金额至少覆盖
`(最大输入 tokens × 输入单价 + 最大输出 tokens × 输出单价) / 1000000`。
同供应商、同端点时，文本出题可复用视觉密钥；否则单独填写 `CONTENT_QUESTION_API_KEY`。视觉模型、费用上限和其他字段见 [.env.content.example](.env.content.example)。供应商价格可能变化，使用前按控制台核对。

语音类视频默认使用本机 Whisper，安装方式：

```bash
python3 -m venv .venv-content
.venv-content/bin/python -m pip install -r requirements-content.txt
```

首次运行会下载模型权重；ffmpeg/ffprobe 默认由 npm 可选依赖提供。运行 `npm run content:doctor` 检查配置。修改模型或价格后重新启动服务，或运行 `npm run content:batch -- run --retry` 重试。系统会保留已有媒体、转写和结果，避免重复处理成功项。

云模型会接收选中的视频帧、转写或出题证据，不发送浏览器 Cookie。调用会产生供应商费用。缺少密钥、模型、计费配置或可靠内容证据时暂停相应步骤，不编造题目。

## 可选：每天自动同步

macOS 完成登录核验后运行：

```bash
npm run install:mac
```

注册北京时间每日 09:00 的任务；需要电脑开机并登录当前系统用户，睡眠后唤醒会检查当天补跑。此命令安装收藏同步任务，学习网页服务仍需 `npm start`。遇到登录失效、验证码、限流或无法确认平台结果时停止并保存现场，可解决问题后用网页「同步并分类」恢复。

移除定时任务：

```bash
launchctl bootout "gui/$(id -u)/com.collection-tidy-agent.daily"
rm "$HOME/Library/LaunchAgents/com.collection-tidy-agent.daily.plist"
```

## 数据隔离与备份

- 登录态、账号绑定、收藏、题目和学习进度均保存在本机 `.data/`；模型密钥保存在 `.data/model-settings.json` 或 `.env.content`。
- 专用浏览器不复制日常 Chrome 的 Cookie。仓库不提供任何预登录账号、私人收藏、历史运行报告或密钥。
- 一个数据目录绑定一个抖音学习库；切换为另一个人的账号时使用另一份全新代码目录，防止混入原学习记录。
- 备份可复制本机 `.data/` 与 `.env.content`，这些文件属于个人数据，应自行妥善保管。不要提交到公共仓库。
- 此服务只监听本机地址，不提供面向公网的多用户认证系统。

## 开发与验证

```bash
npm test
npm run verify:ui
npm run verify:background
npm run verify:nonmodel
npm run daily:status
```

默认回归与 UI 验收使用隔离目录和合成数据，不需要个人收藏或真实云端密钥。UI 验收需要安装 Chrome；媒体验证需要可用 ffmpeg。真实抖音页面可能变更，真实账号登录、平台分类效果以及云端题目质量需在各自环境中验证。

代码：`src/learning/` 为网页、服务和复习调度，`src/understanding/` 为媒体理解与模型调用，`scripts/daily.mjs` 为同步分类执行器。`src/local-service/` 与 `src/extension/` 保留历史扩展实现；当前网页流程使用专用 Chrome，无需安装扩展。

公开发布请使用 `npm run release:prepare` 生成白名单代码包，它排除本机数据、配置、历史报告与调试材料。发布前仍应检查包内文件。项目未隶属于抖音。
