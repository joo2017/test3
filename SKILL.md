---
name: kpop_schedule_strong
description: 最强版：发现月度日程页→抽取事件(event)→补全实体(entity)→过滤分组→双层delta（可复用、可审计）
user-invocable: true
---

## 一键跑全流程（推荐）
- `/skill kpop_schedule_strong run --months 6 --days 90`

## 分步命令
- `/skill kpop_schedule_strong discover --max-pages 6`
- `/skill kpop_schedule_strong events --months 6`
- `/skill kpop_schedule_strong enrich --concurrency 4`
- `/skill kpop_schedule_strong views --days 90 --recent 7`
- `/skill kpop_schedule_strong delta`

## 共享输出目录
默认：`~/.openclaw/kpop_schedule_strong/`
可用环境变量覆盖：`KPOP_SCHEDULE_DIR=/path/to/dir`

输出：
- month_pages.json
- events.json
- entities_seed.json
- entities.json
- views.json
- delta.json
- state/events_snapshot.json, state/entities_snapshot.json
- raw/monthly_index/*.html, raw/monthly/*.html, raw/album/*.html
