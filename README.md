# MyScale

仿 Tailscale 的 **Headscale / Tailscale 控制面管理客户端**（Tauri 2，安卓 APK + Windows）。
最大的不同：**直接输入后端地址即可**（`hs.example.com`、`https://…`、`http://192.168.1.5:8080` 均可），不必手敲 `tailscale up --reset --login-server …`；可保存多个服务器，一键切换。

> ### ⚠️ 先说清楚边界
> MyScale 只用 `tauri-plugin-http` + 纯 HTML/JS，所以它是**管理与连接助手**，**不包含 WireGuard 隧道（数据面）**，**不会让手机本身加入 tailnet**。
> 它能做的是：连接并检测你的 Headscale、查看/搜索/排序设备、管理用户与预授权密钥、注册设备、一键生成客户端登录命令。
> 要让设备真正组网，请在设备上装官方 Tailscale 客户端，并用 MyScale 生成的命令/密钥指向你的服务器。
> 自己实现 VPN 数据面需要 Android `VpnService` + 原生 Tailscale 内核，超出本项目的技术方案。

## 功能

| 页面 | 内容 |
|---|---|
| 连接 | 输入地址（+可选 API Key）→ 自动补全协议、去掉误贴的 `/api/v1`、检测 `/health` 与 Key；多服务器保存/切换/编辑；生成 `tailscale up --login-server … [--authkey …]` 命令（含 `--reset` 版），一键复制 |
| 设备 | 总数/在线/离线/已过期统计；搜索（名称/IP/用户/标签，多词 AND）；按状态/名称/IP/最后在线/用户排序，升降序；仅在线、按用户筛选；详情：复制 IP、重命名、使密钥过期、删除；按 `/register/…` 链接注册设备 |
| 用户 | 列表（含设备数）、新建、删除、为其生成密钥 |
| 密钥 | 预授权密钥列表（默认遮挡）、生成（有效期/可复用/临时节点/ACL 标签）、创建后显示一次并附完整登录命令 |
| 设置 | 主题（深色默认 / 纯黑 / 浅色 / 跟随系统）、6 种强调色、5 种背景（极光/网格/星空/渐变/纯色）、密度、自动刷新（关/30/60/120s，仅前台可见页）、遮挡密钥、**导出/导入备份**、**请求统计**、清除数据 |
| 快捷按钮 | 首页 9 个内置动作（检测连接、复制登录命令/地址、生成密钥、新建用户、注册设备、切换服务器、强制刷新、导出备份），可**排序、隐藏/显示、一键恢复默认**；还能新建**自定义按钮**（最多 24 个）：① 调用任意接口（GET/POST/PUT/PATCH/DELETE + 路径 + JSON 请求体，结果以弹层显示并可复制）；② 复制文本模板（占位符 `{url} {host} {key} {name} {now} {date} {in1d} {in7d} {in30d}`）。内置 7 个示例一键填入，编辑页有「试运行」。**写操作一律先确认**，路径只能是当前服务器上的路径（拒绝带域名/`..`），随备份导出/导入 |
| 其它 | 每个服务器可单独开启「允许自签名证书」；Android 返回键先关弹层再退出；刘海屏/手势条安全区；竖屏手机=底栏，横屏/平板=侧栏+多列网格 |

数据只存本机 `localStorage`（每次读写都有 try/catch，存储不可用时退回内存并提示）。**换机/重装前请到 设置 → 导出备份。** 备份里默认包含 API Key，可勾选「不包含 API Key」。

---

## 一、云编译（GitHub Actions，本地不装任何安卓环境）

1. 在 GitHub 新建一个仓库，把本压缩包解压后的**全部内容**推上去。
2. **注意 `.github` 是隐藏文件夹，网页拖拽上传经常漏掉它。** 检查仓库里有没有 `.github/workflows/build-apk.yml`；没有就手动建：
   仓库页 → *Add file* → *Create new file* → 文件名输入 `.github/workflows/build-apk.yml`（输入 `/` 会自动建目录）→ 粘贴工作流正文 → *Commit*。
3. 打开 *Actions* → 左侧 **Build MyScale APK** → *Run workflow* → 选架构 → 运行。
   - `aarch64`：几乎所有近几年的手机（**默认**）
   - `armv7`：很老的 32 位手机
   - `x86_64`：模拟器 / 部分 ChromeOS
   - `all`：aarch64 + armv7 + x86_64 合并出一个通用包（体积更大、编译更久）
4. 首次编译需要从源码装 Tauri CLI，**约 15–30 分钟**；之后有缓存会快很多。
5. 发版：打标签并推送 `git tag v1.0.0 && git push origin v1.0.0`，会自动编译并把 APK 附到 **Releases**（标签 `vX.Y.Z` 会同时作为应用版本号）。

### 签名（强烈建议配置 Secrets）
不配置也能用：工作流会用 `keytool` 自动生成密钥并缓存。但 GitHub 缓存可能被清理，**一旦密钥变了，手机上必须先卸载旧版才能装新版**。想长期稳定，生成一次自己的密钥并存为 Secrets：

