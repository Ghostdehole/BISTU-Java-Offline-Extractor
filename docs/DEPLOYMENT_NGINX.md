# 在现有 `/java/` 目录发布密码保护题库

适用于 Nginx，以及由宝塔、1Panel 管理的 Nginx/OpenResty 站点。以下保留现有 `/java/` 目录和访问地址，不要求重建网站、改名目录或迁移服务器。本文件和配置示例不会自动修改服务器；服务器上的配置仍需由部署者检查后应用。

## 只上传两个发布文件

每次导出采用“密码保护”时，发布内容为同一导出包中的：

```text
现有站点根目录/
└─ java/
   ├─ index.html
   └─ question-images.<32位标识>.pack.js
```

`<32位标识>` 是导出器生成的实际文件名的一部分，不要改名。`index.html` 内含完整阅读页的密文，图片包内含逐图密文；二者必须来自同一次导出。公开阅读模式的输出没有这些内容保护，不能靠 Nginx 缓存设置把它变成加密版本。

**不要把整个备份 ZIP 解压到公开网站目录。** 原始 `images/` 是按要求保留的明文原图备份；`state.json` 和 `extraction-report.json` 在密码模式下也已加密，但只用于本地恢复和核验，无需发布。原始 ZIP、旧明文 HTML、观察记录和密码同样不应放在 `/java/`。密码通过另外的渠道告知读者。

若旧站已经公开过 `images/`，换成锁页不会自动撤回原图地址或历史缓存。完成迁移后，应让这些原图移出公开目录或禁止公开访问，并清理其 CDN 缓存；历史下载的副本无法收回。配置示例采用 `/java/` 发布文件允许列表，保留版本图片包，拒绝其余文件。旧的无密码页面需要刷新到新锁页；不要为维持旧明文页面而继续公开备份原图。

## 更新顺序

1. 在站点配置中确认现有 `root` 和 `/java/` 对应的实际磁盘目录；保留原目录值。若使用 `alias`、反向代理或容器挂载，先确认它们的映射，避免把文件传到另一个同名目录。
2. **先上传新的 `question-images.<标识>.pack.js`**，确认上传完整、实际 URL 返回 200，且文件大小或哈希与本地一致。不要覆盖已有标识对应的包。
3. **再替换 `index.html`**。支持原子替换的上传方式可先传临时文件，再重命名覆盖入口，减少读到半份 HTML 的窗口。不要把临时明文文件留在公开目录。
4. 暂时保留旧版本图片包：已经打开的旧阅读页仍会请求旧文件名。按自己的发布保留周期清理，确认没有需要兼容的旧页面后再移除；不要在替换入口时立即删除所有旧包。
5. 访问 `/java/` 和 `/java/index.html`，确认均出现锁页。输入密码后检查题干、答案和图片，刷新应重新要求密码。仅切换浏览器标签后返回，应仍可继续阅读。

程序不会把密码或派生密钥写入 `localStorage`、`sessionStorage`、Cookie 或 IndexedDB。解锁后的密钥仅在当前页面内存中使用；关闭、刷新或离开后恢复页面需要重新输入密码。授权读者仍可保存已解锁的内容，密码保护不等同于防截图或防复制。

## Nginx 缓存配置

