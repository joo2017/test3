# kpop_schedule_strong (v2)

修复点：
- 某些环境对 category 页返回 404：改用更像浏览器的请求头，并在 discover 失败时回退到 /kpop-comebacks/ 作为月度页索引源。

安装：
```bash
cd <workspace>/skills/kpop_schedule_strong
npm install
```

运行：
- `/skill kpop_schedule_strong run --months 6 --days 90`
