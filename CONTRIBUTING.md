# 开发与贡献

先阅读 AGENTS.md。修改后运行 npm test、python scripts/test-native.py 和
python scripts/test-publication.py。暂存待提交文件后运行 python scripts/check-publication.py，
该检查以 Git 暂存区为准。硬件验证单独描述设备、固件、操作与结果。

提交只包含源码、原创设计、合成测试数据和经核对的通用产物。
不要提交安装依赖目录、固件镜像、运行日志、个人授权对话、签名或配对材料。

新增固件适配应提供独立地址表、离线验证和设备回执，不能替换 .043 的固定地址后继续沿用旧健康状态。
新增转写后端保持现有取消、超时、音频校验与用户确认语义。
新 UI 或表盘可在不访问设备和账户的情况下先做设计、构建与模型验证。
