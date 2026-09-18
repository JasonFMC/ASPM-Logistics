export function SetupPage() {
  return (
    <div className="login-page">
      <div className="login-card">
        <h1>需要配置 Supabase</h1>
        <p className="lede">
          复制 <code>.env.example</code> 为 <code>.env</code>，填入 Sydney 项目的 URL 与 anon
          key，然后在 SQL Editor 运行 <code>supabase/schema.sql</code>。
        </p>
        <ol className="setup-steps">
          <li>打开 supabase.com，创建项目，区域选 <strong>Sydney</strong></li>
          <li>Project Settings → API → 复制 URL 和 anon key</li>
          <li>本地写入 <code>VITE_SUPABASE_URL</code> / <code>VITE_SUPABASE_ANON_KEY</code></li>
          <li>SQL Editor 执行 schema，Authentication 里创建用户</li>
          <li>
            运行 <code>npm run dev</code>
          </li>
        </ol>
      </div>
    </div>
  )
}
