# 阿里云 ECS 自托管部署手册

这份手册部署的形态是:**控制面五个容器跑在一台 ECS 上,agent 沙箱用本机 Docker(`SANDBOX_BACKEND=local`),
状态落阿里云 RDS PostgreSQL,镜像走 ACR。** 不接 OSS,不接 Slack,不接任何境外模型厂商。

## 为什么不用 `qm up`

QM 自带的 CLI 有三个部署目标(`docker` / `fly` / `aws`),但**没有一个对应"自托管沙箱"**:

- `docker` 与 `fly` 两个后端的 `requiresSandboxApp` 都是 `true`,`qm check` 会要求
  `sandbox.app`(一个 Fly app)以及一个 digest 固定的 Fly 沙箱镜像。
- CLI 的配置语言里没有 `local` 这个词:`SandboxConfig.backend` 的类型只有 `"sprites" | "aws"`。
- `docker` 后端的 `serviceEnv()` 在合并完用户配置之后**又一次**覆盖 `DATABASE_URL`,指向它自己起的
  `postgres:16` 容器,所以无法指向 RDS。

也就是说 CLI 的 `docker` 目标是「本地控制面 + Fly 沙箱」的开发形态,不是自托管形态。

**但 core 完全支持自托管。** `SANDBOX_BACKEND` 接受 `aws | local | sprites`,而且**不设置时默认就是
`local`**;`src/sandbox/local-sandbox.ts` 是完整实现(常驻磁盘、支持后台进程会话),仓库还带着
`npm run sandbox:local:build` 和 `npm run smoke:local-sandbox`。

所以这里的做法是:**用 CLI 做配置与密钥清单的权威来源,用 compose 做编排。**
`docker-compose.yml` 不是手写的 —— 它由 `scripts/render-compose.ts` 调用 CLI 自己的
`dockerServiceEnv()` / `orgEnv()` / `brokerWiring()` 生成,所以服务间 URL、OIDC broker 接线、
端口偏移都与 `qm up` 会做的一致。改完 `qm.config.jsonc` 后重新生成即可。

## 前置

| 资源                | 规格建议                            | 说明                                                                                                         |
| ------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| ECS                 | ≥ 8 vCPU / 16 GiB,系统盘 ≥ 100 GiB  | 5 个控制面容器 + **每个 scope 一个常驻沙箱容器**。沙箱是 `resident_disk`,不自动回收,按人数估容量而不是按并发 |
| RDS PostgreSQL      | 基础版即可,开启 SSL                 | 36 张表由各模块启动时幂等自建,无需预置 schema                                                                |
| ACR 容器镜像服务    | 一个命名空间                        | 官方镜像不存在(`cli/manifest.json` 里是 `registry.invalid` 占位符),必须自建                                  |
| 镜像加速器          | 容器镜像服务的加速地址              | 基础镜像是 digest 固定的 `node:24-alpine` / `node:24-slim`,直连 Docker Hub 不稳                              |
| 域名 + 证书         | 公网访问需 ICP 备案                 | Portal 是公网门面。纯内网部署可跳过                                                                          |
| 邮件推送 DirectMail | 一个发信域名                        | 登录链接靠它发。也可用任意支持 TLS 的 SMTP                                                                   |
| 模型服务            | 百炼 / DashScope 等 OpenAI 兼容端点 | 部署后在 Admin 页注册为自定义 provider                                                                       |

ECS 上需要:Docker、Node ≥ 24.15(仅用于跑 CLI 与构建脚本)、git。

## 部署步骤

### 1. Vendor pi 依赖

`@earendil-works/pi-coding-agent` 是一个 GitHub Release tarball,不在 npm registry 上,
npm 镜像源代理不了它。而 `deploy/core/Dockerfile` 里有 `npm ci`,所以**镜像构建时**就需要它。

```bash
bash deploy/layers/qmcn/scripts/vendor-pi.sh
```

脚本把 tarball 下到 `vendor/`、记下 sha256、把 `package.json` 指向 `file:vendor/<name>.tgz`、
重算 lockfile。`.dockerignore` 没有排除 `vendor/`,构建上下文能带上。

这一步会改 `package.json` 与 `package-lock.json` —— **本 fork 唯一必须偏离上游的核心文件**,记进下面的偏离清单。

### 2. 构建并推送镜像

```bash
export ACR_REGISTRY=registry.cn-hangzhou.aliyuncs.com/<your-namespace>
docker login "$ACR_REGISTRY"
bash deploy/layers/qmcn/scripts/build-push-acr.sh
```

它构建并推送 `qm-core` / `qm-web-ui` / `qm-admin` / `qm-portal` / `qm-auth` 五个镜像
(全部以仓库根为构建上下文),然后调用仓库自带的 `scripts/local-sandbox-build.sh` 构建 agent 沙箱镜像
`qm-sandbox-local:latest`(基础层来自 `fly/Dockerfile`,叠加 `local/Dockerfile`)。
沙箱镜像留在 ECS 本机,不需要推 ACR。

脚本会在构建前拒绝未 vendor 的树,避免在 `npm ci` 那一步才失败。

### 3. 填配置与密钥

编辑 `qm.config.jsonc`,替换两个占位:

- `publicUrl` → 你的公网地址(或内网地址)
- `env.auth.AUTH_ALLOWED_EMAIL_DOMAIN` → 允许登录的邮箱域名

改完重新生成 compose:

```bash
node deploy/layers/qmcn/scripts/render-compose.ts
```

