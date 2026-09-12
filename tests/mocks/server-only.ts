// Stub for the "server-only" package in tests: vitest runs in a plain Node
// environment, not Next.js's bundler, so the package's real implementation
// (which always throws, relying on Next's "react-server" export condition
// to swap in a no-op for actual server code) would break every import here.
export {};
