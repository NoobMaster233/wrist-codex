# 部署到自己的设备

## 1. 前置条件

| 条件 | 说明 |
| --- | --- |
| 手环 | Xiaomi Smart Band 10 Pro，M2551B1，固件 3.101.043 |
| 手机 | 已与该手环正常配对的安卓手机，安装 Termux |
| ADB | 已授权的本机调试连接，默认 127.0.0.1:5555 |
| 厂商认证密钥 | 该手环自己的 16 字节认证材料，由所有者提供私有导出 |
| Codex | 在手机可正常运行、已登录，提供 App Server Unix socket |
| 工具 | Node.js 22+、Python 3、OpenSSL、Lua 5.4、C 编译器 |
| 构建字节管道 | JDK 17+；脚本按哈希下载 Android API / D8 |
| 音频解码 | libopus |
| 表盘构建 | Lua 5.4、rsvg-convert、ImageMagick 的 magick 命令 |

本项目不提供认证绕过，也不包含从未 root 官方健康 App 自动取密钥的工具。
请使用设备所有者已有、明确授权的配对工具导出。不同工具的字段可能不同，需整理为下述私有 JSON。
获取不到时应在这里停止设备部署，不应复制别人的密钥或解除配对“试试看”。

**原生加载可能导致手环系统异常并需要恢复出厂、重新配对。**
原设备研究中确实发生过异常。首次加载前先确认型号和固件、备份可同步的数据，并取得本设备所有者对该次操作的授权。
本说明没有要求 root、刷写手机固件或停用系统蓝牙。

同一手机已有本项目工作目录运行时，不要同时从新的 clone 启动第二份桥接。先核对现有进程、私有身份和端口归属。

## 2. 获取与离线检查

~~~sh
git clone https://github.com/NoobMaster233/wrist-codex.git
cd wrist-codex
npm ci
npm test
python scripts/test-native.py
python scripts/check-publication.py
~~~

在 Termux 中安装对应工具；包名会随仓库变化，先核对本机包列表。
常用包为 python、nodejs、git、android-tools、openssl、libopus、lua54、clang、openjdk-17。
不需要在手机编译原生模块时，可使用 resources/native 中的固定产物。

### 可选：使用发布附件

GitHub Releases 的通用二进制 ZIP 包可以解压到本 clone 根目录。
手机字节管道会落在 artifacts/research/ 下，可跳过步骤 5 的编译。
预编译 RPK 位于 app/ 下，可用它替换步骤 8 的 RPK 路径；五款表盘位于 watchfaces/ 下。
附件不含任何设备身份和部署加载器，步骤 4、8—9 的私有配置仍然需要完成。
预编译 RPK 使用独立公开发布签名，不要与自己生成的另一签名交替覆盖安装。

## 3. 确认自己的 ADB

~~~sh
adb devices -l
adb -s 127.0.0.1:5555 shell id
~~~

如使用其他明确授权的端点，设置 BAND_ADB_SERIAL。默认建议使用本机回环地址。
无线调试配对、Shizuku 启动或 RSA 确认仍需遵循手机正常授权流程；Shizuku 已运行不代表 5555 已监听。
不要扫描别人的设备、关闭认证、修改永久调试属性，或在有多个设备时运行未指定目标的调试模式切换。

## 4. 导入私有身份

在仓库外准备一个权限 600 的 JSON 文件。内容格式如下，示例值必须换成自己的：

~~~json
{
  "bandAddress": "AA:BB:CC:DD:EE:FF",
  "authKeyHex": "<自己的32个十六进制字符>"
}
~~~

~~~sh
chmod 600 /private/path/band-auth.json
python scripts/configure-device.py \
  --address AA:BB:CC:DD:EE:FF \
  --auth-file /private/path/band-auth.json
~~~

脚本只写本机 .local/，不连接手机；会保留已有身份，生成独立 Link 的随机 32 字节密钥。
厂商认证密钥和 Link 密钥是两种不同材料。不要把密钥放在命令行参数、Git、issue 或聊天中。

## 5. 构建手机字节管道

~~~sh
python scripts/setup-vendor.py
python scripts/build-bluetooth-pipe.py
python scripts/build-private-bluetooth-pipe.py
~~~

setup-vendor 按固定 SHA256 验证下载的 Android API / D8 文件，下载内容只在 .cache/ 中。
JAR 构建产物在 artifacts/ 中。脚本默认保护既有产物；不要覆盖正在使用的字节管道。

## 6. 构建 RPK

~~~sh
python scripts/signing.py
cd band
npm ci
npm run release
cd ..
~~~

签名私钥只在 band/sign/ 和 .local/ 中生成，不进入 Git。
新生成的签名不同于原开发设备签名；不能承诺可覆盖另一签名安装的同包名应用。
在自己的新设备上应使用自己固定保存的签名身份；已有同包应用时先核对数据与签名，不能自动卸载来绕过失败。

