# 协议索引

## 原厂安装通道

SCN5 的字节流使用 L1 帧、CRC16/ARC、序号/ACK 和协商窗口；
L2 处理厂商认证、protobuf 封装、应用列表、表盘列表和 MASS 资源安装。

源码：bridge/bluetooth/l1.mjs、auth.mjs、protobuf.mjs、install-resource.mjs。
test/fixtures 中使用合成认证和传输数据，不包含真实配对记录。
标准安装与“收到任意文件”是两个独立动作。

## 专用 Link

固定 UUID 4aac2058-2595-47b8-b8c7-229f6d3d98de / SCN11；
phone/termux-bt/PrivateBluetoothPipe.java 是手机端字节管道。

- BCP1 帧承载认证、JSON、ACK、ping/pong、原生管理请求及响应。
- 私有身份为设备自己的 32 字节随机密钥；启动计数用于认证状态。
- 双向认证采用 HMAC-SHA256；帧校验与序号由协议处理，安全 RFCOMM 由蓝牙链路提供。
- READY2 才能协商原生管理能力。旧协议不能被当作 READY2 使用。
- JSON 负责业务界面；原生文件与 Shell 不依赖页面 JS。

两端实现：bridge/bluetooth/private-link-wire.mjs、
phone-research/native-audio/private-link-wire.c/.h。
合成向量和分片检查：test/private-link-wire.test.mjs、
test/native-private-link-wire.test.c。

## 原生管理

BCM1 支持 STAT / READ / WRITE / MOVE / DELETE / EXEC / CAPS。

- 路径仅限自有 App 文件目录的受限文件名，不接受目录穿越。
- 单文件上限 1 MiB，原生块不超过 4 KiB。
- 写入只接受指定任务的部分文件，提交时才能变为完成文件。
- 配对密钥、启动计数和服务内部文件不能通过普通管理入口任意读取。
- EXEC 校验现有 Shell 请求文件，先持久记录执行意图，再发布事件。
- 重复传输序号返回缓存响应；结果未知的 EXEC 不会自动再次执行。

两端实现：bridge/bluetooth/native-management.mjs、
phone-research/native-audio/management-043.c。

## 音频

原生采集写入 64 字节 BCAP0432 容器头，随后为长度前缀和 Opus 包。
服务配置为 16 kHz 单声道、20 ms 帧，最长 24 秒。
手机严格校验状态、丢包、长度及解码样本数量，只有成功完成的容器才转成 WAV。

源码：audio-service-043.c、scripts/read-native-capture.py、
band/src/common/native-audio.mjs。
结束录音后回传整个文件，不是实时音频流。

## Shell 与消息

Shell 请求包含命令、超时、输出上限和 CRC；状态单独包含超时/截断标志、
子任务 PID、回收状态和原始退出值。不能只根据 rawStatus 判断超时。
超时只回收本次拥有的子任务，不宣称覆盖所有后代进程。

Codex 接入使用本机 Unix socket 上的 WebSocket / JSON-RPC。
本项目处理项目/会话列表、分页读取、事件订阅和确认发送；需要审批的操作仍由主 Codex 客户端处理。
源码：bridge/service.mjs、codex-client.mjs、thread-feed.mjs、send-journal.mjs。
