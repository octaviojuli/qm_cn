# 阿里云 ECS 自托管部署手册

这份手册部署的形态是:**控制面五个容器跑在一台 ECS 上,agent 沙箱用本机 Docker(`SANDBOX_BACKEND=local`),
状态落阿里云 RDS PostgreSQL,镜像在主机本地构建。** 不接 OSS,不接 ACR,不接 Slack,不接任何境外模型厂商。
部署由 GitHub Actions 通过 SSH 推,平时不需要登录 ECS。

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
| 镜像加速器          | 容器镜像服务的加速地址              | 基础镜像是 digest 固定的 `node:24-alpine` / `node:24-slim`,主机直连 Docker Hub 不稳                          |
| 域名 + 证书         | 公网访问需 ICP 备案                 | Portal 是公网门面。纯内网部署可跳过                                                                          |
| 邮件推送 DirectMail | 一个发信域名                        | 登录链接靠它发。也可用任意支持 TLS 的 SMTP                                                                   |
| 模型服务            | 百炼 / DashScope 等 OpenAI 兼容端点 | 部署后在 Admin 页注册为自定义 provider                                                                       |

ECS 主机上只需要三样:**Docker(含 compose 插件)、sshd、`curl`**。不需要 Node,不需要 git ——
需要 Node 的步骤全部在 GitHub runner 上完成。部署账号要能免密 `docker`(在 `docker` 组里),
并对 `/opt/qm` 有写权限。

## 部署方式:GitHub Actions 推,主机构建

部署由 `.github/workflows/deploy-aliyun.yml` 驱动,手动触发(`workflow_dispatch`)。
**ECS 主机上只需要 Docker、docker compose 插件和 sshd** —— 不需要 Node、不需要 git、不需要 ACR。

分工的依据很实际:runner 在境外,拉 GitHub Release 和 npm 都顺,所以
**vendor pi 依赖、渲染 compose、算沙箱镜像 fingerprint 都在 runner 上做**;
镜像构建和运行在 ECS 上做,避免把几个 GB 的镜像跨境推来推去。

一次运行的顺序:

1. checkout,按 `.node-version` 装 Node
2. `scripts/vendor-pi.sh` —— 把 pi 的 tarball 抓进 `vendor/` 并改写依赖指向
3. `scripts/render-compose.ts` —— 用仓库变量注入真实域名后生成 compose
4. 把渲染结果打进 job 日志(其中只有 `${VAR}` 引用,没有密钥值,可安全查看)
5. 算沙箱镜像 fingerprint
6. 用仓库密钥写出 `.env`,并**在 runner 上先校验**:缺项直接失败,签名类密钥不足 32 字符也直接失败
7. `ssh-keyscan` 建立 known_hosts,打包工作树 scp 到主机 `/opt/qm`,`.env` 单独传并 `chmod 600`
8. 主机上构建沙箱镜像(`fly/Dockerfile` 打底,叠 `local/Dockerfile`)
9. 主机上 `docker compose build && up -d --remove-orphans`
10. 轮询 `/healthz`,最多 30 次 × 4 秒;失败则把 core 最后 80 行日志打出来再退出非零
11. 无论成败都清掉 runner 上的 `.env`、私钥和 tar 包

### 需要在仓库里配的东西

**Secrets**(Settings → Secrets and variables → Actions → Secrets):

连接主机的三个 —— `ECS_HOST`、`ECS_USER`、`ECS_SSH_KEY`(私钥全文)。

应用密钥十五个,与 `qm check` 输出的权威清单一致(已交叉校验),外加自托管特有的 `DATABASE_URL`:

`CORE_SIGNING_SECRET` `CAPABILITY_SECRET` `PORTAL_IDENTITY_SECRET` `CONNECTOR_SECRET_KEY`
`SKILL_SIGNING_SECRET` `PORTAL_SESSION_SECRET` `AUTH_TOKEN_SECRET` `AUTH_CLIENT_SECRET`
`AUTH_SIGNING_JWK` `AUTH_EMAIL_FROM` `SMTP_HOST` `SMTP_USERNAME` `SMTP_PASSWORD`
`PUBLIC_API_URL` `DATABASE_URL`

前八个是签名/加密密钥,**必须至少 32 字符**(`MIN_SIGNING_SECRET_LENGTH = 32`;不达标 core 启动时报
`missing or insecure required core secrets`):

```bash
openssl rand -hex 32
```

`AUTH_SIGNING_JWK` 是一把 P-256 私钥:

