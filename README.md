# kpop_schedule_strict v3 (human-like)

目标：在不“硬闯”站点保护的前提下，尽量降低被误判为机器人（仿真人节奏），同时减少无意义重复请求。

特性：
- 排序输出（有具体日的在前，待定在后；同日按艺人/专辑名）
- 抓取 /album/ 详情页并存档为 albums/<slug>.json
- 增量抓取：已抓过且在 refresh-days 内的不重复抓（大幅减请求量）
- human 模式：低并发 + 随机等待 + 间歇性长休息 + 指数退避
- 检测 challenge/异常 HTML：遇到疑似挑战页会停止继续抓详情，输出 warnings（不尝试绕过）

安装：
```bash
cd <workspace>/skills/kpop_schedule_strict
npm install
```
