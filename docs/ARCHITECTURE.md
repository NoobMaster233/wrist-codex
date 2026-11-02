# 架构与职责

## 四个运行部分

| 部分 | 职责 | 生命周期 |
| --- | --- | --- |
| 日用表盘 | 时间、日期、电量、已有步数/心率 | 随表盘显示暂停与恢复 |
| ORBIT RPK | 项目、会话、阅读、录音操作、草稿确认、常用终端操作 | 页面可关闭 |
| 原生音频 / NSH / Link | 采集、执行命令、私有文件和专用蓝牙 | 当前开机期间独立待命 |
| Termux | 字节管道、连接监督、解码/转写、草稿、Codex 订阅 | 依赖安卓允许进程运行 |

恢复表盘只负责受保护的模块恢复，不承担日常业务。常驻不等于跨重启自动启动：
手环普通重启后需执行恢复入口，手机被系统终止后也需要恢复本项目服务。

## 数据路径

1. RPK 在开始录音时固定目标项目和会话。
2. App 通过原生事件事务控制音频任务，音频任务调用固件 .043 接口。
3. 停止后提交完整的带帧长度音频容器，经蓝牙传给手机。
4. 手机验证长度、CRC/SHA，并用 libopus 解码成 16 kHz 单声道 WAV。
5. 转写结果保存为持久草稿；不会自动发送。
6. 用户确认后，桥接读取会话元数据，恢复会话但排除完整历史，再提交 turn。
7. Codex 通知驱动分段消息更新。手机本机队列可以轮询；手环不定时查询服务器。

## 连接

- 日常业务：专用 UUID 4aac2058-2595-47b8-b8c7-229f6d3d98de，RFCOMM SCN11。
- 原厂 SCN5：标准安装、恢复表盘选择和必要的短时 App 唤醒。
- Android shell 通过 app_process 运行自有 Java 字节管道；不需要常驻伴侣 APK。
- 厂商认证与私有 Link 认证是独立身份。私有 Link 使用随机 32 字节密钥、HMAC-SHA256 双向认证和启动计数。
- 原厂通道仍需设备自己的厂商认证材料。私有 Link 密钥不能替代它。

标准安装会暂时交接本项目连接。不能把原厂通道的所有断链都解释为应用安装失败，
必须核对实际列表、回执和原任务状态，结果未知时不能盲目重复安装。

## 状态与重试

- 语音：preparing → recording → receiving → transcribing → ready → delivered / cancelled。
- 文件：同一任务编号保存双方断点，重新连接先核对，再继续剩余块。
- Shell：写入独占执行意图后发布事件。ACK 丢失不等于命令未执行。
- Codex：发送日志保存确认结果；结果未知需要核对，不能换编号自动重发。
- 原生加载：pending 在 insmod 前落盘，只有模块列表和健康状态匹配后才写 healthy。

## 文件入口

| 目录 / 文件 | 内容 |
| --- | --- |
| band/src/common/workspace-page.mjs | 页面状态与导航 |
| band/src/common/native-event-bus.mjs | 串行原生事件事务 |
| bridge/runtime.mjs | 组装本机服务 |
| bridge/bluetooth/ | 协议、认证、文件与原生管理 |
| bridge/direct-recording.mjs | 固定会话、转写、草稿 |
| bridge/send-journal.mjs | 防重复提交 |
| scripts/direct-service.py | 自有进程监督、重连与安装交接 |
| phone/termux-bt/ | Android Java 管道 |
| phone-research/native-audio/ | 固件绑定的 C 原生服务 |

现有转写模块使用实验性 ChatGPT 文件转写路径。适配其他转写服务时，在 runtime 的
transcribe 回调边界替换，保持音频校验、取消、超时和草稿确认语义。
