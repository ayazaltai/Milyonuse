// The function a per-request host invokes: Vercel, through the Build Output
// written by scripts/vercel-output.mjs. Deliberately not under api/, where
// Vercel would build it again with its own Node builder.
//
// The API is an ES module package: Vercel's launcher wraps `require` and
// refuses to load an ES module through it, and Nest 12 is one — so nothing
// here may reach Nest by `require`.
//
// NODE_ENV is set here rather than in the project's environment: there it
// would reach the build as well, and pnpm skips devDependencies — the compiler
// among them — when it reads production. Set before the import, which is
// dynamic so that this line runs first.
process.env.NODE_ENV ||= 'production';

const { default: handler } = await import('../dist/serverless.js');

export default handler;
