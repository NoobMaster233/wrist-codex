# 运行维护

完成 SETUP 后，在仓库根目录使用：

~~~sh
python scripts/band-tools.py start --direct --allow-send
python scripts/band-tools.py status --direct
python scripts/band-tools.py status
python scripts/band-tools.py shell 'uname -a' --wait 90
python scripts/band-tools.py put /path/to/example.dat
python scripts/band-tools.py get bc-file-TRANSFER_UUID.bin /path/to/output.dat
python scripts/band-tools.py install /path/to/app.rpk --direct
python scripts/band-tools.py install /path/to/dial.face --direct --select
~~~

省略 --allow-send 创建的后端为读取模式。已存在后端不会因为连接服务 start 就被替换配置。
start 不是手机开机自动启动配置，也不是对安卓保活的保证。

## 手环普通重启后

~~~sh
node scripts/bootstrap-private-link.mjs
~~~

它选择 ID 219667880 的恢复入口，校验已部署模块，认证私有 Link 后恢复原表盘。
依赖这台设备自己生成的恢复 manifest 和仍保留的健康记录。
不能把别人的恢复产物复制过来。pending 或未知状态需要先排查。

## 只停止本项目

~~~sh
python scripts/band-tools.py stop --direct
~~~

只停蓝牙连接；不停止 Codex。省略 --direct 会同时停止本项目业务桥接。
正在进行的任务会按截止时间等待退出，不应通过强杀来绕过未确认结果。

## 录音自检

~~~sh
python scripts/band-tools.py check-audio
~~~

会真实短时采集并本机解码，涉及麦克风。它不调用转写，不创建发送草稿，也不发送 Codex 消息。
使用前应符合设备所有者当前的授权范围。

## 常见问题

| 现象 | 首先检查 |
| --- | --- |
| 本机端口拒绝连接 | 本项目业务桥接是否已启动 |
| ADB 找不到设备 | 明确目标是否在线、正常授权是否仍有效 |
| 私有连接失败 | 本设备 Link 密钥、固件、原生服务、字节管道哈希 |
| 恢复入口被阻止 | 原始 pending/healthy 状态及模块内容；保留它们 |
| 转写失败 | 网络、自己的 Codex 登录及实验性转写接口；不要重录覆盖旧草稿 |
| Codex connection closed | socket、daemon 存活和请求类型；先只读检查，不重启 daemon |
| 发送结果未知 | 查询既有发送编号、目标会话，避免重复提交 |
| 表盘显示正常但无法连接 | 表盘展示与后台原生任务是独立职责 |
| Termux 被回收 | 安卓退出记录、前台服务、缓存级别及整个进程组 |

## 安卓后台说明

后台无限制、自启动和电池优化豁免能减少限制，但不会禁止系统低内存回收。
Termux 原版本采用 START_NOT_STICKY；所有终端会话和受管理任务结束且没有唤醒锁时，
它也可能主动停止前台服务。普通退到后台与结束最后一个会话是不同操作。

不要为了保活全局禁用系统内存管理、修改 OOM 参数或关闭 MiWearCore。
同 UID 内的子进程看门狗可能一起被杀。完整自动恢复仍是待办，应与
“蓝牙断开后重新连接”分开验收。

## 源码构建原生候选

Linux 安装 ARM GNU gcc / binutils 后：

~~~sh
python scripts/build-native.py audio --output artifacts/candidates/audio
python scripts/build-native.py shell --output artifacts/candidates/shell
python scripts/build-native.py link --output artifacts/candidates/link
~~~

输出包含命令、源文件哈希、ELF 报告和反汇编。校验 ET_REL、正节对齐、无未解析导入及
允许的重定位类型。编译器变化可能改变二进制哈希；新构建不能继承原设备的 healthy 记录。
