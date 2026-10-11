export async function register() {
  const p = globalThis.process;
  if (!p?.pid) return;
  const pkg = await import("./package.json");
  console.log(
    `${new Date().toISOString()} [INFO] zllama v${pkg.version} | Node ${p.version} | PID ${p.pid}`
  );
}
