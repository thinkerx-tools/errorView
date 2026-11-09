# ErrorView · 异常记录预览

预览「获取记录异常信息」接口（`GET /error/record`）数据，支持筛选与本地关键词搜索。

## 快速开始

```bash
pip install -r requirements.txt
python server.py
```

浏览器打开：

- 记录预览：http://127.0.0.1:5173/
- 变更趋势：http://127.0.0.1:5173/trend.html
- 崩溃分析：http://127.0.0.1:5173/crash.html

也可直接用浏览器打开对应 HTML（崩溃 dump 深度解析需通过 `server.py`）。

## 功能

- 环境切换：正式服 / 测试服 / 开发服
- 条件查询：uid、type、level、version、时间范围、分页
- 本地搜索：对当前页结果做关键词过滤
- 详情弹窗：查看并复制完整 JSON；crash 记录可跳转分析
- 本地缓存：按环境与筛选条件缓存接口结果（IndexedDB，默认 10 分钟）；「查询」优先读缓存，「刷新数据」强制重新请求
- 变更趋势页：自由筛选区间与条件，聚合数量趋势、类型/等级/版本分布
- 崩溃分析页：解析 `.dmp` 异常落点 + 崩溃前日志，输出可能原因与建议
- 符号定位：按版本号映射 `assets/simple` 分支（如 `5.0.0.5-8` → `master5005`），提取 `pdb/guigui.pdb` 与 exe；若分支无 pdb，则明确提示无法继续精确符号排查
- AI 深挖：默认调用本地 Cursor CLI（`agent -p --mode ask`）在 `assets/simple` 工作区分析；失败时回退本地规则检索，并支持复制提示词

## AI 配置（Cursor CLI）

1. 确保本机已安装 Cursor Agent CLI（通常在 `%LOCALAPPDATA%\cursor-agent\agent.cmd`）
2. 先登录一次：

```bash
agent login
```

3. 可选：复制 `ai_config.example.json` 为 `ai_config.json`

```json
{
  "provider": "cursor-cli",
  "mode": "ask",
  "workspace": "assets/simple",
  "timeoutSec": 300
}
```

## 本地依赖：`assets/simple`

崩溃符号定位与 AI 深挖依赖本地柜柜客户端仓库，请自行放到：

```text
assets/simple/
```

该目录体积很大（含 exe/pdb），**不会**随本仓库上传。可从内部 GitLab 克隆 `banshi_simple` 后放到上述路径。

## 说明

列表/趋势页直接请求对应环境的 `/error/record`。崩溃分析通过本地 `POST /api/crash/analyze` 下载并解析 OSS dump，并在 `assets/simple` 对应发版分支上查找 PDB。AI 深挖接口为 `POST /api/crash/ai-analyze`（默认走 Cursor CLI）。
