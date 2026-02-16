---
name: kpop_schedule_strict
description: v3 人类节奏版：排序+详情页补全+增量抓取；仅“有具体日且已过去”才过滤；其余一律待定；不会输出unknown
user-invocable: true
---

## 推荐（仿真人/低风险）
/skill kpop_schedule_strict run --mode human --limit 80 --concurrency 1 --refresh-days 7

## 快速抓（测试用，风险更高）
/skill kpop_schedule_strict run --mode fast --limit 200 --concurrency 6 --refresh-days 1

## 输出
- ~/.openclaw/kpop_schedule_strict/schedule.json （已排序）
- ~/.openclaw/kpop_schedule_strict/albums/<slug>.json （详情页）
- ~/.openclaw/kpop_schedule_strict/state.json （增量状态）
- ~/.openclaw/kpop_schedule_strict/summary.json （统计+warnings）
