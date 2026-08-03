# Third-party notices

## Gemini CLI

Responsive header selection and gradient fallback behavior in `scripts/setup-ui.sh` are adapted from Gemini CLI.

The responsive header composition, 60-column breakpoint, and default dark semantic color model in `src/tui.rs` are copied and ported from Gemini CLI's Ink/React implementation to Ratatui/Rust, then edited for marumado. The icon, four-color palette, wordmark, workflow content, action panels, key bindings, status projection, and persistent screen transition are marumado-specific and are not copied from Gemini CLI.

- `packages/cli/src/ui/components/AppHeader.tsx`
- `packages/cli/src/ui/components/ThemedGradient.tsx`
- `packages/cli/src/ui/components/AsciiArt.ts`
- `packages/cli/src/ui/themes/semantic-tokens.ts`
- `packages/cli/src/ui/themes/theme.ts`

Copyright 2025–2026 Google LLC.
Licensed under the Apache License, Version 2.0.
The repository/Issue/Pull Request metadata and Ratatui rendering are modifications made for this repository.
See `LICENSES/Apache-2.0.txt`.

Pinned source revision: `f47d6c6f7a1308d81f9f57acf7d279f0928c5249`

Source: <https://github.com/google-gemini/gemini-cli/tree/f47d6c6f7a1308d81f9f57acf7d279f0928c5249>

## Charmbracelet Bubbles

The MiniDot, Pulse, Points, and Meter animation frame sets in `scripts/setup-ui.sh` are copied from `spinner/spinner.go`.

Copyright (c) 2020–2026 Charmbracelet, Inc.
Licensed under the MIT License.
The frames are rendered by an ART-TRA Bash adapter instead of the original Bubble Tea component.
See `LICENSES/MIT-Charmbracelet.txt`.

Source: <https://github.com/charmbracelet/bubbles>

## fakesteak

The DROP / TAIL / NONE state model, bright rain head, fading trail, and
column movement used by the Matrix rain animation in `scripts/setup-ui.sh`
are adapted from `src/fakesteak.c`.

fakesteak is dedicated to the public domain under CC0 1.0 Universal.
The original full-screen C implementation was rewritten as a bounded,
responsive Bash animation for this repository.
See `LICENSES/CC0-1.0.txt`.

Source: <https://github.com/domsson/fakesteak>

## TerminalTextEffects

The typed ciphertext phase, rapidly changing encrypted symbols, and gradual
character discovery in the authentication-channel indicator are adapted from
`terminaltexteffects/effects/effect_decrypt.py`.

Copyright (c) 2023 ChrisBuilds.
Licensed under the MIT License.
The effect engine and Python implementation were replaced by a deterministic,
responsive Bash renderer for this repository.
See `LICENSES/MIT-TerminalTextEffects.txt`.

Source: <https://github.com/ChrisBuilds/terminaltexteffects>

## lazygit

The setup dashboard follows lazygit's practice of recalculating layout on
terminal resize and switching between side-by-side and stacked panel layouts.
This adapter also uses the terminal width-to-height ratio instead of width
alone and redraws one alternate-screen frame rather than appending frames.

Copyright (c) 2018 Jesse Duffield.
Licensed under the MIT License.
No Go or gocui runtime is included; the layout behavior is adapted to Bash.
See `LICENSES/MIT-lazygit.txt`.

Source: <https://github.com/jesseduffield/lazygit>

## cli-tracker

The filled / empty block progress meter is ported from `renderBar` in
`cli-tracker/src/services/tui.ts`.

Copyright (c) 2026 Hiroshi.
Licensed under the MIT License.
The original time ratio was replaced with setup progress plus a deliberately
meaningless partial-stage estimate.
See `LICENSES/MIT-cli-tracker.txt`.

Source: <https://github.com/infinith4/dev-time-tracker>

## Framework themed Fastfetch visual reference

The wide MARUMADO header uses the visual composition of an illustration on
the left and grouped system facts on the right, inspired by the community
Fastfetch configuration linked below. The original wallpaper, PNG, Sixel, and
configuration files are not copied or distributed by this repository.

Reference: <https://community.frame.work/t/a-framework-themed-fastfetch/80133>
