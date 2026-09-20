# Bronymap

一个隐私优先的小马迷地图。浏览器会先把选点压缩成 10 km 或 25 km 网格，服务器不会收到或保存原始坐标。

## 本地运行

需要 Node.js 18 或更高版本。

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
npm run db:local
npm run dev
```

打开 Wrangler 输出的本地地址。`.dev.vars` 会显式开启本地免验证模式，而且已被 Git 忽略，不会成为生产环境变量；本地仍使用 D1。

## 首次部署

1. 登录 Cloudflare：

   ```powershell
   npx wrangler login
   ```

2. 创建 D1 数据库：

   ```powershell
   npx wrangler d1 create bronymap
   ```

   把命令返回的 `database_id` 填入 `wrangler.jsonc`，替换全零占位符。

3. 在 Cloudflare Turnstile 控制台创建组件，只允许 `bronymap.hachile.org`。把公开的 site key 填入 `wrangler.jsonc` 的 `TURNSTILE_SITE_KEY`。

4. 设置两个生产密钥。`TURNSTILE_SECRET` 使用 Turnstile 提供的 secret key；`JITTER_SECRET` 使用密码管理器生成的至少 32 字符随机字符串：

   ```powershell
   npx wrangler secret put TURNSTILE_SECRET
   npx wrangler secret put JITTER_SECRET
   ```

5. 初始化远程数据库并部署：

   ```powershell
   npm run db:remote
   npm run deploy
   ```

`wrangler.jsonc` 已把 `bronymap.hachile.org` 配置为 Worker Custom Domain。部署时 Cloudflare 会创建相应 DNS 记录；如果已有同名记录，需要先在 Cloudflare 控制台处理冲突。

## 隐私边界

- 不读取浏览器定位权限，用户只能主动点选。
- 后端只接受网格编号，不接受经纬度。
- 同一网格少于 3 人时，接口不返回昵称和联系方式。
- 删除密钥只保存在用户浏览器，服务端仅保存 SHA-256 哈希。
- 标记 90 天后失效，并在下一次地图读取时从数据库物理删除。
- 模糊化不能保证匿名，尤其是在小城市或用户主动留下可识别联系方式时。

## 检查

```powershell
npm run check
```
