# DeepSeek API 接入依据

核对日期：2026-11-07。本文是对 DeepSeek 官方文档的简要整理，用于维护本仓库的 7.14 接入；不是完整 API 文档副本，也不代表已使用真实付费 Key 验证所有接口。模型、能力、价格和配额可能变化，维护时应重新核对本文链接。

本轮按官方站内导航核对了 57 个页面：Quick Start 5 页、集成指南 8 页、API Guides 12 页、API Reference 12 页、News 19 页及 Change Log。浏览器另外核对了实时目录和模型定价页，避免把静态抓取中错误返回的首页当作定价正文。外链产品安装、社区与模型仓库不属于本脚本的接入依赖；没有执行文档中的安装或账户配置命令。

## 本仓库实际使用的流程

先完成平台详情提取与答案核验，再对确实没有平台答案的题目调用 AI。平台答案和原始参考程序优先；已有平台答案不因导入旧断点或 AI 返回而被覆盖。存在无法识别的非空平台答案时保留警告，不把它当成“没有答案”直接付费生成。

7.14 使用 `POST https://api.deepseek.com/chat/completions`，非流式、普通文本输出。默认普通题和含图题使用 `deepseek-flash`，无图程序题模型可配置，默认 `deepseek-v4-pro`；含图模型须支持视觉。模型名称和思考模式分别配置，不能继续按旧 `deepseek-chat` / `deepseek-reasoner` 名称推断能力。脚本记录返回的模型名和用量，不把 AI 参考答案标为平台验证结果。

请求显式设置 `thinking.type`、输出预算；思考开启时传 `reasoning_effort`，关闭时才传温度。只有正常结束且有非空最终文本的响应才完成该题；截断、空答案、工具调用和无效响应不作为完成答案。当前没有开启 JSON 输出、工具调用、联网检索、Files 上传、Responses 或 Anthropic Messages。

默认直接发送题图和题干。需要校内登录的图片先由浏览器读取，再转换为内联 data URL；这是根据官方“外链必须可公开访问”要求作出的实现选择。AI 图片缩放不改离线包原图。本地 OCR 是可选路径，二次 AI 纠错也是可选额外请求。Key 只用于当前运行，不写入断点 ZIP；多个 Key 的轮询不能绕过同账号的服务端额度。

## 当前约束及维护判断

