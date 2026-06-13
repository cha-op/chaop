# Repository Guidelines

- User-facing documentation uses British English at the canonical path, for example `README.md` or `docs/deployment-guide.md`.
- Simplified Chinese documentation lives in a paired file with the same basename and a `.zh-Hans.md` suffix, for example `README.zh-Hans.md`.
- Paired documentation files start with a language switch line in the shape `[ British English | 简体中文 ]`, where the inactive language is a Markdown link. Do not put the language switch in the document title.
- English documentation uses British English spelling and phrasing. Simplified Chinese documentation uses Chinese characters for Chinese readers, not romanisation.
- Keep code, comments, identifiers, command examples, and Markdown code blocks in English unless a command output or quoted source is intentionally in another language.
- Do not commit deployment-instance values to this repository, including Cloudflare account IDs, zone IDs, Access AUDs, personal domains, allowlisted email addresses, API tokens, bootstrap secrets, D1 database UUIDs, connector hostnames, or local workspace paths. Keep them in ignored local files, a password manager, or a private deployment repository/subrepo.
- Project journal entries under `docs/project_journal/` must keep validator-compatible frontmatter. If a Simplified Chinese journal counterpart is added under that directory, give it a distinct `id` with a `-zh-Hans` suffix.
- Treat `docs/project_journal/INDEX.md` as a generated local index. Do not commit it.
