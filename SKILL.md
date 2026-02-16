---
name: kpop_schedule_strict
description: v4 分页全量版：月度目录翻页→月度页抽取日程→排序→（可选）仿真人增量抓详情页；仅“有具体日且已过去”才过滤
user-invocable: true
---

## 推荐（不漏 + 年份正确）
/skill kpop_schedule_strict run --source monthly --max-pages 12 --months 12 --mode human --limit 120 --concurrency 1 --refresh-days 14

## 只生成总表（不抓详情页）
/skill kpop_schedule_strict run --source monthly --max-pages 12 --months 12 --no-albums