| 主题 | 官方事实及对本项目的影响 | 来源 |
| --- | --- | --- |
| 模型与能力 | 当前模型页列出 `deepseek-flash`、`deepseek-v4-pro`；两者上下文 1M、最大输出 384K。当前视觉文档面向 Flash，不能按“程序模型”名称假定其支持图片。实际模型别名和能力应结合模型列表核对。 | [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/)、[List Models](https://api-docs.deepseek.com/api/list-models/) |
| 思考与预算 | 默认思考开启、强度 high；`thinking.type` 优先于 `reasoning_effort`。Chat 的 `max_tokens` 包含思考与最终文本，范围 1–393216；官方默认预算随模式变化，本脚本显式设置自己的预算。思考模式忽略温度。 | [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)、[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) |
| 图像限制 | 支持 JPEG、PNG、GIF、WebP，以实际文件内容判定。请求体上限 48 MiB；内联/外链单图 32 MiB，Files 引用单图 64 MiB；最多 600 张。每边最多 8192 像素，**达到 15 张时**降为 4096。无 Files 引用的图片总量最多 64 MiB，有 Files 引用时 200 MiB。 | [Vision](https://api-docs.deepseek.com/guides/vision/) |
| 图像 detail | `low` 使用较低分辨率；当前 `high`、`original`、`auto` 采用相同预处理。每张图独立计入图像 tokens；当前最多 1024 tokens/张，旧视觉实验版公告的 384 不能套用。 | [Vision](https://api-docs.deepseek.com/guides/vision/) |
| 配额 | 并发按账号计算：当前 Flash 2500、Pro 500，直到请求完成才释放。非流式响应可能先发送空行维持连接。脚本设置的是本地并发和等待上限，不是服务端额度保证。 | [Rate Limit](https://api-docs.deepseek.com/quick_start/rate_limit/) |
| 错误处理 | 401 是认证失败，402 是余额不足，400/422 是请求或参数错误；429、500、503 应等待后重试。有限指数退避、尊重 `Retry-After`、超时后提示可能已计费是本项目的处理策略，不是官方保证的幂等或退款行为。 | [Error Codes](https://api-docs.deepseek.com/quick_start/error_codes/) |
| 缓存 | 上下文缓存自动开启、尽力命中；当前缓存依赖已持久化的完整前缀单元，首次共享前缀不保证命中。固定公共提示放在前面有利于复用，但不要虚构命中率或节省金额；记录 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`。 | [Context Caching](https://api-docs.deepseek.com/guides/kv_cache/) |
| JSON 可选能力 | Chat 可设置 `response_format: {type: 'json_object'}`，还需提示中要求 JSON 并给出格式示例。即使 `finish_reason=stop` 也可能只返回空格，需要去空白、解析和业务字段校验。**本项目当前普通文本解答未启用此模式**；Chat 文档的 JSON Object 不能与 Responses 的 JSON Schema 参数混用。 | [JSON Output](https://api-docs.deepseek.com/guides/json_mode/)、[Responses](https://api-docs.deepseek.com/api/create-response/) |

官方页面存在需要保留的区别：2026-09-10 的迁移公告说 Pro 名称将路由到 V4.1-Flash，而当前模型/定价页仍列出 Pro。历史公告不能证明当前实际后端模型；应保留返回的模型字段，不宣称不同名称必然使用不同权重。[迁移公告](https://api-docs.deepseek.com/news/news260910/)

## 已核对的 API Reference 目录（12 页）

下表覆盖本次官方侧栏中的 API Reference 页面；未使用的能力仅作为后续维护参考，不表示脚本已实现。

| 页面 | 关键事实及接入影响 |
| --- | --- |
| [Create Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion/) | `POST /chat/completions`；`model`、`messages` 必需。思考内容 `reasoning_content` 与最终 `content` 分开。需检查 `finish_reason`；`length`、`content_filter`、`tool_calls`、`insufficient_system_resource`、`aborted` 都不能当正常最终答案。SSE 以 `[DONE]` 结束，最后内容块带 usage，不能照搬其他厂商空 choices 的 usage 块假设。 |
| [Create Response](https://api-docs.deepseek.com/api/create-response/) | `POST /responses` 为无状态请求。`max_output_tokens` 包含思考；`text.format` 支持 text、json_object、json_schema。响应有 completed/incomplete/failed 状态；流式以对应终止事件结束，没有 `[DONE]`。参数与 Chat 不同，不能只替换路径。 |
| [Create Message](https://api-docs.deepseek.com/api/create-message/) | `POST /anthropic/v1/messages`；也有 `/anthropic/messages` 别名。支持 `x-api-key` 或 Bearer，两者同时存在时 Authorization 优先。预算含思考；流式必须收到 `message_stop`。usage 的输入、缓存字段口径与 Chat 不同。当前脚本不使用此兼容接口。 |
| [Create Completion (Beta)](https://api-docs.deepseek.com/api/create-completion/) | Beta 的 `/completions` 接收 prompt、可选 suffix，结果在 `choices[].text`。FIM 与 Chat 对话不是同一接口；echo 与 suffix/logprobs 组合有限制。不能把它当作程序题解答 API 的直接替换。 |
| [List Models](https://api-docs.deepseek.com/api/list-models/) | `GET /models` 可返回上下文、输出上限、输入/输出模态、思考强度以及协议能力。模型选择应参考能力字段，而非只硬编码历史名称。 |
| [Get User Balance](https://api-docs.deepseek.com/api/get-user-balance/) | `GET /user/balance` 返回 `is_available` 与各币种余额信息，金额为字符串。可检查 Key/余额，无需消耗一次生成请求；成功不能证明所有模型请求均有权限或永不触发限流。 |
| [Create File](https://api-docs.deepseek.com/api/create-file/) | `POST /files` 使用 multipart，purpose 为 `user_data`，图片实际格式须受支持，单文件不超过 64 MiB。可配 `expires_after`；省略即长期保留。当前本项目不上传持久化文件。 |
| [List Files](https://api-docs.deepseek.com/api/list-files/) | `GET /files`，支持 after 游标、limit 1–1000、排序与 purpose 过滤，返回 `has_more`。若未来增加清理工具，必须分页，不能只处理第一页。 |
| [Retrieve File](https://api-docs.deepseek.com/api/retrieve-file/) | `GET /files/{file_id}` 返回文件元数据，不是原文件字节下载接口。不能据此承诺能从服务端重建离线原图。 |
| [Delete File](https://api-docs.deepseek.com/api/delete-file/) | `DELETE /files/{file_id}` 返回删除结果。仅在明确管理自己上传文件的流程中使用；当前脚本无此行为。 |
| [Search](https://api-docs.deepseek.com/api/search/) | `POST /v1/tools/search`；query 非空、最多 128 Unicode 字符，count 1–50，默认 10。可选原始问题、定位 IP 和正文请求。空结果是合法结果，不应无限重试。 |
| [Fetch](https://api-docs.deepseek.com/api/fetch/) | `POST /v1/tools/fetch`；输入 HTTP(S) URL，最多 8192 字符且不能含用户名密码，输出标题与 Markdown 正文。它不是校内登录态下载器，当前提取不依赖此接口。 |

## 已核对的 API Guides 目录（12 页）

| 页面 | 关键事实及接入影响 |
| --- | --- |
| [Vision](https://api-docs.deepseek.com/guides/vision/) | Flash 支持文本与图片混合输入，可用 data URL、公开 URL 或 file_id。外链下载最长 60 秒。Chat 图片放在 user 内容中；不要依赖各兼容协议对 tool 消息图片支持范围相同。图片数量、尺寸、字节与请求体限制需要分别核对。 |
| [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/) | 强度支持 low/high/max，none 对应关闭，部分旧名称有兼容映射。JSON 与思考可同时使用。有工具时必须回传完整思考历史；不使用工具时服务端可忽略历史思考。当前脚本每题独立请求，无需拼接工具轨迹。 |
| [Multi-round Conversation](https://api-docs.deepseek.com/guides/multi_round_chat/) | Chat 接口无状态，多轮对话必须自行传历史。本项目各题独立，不应把上一题答案意外加入下一题上下文。 |
| [Chat Prefix Completion](https://api-docs.deepseek.com/guides/chat_prefix_completion/) | Beta 接口要求最后一条 assistant 消息设置 `prefix: true`，可结合 stop 控制续写。它是可选能力；当前脚本遇到截断会暂停，不把任意拼接续写视为完整正确答案。 |
| [FIM Completion](https://api-docs.deepseek.com/guides/fim_completion/) | Beta FIM 使用前缀和可选后缀，指南列输出最多 4K，仅非思考。该限制不能套用到正常 Chat 的 384K 上限。 |
| [JSON Output](https://api-docs.deepseek.com/guides/json_mode/) | 开启 JSON Object 还需明确 JSON 提示、格式示例和足够预算；只返回空格也需要处理。将来若采用结构化填空答案，需要独立字段和类型校验，而不是仅检查 HTTP 200。 |
| [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/) | 函数工具由客户端执行，strict 为 Beta；严格 schema 的 object 字段要 required 且 `additionalProperties:false`，不支持所有 JSON Schema 约束。Chat 历史不能随意插入伪造工具调用。当前程序解答不执行模型生成的代码。 |
| [Files API](https://api-docs.deepseek.com/guides/files_api/) | 文件属于账号，同账号 Key 共用；每用户 25 GiB、最多 10000 文件。可选 TTL 1 小时至 30 天，默认永久。以 file_id 复用可以节省带宽，但需要明确保留与清理策略，不能把持久上传当无副作用的转换。 |
| [Search / Fetch](https://api-docs.deepseek.com/guides/search/) | 搜索和抓取为独立付费工具，仅成功且非空结果计费。当前账号 QPS 上限分别为 100 和 25，Fetch 还有目标域名限制；与模型并发不是同一配额。408/429/5xx 可等待重试，其余参数类错误应修正请求。 |
| [Context Caching](https://api-docs.deepseek.com/guides/kv_cache/) | 缓存自动运行但不是保存最终答案，也不使输出必然一致；构建可能需要数秒，通常数小时至数天清理。当前持久化前缀单元规则已不同于 2024 公告，不能承诺任意重复片段都命中。 |
| [Responses API](https://api-docs.deepseek.com/guides/responses_api/) | 兼容接口仍无状态；previous_response_id、conversation、store 等状态参数不支持，部分不支持参数会被忽略。不能借用其他服务的状态恢复行为。当前项目没有迁移到此接口。 |
| [Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api/) | 支持范围与原 Anthropic 服务不同：模型名称有映射，某些预算/格式参数被忽略，文档块不支持。工具结果需紧随工具调用且保留完整 thinking 块；流式最终 usage 是累计值，不能与开始事件重复相加。 |

## 已核对的历史 News（18 篇）

这些页面用于理解升级和兼容历史。旧价格、旧模型别名、旧配额、旧图片 tokens 与旧输出上限均不能作为今天的配置依据；不将历史评测图表当成当前题库正确率证明。

| 日期与页面 | 维护上保留的事实 |
| --- | --- |
| [2026-09-10 · V4.1-Flash](https://api-docs.deepseek.com/news/news260910/) | 引入原生视觉 `deepseek-flash`，旧 V4 Flash/视觉实验名称暂时路由至新 Flash；公告还记载 Pro 的路由迁移。实际能力以当前 API 文档与返回结果核对。 |
| [2026-08-21 · V4-Flash-Vision-Exp](https://api-docs.deepseek.com/news/news260821/) | 历史视觉实验模型与 Files API 发布。该模型名和当时单图 384 tokens 不能当作当前 Flash 的标准。 |
| [2026-08-13 · V4-Pro GA](https://api-docs.deepseek.com/news/news260813/) | 正式版发布时增加可调思考强度、原生 Responses 和峰谷定价；不意味着本项目必须改用 Responses。 |
| [2026-04-24 · V4 Preview](https://api-docs.deepseek.com/news/news260424/) | 记录 V4 双模式和 1M 上下文；明确旧 `deepseek-chat` / `deepseek-reasoner` 于 2026-07-24 15:59 UTC 退役，旧仓库默认值需要更新。 |
| [2025-12-01 · V3.2](https://api-docs.deepseek.com/news/news251201/) | 增强思考与工具调用；Speciale 曾使用有截止日期的临时端点，不能用于当前接入。 |
| [2025-09-29 · V3.2-Exp](https://api-docs.deepseek.com/news/news250929/) | 稀疏注意力实验版及临时旧版本对照端点；历史对照地址已非稳定 API 基址。 |
| [2025-09-22 · V3.1-Terminus](https://api-docs.deepseek.com/news/news250922/) | 对语言一致性及 agent 行为的历史更新，没有为本项目新增必须传入的请求参数。 |
| [2025-08-21 · V3.1](https://api-docs.deepseek.com/news/news250821/) | 当时用 chat/reasoner 名称区分思考，加入 Anthropic 兼容和 Beta strict；如今应改为当前模型名与显式思考参数。 |
| [2025-05-28 · R1-0528](https://api-docs.deepseek.com/news/news250528/) | 历史推理模型增加 JSON 与函数调用；不能据旧 R1 限制断言当前思考模式不支持这些能力。 |
| [2025-03-25 · V3-0324](https://api-docs.deepseek.com/news/news250325/) | 当时 API 调用方式保持不变；不代表以后发布的模型别名也永久有效。 |
| [2025-01-20 · R1](https://api-docs.deepseek.com/news/news250120/) | 当时通过 `deepseek-reasoner` 调用；名称和价格只作为历史迁移记录。 |
| [2025-01-15 · DeepSeek App](https://api-docs.deepseek.com/news/news250115/) | 面向官方 App 的发布消息；App 免费、上传和搜索能力不等同于 API 免费或参数相同。 |
| [2024-12-26 · V3](https://api-docs.deepseek.com/news/news1226/) | V3 发布与当时定价调整；不保留旧价格作为本项目费用估算。 |
| [2024-12-10 · V2.5-1210](https://api-docs.deepseek.com/news/news1210/) | V2.5 更新与网页搜索上线；不能据网页搜索能力推断 Chat 请求自动联网。 |
| [2024-11-20 · R1-Lite-Preview](https://api-docs.deepseek.com/news/news1120/) | 当时仅预告后续 API，不是可配置的当前模型名。 |
| [2024-09-05 · V2.5](https://api-docs.deepseek.com/news/news0905/) | 记录旧 chat/coder 合并与兼容特性；当前普通题和程序题可分别配置，但不能继续依赖退役别名。 |
| [2024-08-02 · Context Caching](https://api-docs.deepseek.com/news/news0802/) | 缓存自动启用的历史公告。旧“无并发限制”、64-token 粒度和价格均应由当前 Rate Limit、Caching、Pricing 页面替代。 |
| [2024-07-25 · New API Features](https://api-docs.deepseek.com/news/news0725/) | JSON、工具调用、Chat Prefix、FIM 的早期发布。旧 Beta 8K 输出上限不能覆盖当前 Chat 的预算参数说明。 |

## 核对边界

以上 API Reference、Guides 和历史 News 均已逐页阅读官方正文；目录依据官方侧栏及前后页链接核对。本节的文档阅读阶段没有复制评测图片、调用付费模型或操作账号文件，也没有因阅读文档而上传题库、图片或 Key。另行授权的真实模型运行记录见 [测试记录](../TESTING.md)。自动化模拟可验证参数与异常处理，真实 API 的模型可用性、服务延迟、实际用量和答案正确性仍需分别验证。

## Quick Start 与集成目录

- [首次调用](https://api-docs.deepseek.com/)：本脚本使用官方 Chat Completions 地址和 Bearer 认证。
- [模型与价格](https://api-docs.deepseek.com/quick_start/pricing/)：以当时模型页及实际响应为准；不在脚本中固定估算人民币费用。
- [Token 与用量](https://api-docs.deepseek.com/quick_start/token_usage/)：使用返回的 usage，不把字符数估算当作实际计费。
- [限流与隔离](https://api-docs.deepseek.com/quick_start/rate_limit/)：账号级额度、等待机制和可选 user_id；本脚本不额外发送用户身份标识。
- [错误码](https://api-docs.deepseek.com/quick_start/error_codes/)：认证、余额、限流及服务端错误分别处理。

已阅读以下集成指南。它们说明其他客户端如何连接 DeepSeek；本脚本直接请求 Chat API，不需要修改用户电脑上的这些产品设置，也不依赖其安装脚本。

| 指南 | 与本项目的关系 |
| --- | --- |
| [Claude Code](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/) | Anthropic 地址、模型映射和搜索费用说明；不能直接套用到 Chat 请求参数。 |
| [Codex](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/) | Responses 协议及模型目录配置；本脚本不采用这些客户端配置。 |
| [OpenCode](https://api-docs.deepseek.com/quick_start/agent_integrations/opencode/) | 客户端 provider 选择；旧展示名称不能替代当前 API 模型名。 |
| [OpenClaw](https://api-docs.deepseek.com/quick_start/agent_integrations/openclaw/) | 客户端接入与运行入口，无需引入题库脚本。 |
| [Hermes](https://api-docs.deepseek.com/quick_start/agent_integrations/hermes/) | 通过 provider、地址和 Key 配置客户端，与浏览器请求实现分开。 |
| [Reasonix](https://api-docs.deepseek.com/quick_start/agent_integrations/reasonix/) | 客户端可切换模型；本脚本提供自身的模型设置。 |
| [WorkBuddy/CodeBuddy](https://api-docs.deepseek.com/quick_start/agent_integrations/workbuddy/) | 使用 Chat Completions，配置示例支持图片；示例客户端窗口大小不是服务端上限。 |
| [Qoder](https://api-docs.deepseek.com/quick_start/agent_integrations/qoder/) | 自定义模型使用 API 账户计费；本脚本与客户端积分或订阅无关。 |

另已阅读 [最新 2026-10-17 发布说明](https://api-docs.deepseek.com/news/news261017/)及[完整 Change Log](https://api-docs.deepseek.com/updates)。当前 Flash 名称保持稳定、后台版本会更新，Search/Fetch 已独立提供；题库只需要模型解答，不自动增加联网检索费用。历史发布说明用于识别迁移，当前能力与参数以现行 API Reference、Guides、模型页面和实际响应为准。