```bash
keytool -genkeypair -v -keystore myscale.keystore -alias myscale \
  -keyalg RSA -keysize 2048 -validity 36500
base64 -w0 myscale.keystore        # macOS: base64 -i myscale.keystore
```
仓库 → *Settings* → *Secrets and variables* → *Actions* → 新增：

| Secret | 值 |
|---|---|
| `ANDROID_KEYSTORE_B64` | 上面 base64 输出 |
| `ANDROID_KEYSTORE_PASSWORD` | 密钥库密码（**密钥口令需与之相同**） |

密钥别名固定为 **`myscale`**（生成时必须用这个别名）。

## 二、下载并安装 APK

1. 运行结束后，进入该次运行页面底部 **Artifacts** 下载 `MyScale-apk-<架构>`（是 zip，解压得到 `MyScale.apk`）；打标签发版的话直接在 **Releases** 下载。
2. 把 `MyScale.apk` 传到手机，点击安装；系统提示时允许「安装未知来源应用」。
3. 覆盖升级要求**签名一致**（见上）。
4. 打开应用 → 输入后端地址（和 API Key）→ 连接。API Key 在 Headscale 服务器上生成：`headscale apikeys create`（默认 90 天有效，只显示一次）。

## 三、在本地编译 Windows 版

1. 安装 [Rust](https://rustup.rs)（选 MSVC 工具链）和 *Visual Studio Build Tools*（勾选「使用 C++ 的桌面开发」）。Windows 10/11 一般已带 WebView2。
2. 在项目根目录执行：
   ```powershell
   cargo install tauri-cli --version "^2" --locked
   cargo tauri icon app-icon.png
   cargo tauri dev          # 调试运行
   cargo tauri build        # 安装包 → src-tauri\target\release\bundle\（nsis / msi）
   cargo tauri build --no-bundle   # 只要 exe → src-tauri\target\release\myscale.exe
   ```
3. Windows 版同样只是管理工具，不包含 VPN。

---

## 四、网络与请求量

- 所有请求在前端经 `window.__TAURI__.http.fetch`（Rust 侧 reqwest）发出，**不受 WebView 跨域限制**，且 http 明文地址不受 WebView 的混合内容限制。
- `capabilities/default.json` 给 `http:default` 放行了**所有 http/https 主机**（因为服务器地址由用户在运行时输入）。想收紧就把 `allow` 换成你自己的域名，如 `{ "url": "https://hs.example.com" }`。

**请求策略**：串行发送、最小间隔 350 ms；相同请求合并；结果缓存 15 s；只刷新当前可见页；自动刷新默认关闭，打开后只在前台、且当前页是 设备/用户/密钥 时才请求。

**实际请求量（按代码逻辑计算，Headscale 侧限流情况未验证）**

| 操作 | 请求数 |
|---|---|
| 连接/测试 | 2（`GET /health`、`GET /api/v1/user`） |
| 打开设备页 | 1（`GET /api/v1/node`），15 s 内重复进入 0 |
| 打开用户页 | 1（`/user`，刚测试过则命中缓存）+ 设备数统计 1（设备页已加载则 0） |
| 打开密钥页 | 1（`/preauthkey`）；旧版服务器需回退为「1 + 用户数」 |
| 生成密钥 | 1 次 POST（旧版格式失败时 +1 重试）+ 1 次刷新列表 |
| 点一次自定义「调用接口」按钮 | 1（GET 立即发；写操作确认后才发，取消 0）；不走缓存，但与其它请求一样串行、受最小间隔限制 |
| 点「检测连接」 | 2（`/health` + `/user`） |
| 连点刷新 6 次 | 模拟测试中 ≤ 2 次真实请求（合并 + 缓存） |
| 自动刷新 | 每个周期 1 次（60 s 档 ≈ 60 次/小时，仅前台） |

设置页「请求统计」会显示本次运行的真实网络请求数 / 缓存命中 / 合并 / 失败。

---

## 五、测试与验证状态

```bash
node --test tests/core.test.js     # 纯逻辑，Node ≥ 18，无依赖（49 项）
python3 tests/check-workflow.py    # 工作流结构 + 步骤模拟（需 PyYAML；31 项）
node tests/ui-smoke.cjs            # 可选：界面冒烟（需 playwright + Chrome；72 项，见文件头）
```

### ✅ 在沙箱里实际跑通的
- **纯逻辑（49 项）**：地址规范化（补协议、私网默认 http、去 `/api/v1` 等后缀、拒绝 ftp）、`/register/…` ID 提取、节点/用户/密钥解析（含缺字段、旧版 `machines`、snake_case）、IP 数值排序、搜索筛选、相对时间、请求调度器（串行与最小间隔、合并、TTL 缓存、失败不污染）、存储读写（存储抛异常/JSON 损坏均不崩）、备份导出/导入（合并去重、覆盖、去 Key、拒绝非 MyScale 文件）、**自定义按钮校验**（路径白名单/拒绝域名与 `..`、方法白名单、写操作强制确认、JSON 请求体、占位符替换、数量上限、布局排序/去重、备份往返与合并）。
- **界面（72 项，headless Chrome + 模拟的 Tauri http）**：默认深色、`viewport-fit=cover`、添加/切换服务器、列表/筛选/搜索、弹层栈与**浏览器后退键逐层关闭**、重命名流程、密钥生成与「数字 ID 失败→回退用户名」、主题/背景/强调色、刷新后状态恢复、竖屏底栏/横屏与平板侧栏、360px 无横向溢出、`localStorage` 抛异常时仍可用。
- **工作流（31 项）**：触发器、`ubuntu-24.04`、权限、不含 `setup-android`、步骤顺序；所有 `run` 块 `bash -n` 通过；**真实运行**了：`keytool` 生成并复用密钥、Secrets 路径解码、标签→版本号、`themes.xml` 补丁（含幂等/缺文件）、架构解析、用假 `zipalign/apksigner` 跑签名循环（单/多 APK 命名、找不到 APK 时报错）。

### ❓ 沙箱里**无法**验证的（需你在真机/云端确认）
- **Rust 与 Gradle 编译**：沙箱没有 Android SDK，且连不上 crates.io，`cargo` 依赖解析、`cargo tauri android init/build`、Gradle 打包都**没跑过**。`tauri-plugin-http` 的 `dangerous-settings` 特性名和 `danger.acceptInvalidCerts`（插件 ≥ 2.3.0）来自官方文档，未经编译验证。
- **GitHub Actions 实际运行**：runner 自带的 `$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager` 路径、NDK 版本能否装上、各 action 版本，均**未实跑**。生成的 Android 工程若要求更高的 compileSdk，工作流有一步会尝试补装，同样未验证。
- **真机表现**：刘海/手势条安全区（`env(safe-area-inset-*)`）、Android 返回键与 Tauri 默认返回行为的配合、软键盘遮挡、导出「下载文件」在 Android WebView 里是否生效（不行就用「复制」）、`<input type=file>` 导入在 Tauri Android 上的行为、剪贴板权限。
- **`window.__TAURI__.http` 是否存在**：官方 http 插件页面没有讲 `withGlobalTauri`；本项目假设插件会把 `fetch` 挂到该全局对象上。若真机提示「`window.__TAURI__.http` 不存在」，需要改用 `@tauri-apps/plugin-http` 打包（会引入 npm 构建，与当前方案相违）。
- **capabilities 的 URL 模式**：`http://*`、`http://*:*` 等是否匹配带端口的地址，**未验证**；我同时写了带/不带端口、带/不带路径的几种写法以提高命中率。若出现「该域名未被放行」，请把 `allow` 改成你服务器的精确地址（含端口）。
- **Headscale 接口的真实返回**：
  - 文档确认的：Bearer 认证、基路径 `/api/v1`、`GET /api/v1/user`、`POST /api/v1/auth/register`（`{user, authId}`，对应文档标注的 0.29.7）、Swagger 在 `/swagger`。
  - 取自第三方客户端源码、**未经实机验证**：`GET /api/v1/node`（数组键 `nodes`）、`GET /api/v1/user`（`users`）、`POST /api/v1/preauthkey`（返回 `preAuthKey.key`）、`GET /health`。
  - **纯凭记忆、完全未验证**：自定义按钮示例里的 `GET /api/v1/apikey`、`GET /api/v1/policy`（路径来自对 Headscale 文档的印象，示例只是起点，不对则在按钮里改路径）；节点 `rename / expire / delete` 的路径、`DELETE /user/{id}`、`POST /user` 的字段、预授权密钥列表在不同版本的差异（新版直接列出、旧版需 `?user=`）、`user` 参数是数字 ID 还是用户名（代码会先用数字、失败再用名字）、`/api/v1/auth/register` 在旧版本不存在（旧版用 `/node/register`）、响应里 `lastSeen/expiry` 等字段名。
  - 解析器对缺字段/大小写风格是宽容的，出错时界面会显示服务器返回的信息。**建议先在测试服务器上试，再碰生产环境的删除/过期操作。**
- **Headscale 是否有限流**：文档未提及，未验证；本应用按「保守」方式限速。

## 目录结构

```
.github/workflows/build-apk.yml   云编译
app-icon.png                      图标源文件（1024×1024，tools/make-icon.py 可重新生成）
src/                              前端：index.html / style.css / core.js（纯逻辑）/ app.js（界面）
src-tauri/                        Cargo.toml · tauri.conf.json · build.rs · capabilities/default.json · src/{lib,main}.rs
tests/                            core.test.js · check-workflow.py · ui-smoke.cjs
```

## 常见问题

- **Cannot find module（Gradle 阶段）**：说明 Tauri CLI 是用 npm 装的。本工作流用 `cargo install tauri-cli`，不会出现。
- **Release 步骤 403**：工作流顶层已有 `permissions: contents: write`；若仍 403，检查 *Settings → Actions → General → Workflow permissions*。
- **证书错误**：自签名证书请在服务器设置里勾选「允许自签名/无效证书」（不安全，仅用于自建内网）。
- **401/403**：API Key 无效或过期，重新 `headscale apikeys create`。
- **请求超时/连接失败**：确认手机能访问该地址与端口；反向代理需放行 `/api`。