使用同目录的 [nginx-java.conf.example](nginx-java.conf.example)，将相关 `location` 合并到**现有站点的 `server { ... }` 内**。保留已有域名、证书、监听端口、`root` 和其他目录配置。它假定 `/java/` 是 `server` 级 `root` 下的真实子目录；如果原站通过 `alias` 映射，请先按实际路径调整，不能照抄猜测的磁盘目录。Nginx 的 `root` 会与请求 URI 拼接，而 `alias` 会替换对应路径。[Nginx 路径映射文档](https://nginx.org/en/docs/http/ngx_http_core_module.html#root)

| 请求 | 响应策略 | 用途 |
| --- | --- | --- |
| `/java/` | `Cache-Control: no-cache, max-age=0, must-revalidate` | 每次使用入口缓存前重新验证 |
| `/java/index.html` | 同上 | 直接打开入口时也生效 |
| `/java/question-images.<标识>.pack.js` | `public, max-age=31536000, immutable` | 文件名随版本改变，旧包内容不再修改 |
| `/java/` 下其他文件 | 404 | 防止备份文件被意外公开 |

`no-cache` 允许保存响应，但再次使用时需要验证；它不等于 `no-store`，也不会主动刷新已经打开的页面。版本包的 `immutable` 依赖“同文件名内容永远不变”，所以必须保留导出器生成的名字。[Cache-Control 语义](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control)

图片包缺失时，锁页仍可用正确密码解锁正文。原图回退只适合带有明文 `images/` 备份的本地副本；公开站点应补齐正确版本包，不应通过公开原图备份绕过图片保护。

配置中的两个 `=` 入口规则是精确匹配。图片包和拒绝其他文件的两个正则规则必须放在通用 `.js`、图片等正则规则之前；已有 `location ^~ /java/` 会阻止外层正则匹配，需要合并处理，不能仅把示例追加到末尾。目录入口还可能经 `index` 内部重定向到另一条规则，因此检查两个入口 URL 都很必要。[Nginx location 匹配](https://nginx.org/en/docs/http/ngx_http_core_module.html#location)、[index 内部重定向](https://nginx.org/en/docs/http/ngx_http_index_module.html#index)

示例用 `expires off` 避免继承过期时间设置后产生冲突的缓存头。`add_header` 的默认继承规则会在当前层存在新 `add_header` 时改变：若站点在上层设置了 HSTS 等安全响应头，应在这些块中重复保留或包含现有共享配置。示例没有使用需要较新 Nginx 版本的 `add_header_inherit`。图片包缓存头刻意不加 `always`，避免给缺失包的 404 附上一年的缓存策略。[Nginx 响应头模块](https://nginx.org/en/docs/http/ngx_http_headers_module.html)

在宝塔或 1Panel 中，编辑当前站点的实际配置，先使用配置检查，再重载对应服务。容器内的 Nginx 与宿主机命令可能不是同一实例；若用命令行，应在运行该站点的实例执行 `nginx -t`，通过后才重载。不要整份替换面板生成的站点配置，也不要重复添加已有同名 `location`。

## gzip 和缓存核验

示例只对题库入口和图片包启用 gzip，并发送 `Vary: Accept-Encoding`。gzip 可以减轻 Base64 文本与脚本的传输开销，但不会把随机密文或已压缩 PNG/JPEG 再变成“极致压缩”；实际收益取决于文件内容。图片包仍保留原始图像字节，不靠降低清晰度缩小体积。[Nginx gzip 模块](https://nginx.org/en/docs/http/ngx_http_gzip_module.html)

将下面域名及图片包标识替换成自己的实际值，保留 `/java/` 路径：

```sh
curl -I https://example.com/java/
curl -I https://example.com/java/index.html
curl -I https://example.com/java/question-images.ACTUAL_ID.pack.js
curl -I -H 'Accept-Encoding: gzip' https://example.com/java/question-images.ACTUAL_ID.pack.js
curl -I https://example.com/java/images/img_1.png
curl -I https://example.com/java/state.json
```

Windows PowerShell 可使用 `curl.exe`。入口应返回上述重新验证策略；版本包应返回长期缓存策略和 JavaScript MIME 类型；可用 gzip 时会返回 `Content-Encoding: gzip`。备份 URL 应返回 404。若 CDN 改写响应头，请同时检查 CDN 地址与源站；不要只看面板中填写的配置。

首次从旧缓存规则切换时，清理一次 CDN 的 `/java/`、`/java/index.html` 旧缓存，并让浏览器强制刷新。新规则不会自动修改浏览器中已经保存、尚未重新请求的旧响应。若旧包文件名曾被覆盖，也需要清理对应缓存，并从下一次发布起恢复版本文件名不可变的规则。

**禁用缓存不能解决所有更新问题。** 如果刷新后仍不对，依次核对：是否传到了正在提供服务的目录、当前域名是否命中该站点、入口是否引用同批次已上传的包、CDN/反向代理是否覆盖缓存规则、响应是否为 404/503 或登录页，以及是否只是旧标签尚未刷新。不要用清空整个缓存来代替这些核对。