然后 `cp .env.aliyun.example .env` 并填值。签名类密钥**至少 32 字符**
(`MIN_SIGNING_SECRET_LENGTH = 32`,不达标 core 会在启动时报
`missing or insecure required core secrets`):

```bash
openssl rand -hex 32
```

`AUTH_SIGNING_JWK` 是一把 P-256 私钥:

```bash
node -e "const {generateKeyPairSync}=require('node:crypto');process.stdout.write(JSON.stringify(generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({format:'jwk'})))"
```

必需密钥集与 `qm check` 输出的权威清单一致,已交叉校验过:
`AUTH_CLIENT_SECRET` `AUTH_EMAIL_FROM` `AUTH_SIGNING_JWK` `AUTH_TOKEN_SECRET` `CAPABILITY_SECRET`
`CONNECTOR_SECRET_KEY` `CORE_SIGNING_SECRET` `PORTAL_IDENTITY_SECRET` `PORTAL_SESSION_SECRET`
`PUBLIC_API_URL` `SKILL_SIGNING_SECRET` `SMTP_HOST` `SMTP_PASSWORD` `SMTP_USERNAME`,外加自托管特有的
`DATABASE_URL`。

### 4. 起服务

```bash
cd deploy/layers/qmcn
docker compose up -d
docker compose ps
docker compose logs -f core
```

core 日志出现 `[qm] listening on :8080 (org=qmcn, store=postgres, runStore=postgres, ...)` 即为正常。

端口(全部只绑 `127.0.0.1`,由 SLB 或本机 Nginx 反代出去):

| 服务   | 本机端口     |
| ------ | ------------ |
| core   | 8080         |
| portal | 8081         |
| web-ui | 8082         |
| admin  | 8083         |
| auth   | 仅容器网络内 |

对外只需暴露 **portal**(8081) —— 它按路径前缀反代 web-ui、admin 与 auth。

### 5. 注册模型 provider

部署时没有配 `modelProvider`,所以此刻还没有可用模型。用 Admin 页面注册一个自定义 provider:

- 协议:`openai`(百炼、DeepSeek、Kimi、智谱都兼容)
- base URL:该服务的 OpenAI 兼容端点
- API key 与模型 id 清单

注册后的模型走 pi-ai 的同一条请求路径,与内置 provider 平级出现在目录里。
**注意自定义 provider 只对 pi harness 可用** —— 这是接国产模型时锁定 pi 的原因。

如果走的是企业自建的合规中转,另一条路是给 core 加
`ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` 环境变量指向中转地址,这样内置 provider 也能用。

## 验证清单

```bash
curl -fsS http://127.0.0.1:8080/healthz
docker compose exec core node -e 'console.log(process.env.SANDBOX_BACKEND)'
psql "$DATABASE_URL" -c "\dt" | head -20
```

健康端点是 `/healthz`(公开、免鉴权,返回 `{"ok":true}`)。

跑一轮真实对话之后再确认:

- `docker ps` 里出现了以 scope 命名的沙箱容器
- `psql -c "select count(*) from session_entries"` 有增长
- Admin 页的 metrics 与 audit 有记录

沙箱本身可以单独验:`npm run smoke:local-sandbox`。

## 安全须知

这套形态相比 AWS microVM 形态有三处实质降级,**上线前需要明确接受**:

1. **core 容器挂载了 `/var/run/docker.sock`。** `local-sandbox.ts` 是通过 `docker run` 创建沙箱的,
   所以 core 必须能访问 Docker daemon。这等于**core 容器拥有 ECS 主机的 root 等价权限** ——
   一旦 core 被攻破,主机即失守。缓解方向:改用 rootless Docker,或在 core 与 daemon 之间放一个
   socket 代理只放行必需的 API。这是本形态最重的一条,不要忽略。
2. **出网强制完全失效。** `local-sandbox.ts` 的 profile 把 `egressEnforcement` 硬编码为 `"none"`,
   而 Envoy 出网代理只接在 sprites 路径上。`EgressPolicy` 在这里只是一份文档。
   补偿做法:把出网管控下移到**安全组与 VPC 路由** —— 沙箱容器放独立网段,默认拒绝出网,
   只白名单模型服务端点。基础设施层的边界比应用层策略更硬。
3. **沙箱是容器隔离,不是 microVM。** 共享内核。叠加 QM 自己承认的「沙箱内凭据明文」与
   「命令策略可绕过」,结论是:**不要在这套形态里跑不可信代码,也不要把高权限生产凭据放进个人 scope 的
   keychain。** 如需补回内核隔离,评估 gVisor 或 Kata 作为沙箱容器的运行时。

治理类控制(身份、作用域、审批、审计)不受影响,与 microVM 形态一致。

## 本 fork 的偏离清单

自用 fork 不向上游投稿,但仍需记录偏离,否则 `update-qm` 合并时无从判断冲突该怎么解。

| 文件                    | 偏离                                                          | 原因                                  |
| ----------------------- | ------------------------------------------------------------- | ------------------------------------- |
| `package.json`          | `@earendil-works/pi-coding-agent` 由 URL 改为 `file:vendor/…` | GitHub Release tarball 在国内拉取不稳 |
| `package-lock.json`     | 随上一条重算                                                  | 同上                                  |
| `vendor/*.tgz`          | 新增                                                          | 被 vendor 的依赖本体                  |
| `deploy/layers/qmcn/**` | 新增                                                          | 组织层,按契约不属于 core              |

除此之外 core 保持与上游一致。合并上游时若这两个文件冲突,保留本地的 `file:` 指向并重跑
`scripts/vendor-pi.sh`(它对已 vendor 的树是幂等的)。
