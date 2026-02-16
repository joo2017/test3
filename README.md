# kpop_schedule_strong

最强版抓取：月度日程页（event权威） + 专辑详情页（entity补全） + upcoming/recent/tbd 过滤 + 双层 delta。

安装：
```bash
cd <workspace>/skills/kpop_schedule_strong
npm install
```

运行：
- `/skill kpop_schedule_strong run --months 6 --days 90`

默认输出：`~/.openclaw/kpop_schedule_strong/`
可通过 `KPOP_SCHEDULE_DIR` 修改。
