# 本地 v4 解读数据

本地解读覆盖公历 1950–2026 年的 674,976 个出生组合和 13 个主题。按命盘中的 `birthInfo` 日期、时辰地支索引（0–11）和性别精确查询；不会再次按经度修正或改变日期。主排盘和合盘既有晚子时处理差异未在此更改。数据命中无需模型密钥；任意自由追问仍沿用原有模型配置。未命中、超出范围及数据损坏会提示原因。

## 准备数据

需要 Python 3.11 及以上、Node.js 和 `zstd` 命令；运行服务仅需 Node.js。先验证下载包：

```sh
cd /path/to/dataset-v4.0-13d
shasum -a 256 -c SHA256SUMS-all.txt
cd /path/to/ziwei-doushu
python3 scripts/prepare-v4.py /path/to/dataset-v4.0-13d/ziwei-interp-v4-all.tar
npm ci
npm run dev
```

准备阶段逐年流式解压并验证出生键、完整日期与主题，再按日压缩到 `data/v4-ready`；不会产生全部明文。以本机 1950 年测量gzip 约 225 MiB、8 秒、峰值内存约 133 MiB；Brotli 测试中单日压缩约为 gzip 的 27%，全量预计约 5 GiB，实际取决于设备。可使用 `--output /path/to/data` 指定输出目录，启动服务时设置 `ZIWEI_V4_DIR` 指向该目录。支持重新运行，校验 SHA-256 后跳过完整年份；若中途中断留下某年的孤立 `.pack`、`.json` 或 `.sha256.json`，先删除该年的这三个文件后重试。不要在准备运行中更改数据目录或文件。

生成数据被 `.gitignore` 排除；不要提交数据文件或密钥。准备过程用 `--year 1950` 可只构建一年以测试，其他年份查询将提示数据不可用。测试：`node --experimental-strip-types --test tests/v4-lookup.test.mjs`（Node 22）。


### AI 自由追问配置

AI 默认关闭。仅在明确配置 `AI_ENABLED=true`、`MODEL_BASE_URL`、`MODEL_API_KEY`、`MODEL_DEFAULT=gpt-6.1-terra`、正整数 `AI_DAILY_LIMIT` 和绝对路径 `AI_QUOTA_FILE` 后启用。额度为请求次数而非金额预算，上限为每天 50 次，按 UTC 日期重置；`AI_TIMEOUT_MS` 和 `AI_MAX_OUTPUT_TOKENS` 分别有 55 秒的超时上限和 2000 token 的请求参数上限（实际输出由供应商执行）。额度在请求供应商前计入，失败或取消也可能计数。额度文件仅保存 UTC 日期与计数，不包含问题、命盘或密钥；目录必须预先存在并可写。此文件配额只适用于单个 Node 进程，不能用于多进程或多服务器共享限额。
