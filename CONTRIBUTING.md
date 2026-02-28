# Contributing to demediator

Thanks for your interest in contributing! This project is in early development and we welcome help.

## Getting started

1. Fork and clone the repo
2. Install dependencies: `pnpm install`
3. Copy `.env.example` to `.env.local` and configure your services (see README)
4. Set up the database: `pnpm db:push`
5. Run the dev server: `pnpm dev`

## Development workflow

- **Branch from `main`** for all changes
- **Run `pnpm build`** before submitting a PR to catch type errors
- Keep PRs focused — one feature or fix per PR

## Code style

- TypeScript strict mode
- Prefer explicit types over `any` (existing `any` casts on OpenAI client are acknowledged tech debt)
- Use `const` by default
- No unused imports or variables

## Areas where help is needed

- **Frontend polish** — the results page and source tree visualization
- **Test coverage** — there are currently no tests
- **Alternative LLM backends** — testing with different models and providers
- **Documentation** — usage guides, architecture docs
- **Prompt engineering** — improving claim extraction and fidelity analysis accuracy

## Reporting issues

Open a GitHub issue with:
- What you expected vs what happened
- Steps to reproduce
- Environment details (Node version, OS, LLM backend)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