## 7. 连接已有 Codex

优先连接已经运行的 App Server，不重启它：

~~~sh
export BAND_CODEX_SOCKET="/absolute/path/to/app-server-control.sock"
node scripts/probe-codex.mjs
~~~

如果没有运行中的服务，可由所有者按自己安装版本启动新的 App Server。
官方支持显式 Unix socket 监听；例如在单独终端中：

~~~sh
codex app-server --listen "unix://$HOME/.codex/wrist-codex.sock"
~~~

此时在桥接终端把 BAND_CODEX_SOCKET 设为同一路径。Codex 的 Termux 安装和 Android 兼容构建不包含在本仓库内。
默认代码兼容原 Termux 构建的 app-server-control-termux 路径；其他安装应显式配置。
接口依据：[OpenAI App Server 文档](https://learn.chatgpt.com/docs/app-server)。

## 8. 首次安装 RPK 并上传模块

先启动本项目的桥接，再用厂商通道安装 RPK。以下操作会写入自己的手环：

~~~sh
python scripts/start-astro.py --allow-send
python scripts/direct-service.py use-factory
python scripts/band-tools.py install band/dist/dev.bandcodex.remote.release.0.4.3.rpk --direct
python scripts/band-tools.py start --direct --allow-send
~~~

打开手环 App，保持它可处理普通文件命令。首次阶段的厂商通道仍可能与系统连接竞争；不要因此停用 MiWearCore 或清除配对。

~~~sh
python scripts/band-tools.py put resources/native/3.101.043/audio.ko
python scripts/band-tools.py put resources/native/3.101.043/shell.ko
python scripts/band-tools.py put resources/native/3.101.043/link.ko
python scripts/band-tools.py put .local/private-link-v1.key
~~~

每次保存输出中实际完成的回执路径。回执位于 .local/file-delivery-receipts/，包含任务编号、大小、SHA256 和手环文件 URI。
四份回执必须各自匹配这次上传，不能复制文档中的编号或使用未完成回执。
普通文件传输不会自动执行模块。

## 9. 按回执生成专属安装与恢复入口

~~~sh
python scripts/build-service-bundle.py \
  --audio-receipt .local/file-delivery-receipts/file-AUDIO_UUID.json \
  --shell-receipt .local/file-delivery-receipts/file-SHELL_UUID.json \
  --link-receipt .local/file-delivery-receipts/file-LINK_UUID.json \
  --key-receipt .local/file-delivery-receipts/file-KEY_UUID.json
~~~

替换四个示例路径。构建器会核对回执、固定模块哈希、Lua 语法及恢复模型。
产物位于 artifacts/research/private-service-recovery-043-v2-compact/：

| 文件 | 职责 |
| --- | --- |
| first-install.face / ID 219667887 | 按已上传文件配置 Link 密钥，首次受保护加载三项服务 |
| recovery.face / ID 219667880 | 重启后仅恢复之前确认健康的模块 |
| manifest.json | 本设备的模块路径与恢复入口信息 |

产物不嵌入密钥字节，但包含设备文件路径，应当留在本机，不发布为“通用恢复表盘”。
首次入口的离线检查不能替代在另一只手环上的硬件验证；这一公开首装流程仍属于实验性移植。

所有者确认首次加载后：

~~~sh
python scripts/band-tools.py install artifacts/research/private-service-recovery-043-v2-compact/first-install.face --direct --select
~~~

在手环确认“服务已就绪”，再切换到专用通道：

~~~sh
python scripts/direct-service.py use-private
python scripts/band-tools.py status
python scripts/band-tools.py shell 'uname -a' --wait 90
python scripts/band-tools.py install artifacts/research/private-service-recovery-043-v2-compact/recovery.face --direct
~~~

若加载状态为 pending、超时、模块重复或哈希不符，保留证据并停止。
不能删除状态文件后再试，也不能在线卸载模块。先检查回执和状态，必要时按正常重启恢复流程处理。

## 10. 安装日用表盘

~~~sh
python scripts/build-presentation-faces.py --revision 3
python scripts/band-tools.py install artifacts/research/presentation-faces-043-v3/5/afterglow.face --direct --select
~~~

五个主题编号为 4—8，名称见 README。它们只展示时间和已有健康数据。
恢复入口需要保留，但不必作为日用表盘。

## 11. 验收语音与消息

先运行只做短时原生采集和本机解码的自检：

~~~sh
python scripts/band-tools.py check-audio
~~~

这不会转写或发送消息。要验证完整语音，由用户在手环选项目和会话，
录一句话、结束录音，核对转写文字并确认发送。
当前转写适配器读取本机自己的 Codex ChatGPT 登录凭据，使用实验性会话接口。
不能把它宣传为所有账号可用的官方转写 API；失效时保留音频和草稿，另行适配转写后端。
