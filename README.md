# ErrorView · 异常记录预览

预览「获取记录异常信息」接口（`GET /error/record`）数据，支持筛选、趋势与崩溃分析。

**在线地址：** https://thinkerx-tools.github.io/errorView/

推送到 `main` 后，GitHub Pages 会自动更新网站（与 [KJLTool](https://github.com/thinkerx-tools/KJLTool) 相同方式）。

## 快速开始（本地）

```bash
pip install -r requirements.txt
python server.py
```

浏览器打开：

- 记录预览：http://127.0.0.1:5173/
- 变更趋势：http://127.0.0.1:5173/trend.html
- 崩溃分析：http://127.0.0.1:5173/crash.html

本地通过同源代理 `/api/proxy/error/record` 拉数；线上静态页直连接口（CORS 已对 `thinkerx-tools.github.io` 放行）。

## 功能

- 环境切换：正式服 / 测试服 / 开发服
- 条件查询：uid、type、level、version、时间范围、分页
- 本地搜索：对当前页结果做关键词过滤
- 详情弹窗：查看并复制完整 JSON；crash 记录可跳转分析
- 本地缓存：按环境与筛选条件缓存接口结果（IndexedDB，默认 10 分钟）
- 变更趋势页：聚合数量趋势、类型/等级/版本分布
- 崩溃分析页（需本地 `server.py`）：解析 `.dmp`、符号定位、AI 深挖

## AI 配置（Cursor CLI，仅本地）

1. 安装 Cursor Agent CLI 并执行 `agent login`
2. 可选：复制 `ai_config.example.json` 为 `ai_config.json`

## 本地依赖：`assets/simple`

崩溃符号定位与 AI 深挖依赖本地柜柜客户端仓库：

```text
assets/simple/
```

该目录**不会**随本仓库上传。

## 说明

- GitHub Pages：列表/趋势页可直接使用；dump 深度解析与 AI 需本机 `python server.py`
- 本地：列表走代理；崩溃分析为 `POST /api/crash/analyze`，AI 为 `POST /api/crash/ai-analyze`
