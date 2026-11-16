# 打包与安装

## 依赖

- `fnpack`（fnOS 官方打包工具，1.2.x）。`build.sh` 会先找 `PATH` 里的 `fnpack`，再退回 `/tmp/fnpack/fnpack`；也可以用 `FN_PACK=/path/to/fnpack ./build.sh` 指定。
- `python3`（只用于校验 JSON 与目录检查）与 `node`（语法检查 + 生成图标）。

## 产物

```
x2media.fpk          # 可直接在应用中心手动安装
├── manifest
├── ICON.PNG         # 64
├── ICON_256.PNG     # 256
├── app.tgz          # 解包后是 server/ ui/ config/
├── cmd/*            # 生命周期脚本
├── config/*         # privilege / resource
└── wizard/*         # 安装、升级、配置、卸载向导
```

注意 `app.tgz` 里没有 `app/` 这一层：安装后代码位于 `${TRIM_APPDEST}/server/`，入口资源在 `${TRIM_APPDEST}/ui/`。`cmd/main` 就是按这个路径启动的。

## 安装后的目录

| 路径 | 内容 | 可写 |
| --- | --- | --- |
| `${TRIM_APPDEST}` | 解包后的程序（server、ui、cmd、manifest） | 只读 |
| `${TRIM_PKGVAR}` | `settings.json`、`library.jsonl`、`info.log`、`downloads/`、`runtime/`（便携 Node） | 是 |

## 生命周期

| 脚本 | 做什么 |
| --- | --- |
| `install_init` | 记日志 |
| `install_callback` | 建 `downloads/logs/cache`，确保 Node 运行时（系统有就用系统的），把向导里的下载目录写进 `settings.json` |
| `upgrade_init` | 停服务 |
| `upgrade_callback` | 补一次运行时检查，拉起服务 |
| `config_init` / `config_callback` | 把向导字段写回 `settings.json` 并重启 |
| `uninstall_init` | 停服务 |
| `uninstall_callback` | 删便携运行时与 pid；`wizard_data_action=delete` 时清空整个私有目录，`keep` 时保留 |

`cmd/main` 约定：`start|stop|restart|status`，`status` 运行中 `exit 0`、未运行 `exit 3`。

## 本地验证（不装 NAS 也能跑）

```bash
rm -rf /tmp/sim && mkdir -p /tmp/sim/{dest,var}
tar -xzf x2media.fpk -C /tmp/sim/dest
(cd /tmp/sim/dest && tar -xzf app.tgz && rm app.tgz)

export TRIM_APPDEST=/tmp/sim/dest TRIM_PKGVAR=/tmp/sim/var X2_PORT=18999
bash /tmp/sim/dest/cmd/install_callback
bash /tmp/sim/dest/cmd/main start
curl -s http://127.0.0.1:18999/api/state | head -c 300
bash /tmp/sim/dest/cmd/main status; echo "status=$?"   # 0
bash /tmp/sim/dest/cmd/main stop
```

## 端口

`manifest` 的 `service_port = 8787`、`app/ui/config` 的 `port`、`cmd/main` 的默认端口三处一致。要改端口就三处一起改（或用 `X2_PORT` 临时覆盖，只影响服务监听）。
