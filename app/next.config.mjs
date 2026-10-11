import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const rawBasePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

// Guard against MSYS/Git-Bash on Windows mangling a leading-slash value into a
// Windows path (e.g. "/zllama" -> "C:/Users/.../zllama"). The colon
// then crashes path-to-regexp v8 inside Next.js with a cryptic
// "Missing parameter name" error. Fail fast with an actionable message instead.
if (rawBasePath && /^[A-Za-z]:[\\/]/.test(rawBasePath)) {
  throw new Error(
    `NEXT_PUBLIC_BASE_PATH looks mangled by your shell into a Windows path: "${rawBasePath}".\n` +
      `This typically happens with Git Bash / MSYS on Windows. Workarounds:\n` +
      `  - prefix the command with MSYS_NO_PATHCONV=1, or\n` +
      `  - pass the value with a double leading slash (e.g. //zllama), or\n` +
      `  - set the variable in a .env file or via cmd.exe / PowerShell.`
  );
}

const basePath = rawBasePath && !rawBasePath.startsWith("/") ? `/${rawBasePath}` : rawBasePath;
const normalizedBasePath = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  basePath: normalizedBasePath || undefined,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "base-uri 'self'",
              "object-src 'none'",
              "frame-ancestors 'none'",
              "form-action 'self'",
              "img-src 'self' data: blob:",
              "font-src 'self' data:",
              "style-src 'self' 'unsafe-inline'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "connect-src 'self'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
