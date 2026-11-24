# Changelog

## 1.1.0

- Discover installed-plugin MCP definitions through Copilot's passive configuration export; keep JSON fallback and existing JSON approval hashes.
- Add dry-run planning through the existing gateway tool and `plan`/`run --dry-run` commands, with call estimates and explicit limits.
- Reject invalid expression syntax, unavailable reference roots, misspelled/future step references and static argument errors before application calls.
- Merge approval changes under a cross-process lock; reject malformed policy records.
- Keep runtime and plugin versions aligned; cancel superseded CI runs and bound job duration.

## 1.0.0

- Initial bundled Copilot plugin, detailed skill, four-tool gateway and bounded JSON workflow engine.
- Configuration discovery, exact tool grants, stdio/HTTP/SSE, environment proxy support and direct-tool fallback.
- Windows, macOS and Linux validation on Node 22 and 24.
