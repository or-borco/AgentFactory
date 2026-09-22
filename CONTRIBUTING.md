# Contributing to AgentFactory

Thanks for your interest in contributing! This document covers the process for contributing to this
project.

## Getting started

1. Fork the repository and clone your fork
2. Follow the setup instructions in [README.md](README.md)
3. Create a branch for your change
4. Make your changes, add tests where appropriate
5. Run `pnpm test` to make sure everything passes
6. Open a pull request

## Development workflow

```bash
pnpm install          # install dependencies
pnpm dev              # start the web app
pnpm dev:worker       # start the worker (needs Docker + Anthropic key)
pnpm lint             # run linting
pnpm typecheck        # run type checking
pnpm test:unit        # run unit tests (no external deps)
pnpm test             # run all tests (needs Postgres + Redis)
```

See [README.md](README.md) for full environment setup including Postgres, Redis, and Docker.

## Pull requests

- Keep PRs focused — one logical change per PR
- Add or update tests for your changes
- Make sure `pnpm lint`, `pnpm typecheck`, and `pnpm test:unit` pass before opening a PR
- Write a clear description of what your change does and why

## Developer Certificate of Origin (DCO)

This project uses the [Developer Certificate of Origin](https://developercertificate.org/) (DCO).
All contributors must sign off on their commits to certify that they have the right to submit the
code under the project's Apache-2.0 license.

Add a `Signed-off-by` line to your commit messages:

```
Signed-off-by: Your Name <your.email@example.com>
```

You can do this automatically with `git commit -s`.

By signing off, you certify the following (from [developercertificate.org](https://developercertificate.org/)):

> Developer Certificate of Origin, Version 1.1
>
> Copyright (C) 2004, 2006 The Linux Foundation and its contributors.
>
> Everyone is permitted to copy and distribute verbatim copies of this license document, but
> changing it is not allowed.
>
> By making a contribution to this project, I certify that:
>
> (a) The contribution was created in whole or in part by me and I have the right to submit it
> under the open source license indicated in the file; or
>
> (b) The contribution is based upon previous work that, to the best of my knowledge, is covered
> under an appropriate open source license and I have the right under that license to submit that
> work with modifications, whether created in whole or in part by me, under the same open source
> license (unless I am permitted to submit under a different license), as indicated in the file; or
>
> (c) The contribution was provided directly to me by some other person who certified (a), (b) or
> (c) and I have not modified it.
>
> (d) I understand and agree that this project and the contribution are public and that a record of
> the contribution (including all personal information I submit with it, including my sign-off) is
> maintained indefinitely and may be redistributed consistent with this project or the open source
> license(s) involved.

## Reporting bugs

Open an issue with a clear description, steps to reproduce, and the expected vs actual behavior.

## Code style

- Follow the existing patterns in the codebase
- The project uses TypeScript, Tailwind CSS, and Next.js App Router
- Run `pnpm lint` to check for style issues

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](LICENSE).
