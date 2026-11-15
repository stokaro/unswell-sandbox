# What the published CLI wrote for the Markdown sample

These three files are the output of the published Unswell `v0.1.0-alpha.13`
binary for `web/samples/ai-flavored.md`. `test/ai-sounding.mjs` compares the
playground with them, so the page cannot report an index, a mark or a fixed
text that the CLI does not.

The binary is `unswell_0.1.0-alpha.13_darwin_arm64.tar.gz` from the release
page, SHA-256
`35a58a7aacb67c57c3e7fa6795683fd186346b2a2530fb3991d8fcae7884fae7`, as the
release's `SHA256SUMS` lists it.

The sample was copied to an empty directory as `playground.md`, the name the
page analyzes its text under, with no configuration file beside it.

| File | Command |
| --- | --- |
| `ai-flavored.index.txt` | `unswell check --report text:- playground.md`, from the line that starts with `AI-sounding index:` to the line that starts with `The index is the higher` |
| `ai-flavored.fix.txt` | standard output of `unswell fix --write --quiet playground.md` |
| `ai-flavored.fixed.md` | `playground.md` after that command |

Make them again when the sample changes or the pin moves to a release that
changes the index, the report or the fix. A change in the sample alone needs
the same binary; a moved pin needs the binary of the new release.