```bash
node -e "const {generateKeyPairSync}=require('node:crypto');process.stdout.write(JSON.stringify(generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({format:'jwk'})))"
```

**Variables**(同一页面的 Variables 标签,非密钥):

- `QM_PUBLIC_URL` —— 部署的公网地址,例如 `https://qm.example.com`
- `QM_AUTH_EMAIL_DOMAIN` —— 允许登录的邮箱域名

这两项以变量而非提交值的形式存在,是为了让 `qm.config.jsonc` 留在仓库里当模板。
`render-compose.ts` 有占位符守卫:两者任一未注入就直接报错,不会渲染出一份带
`REPLACE-WITH-…` 的 compose 悄悄部署上去。

### 触发

Actions → Deploy to Aliyun ECS → Run workflow。`ref` 输入可留空(用当前分支)。
`concurrency` 保证不会有两次部署叠在一起。

工作流只在手动触发时运行。若要改成推到 `main` 即部署,给 `on:` 加一个 `push` 触发器 ——
但第一次上线前建议保持手动。

### 手动兜底

主机上装了 Node ≥ 24 的话,同一套东西可以手工跑:

```bash
cp deploy/layers/qmcn/.env.aliyun.example deploy/layers/qmcn/.env   # 填值
bash deploy/layers/qmcn/scripts/vendor-pi.sh
QM_PUBLIC_URL=https://qm.example.com QM_AUTH_EMAIL_DOMAIN=example.com \
  node deploy/layers/qmcn/scripts/render-compose.ts
bash scripts/local-sandbox-build.sh
cd deploy/layers/qmcn && docker compose up -d --build
```

core 日志出现 `[qm] listening on :8080 (org=qmcn, store=postgres, runStore=postgres, ...)` 即为正常。

### 端口

全部只绑 `127.0.0.1`,由 SLB 或本机 Nginx 反代出去:

| 服务   | 本机端口     |
| ------ | ------------ |
| core   | 8080         |
| portal | 8081         |
| web-ui | 8082         |
| admin  | 8083         |
| auth   | 仅容器网络内 |

对外只需暴露 **portal**(8081) —— 它按路径前缀反代 web-ui、admin 与 auth。

## 部署后:注册模型 provider

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

还有一条来自部署方式本身的取舍,与沙箱无关:

4. **CI 持有全部签名与加密密钥。** 密钥存在 GitHub Secrets 里,每次部署由 workflow 写成 `.env`。
   这意味着任何能修改 workflow 或触发它的人,都能间接拿到 `CONNECTOR_SECRET_KEY`(连接器凭据的加密密钥)
   和全部签名密钥。**这个暴露是不可撤销的** —— 一旦想收回,必须轮换全部密钥,而
   `CONNECTOR_SECRET_KEY` 的轮换会牵动已加密存储的连接器凭据。
   若日后要收紧,顺序是:把密钥迁到阿里云 KMS / 凭据管家,让主机在部署时自取,CI 只保留 SSH 权限;
   然后轮换所有曾进过 CI 的密钥。建议同时给这条 workflow 加 GitHub Environment 保护规则
   (必需审批人 + 分支限制),把"谁能触发部署"收窄。

## 本 fork 的偏离清单

自用 fork 不向上游投稿,但仍需记录偏离,否则 `update-qm` 合并时无从判断冲突该怎么解。

| 文件                                  | 偏离                                                          | 原因                                           |
| ------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------- |
| `.github/workflows/deploy-aliyun.yml` | 新增                                                          | 上游明确不带生产部署 workflow;CI 目录属于 core |
| `package.json`                        | `@earendil-works/pi-coding-agent` 由 URL 改为 `file:vendor/…` | GitHub Release tarball 在国内拉取不稳          |
| `package-lock.json`                   | 随上一条重算                                                  | 同上                                           |
| `vendor/*.tgz`                        | 新增                                                          | 被 vendor 的依赖本体                           |
| `deploy/layers/qmcn/**`               | 新增                                                          | 组织层,按契约不属于 core                       |

注:`package.json` / `package-lock.json` / `vendor/` 三项由 `vendor-pi.sh` 在 **CI runner 上**每次运行时
产生,**不提交进仓库**。它们仍然列在这里,因为构建产物的依赖来源确实偏离了上游,排查问题时需要知道。

除此之外 core 保持与上游一致。若日后改为在本地提交 vendor 结果,合并上游时保留本地的 `file:` 指向
并重跑 `scripts/vendor-pi.sh`(它对已 vendor 的树是幂等的)。
