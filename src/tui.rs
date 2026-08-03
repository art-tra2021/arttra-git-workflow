//! Full-screen human interface for `git ar`.
//!
//! The icon, responsive header composition, 60-column layout breakpoint,
//! gradient behavior, and semantic colors are copied and ported from Gemini
//! CLI (Apache-2.0, Copyright 2025–2026 Google LLC). The Ink/React renderer is
//! translated to Ratatui/Rust and its content is edited for ART-TRA.
//!
//! Pinned source revision: f47d6c6f7a1308d81f9f57acf7d279f0928c5249
//! - AppHeader.tsx: <https://github.com/google-gemini/gemini-cli/blob/f47d6c6f7a1308d81f9f57acf7d279f0928c5249/packages/cli/src/ui/components/AppHeader.tsx>
//! - ThemedGradient.tsx: <https://github.com/google-gemini/gemini-cli/blob/f47d6c6f7a1308d81f9f57acf7d279f0928c5249/packages/cli/src/ui/components/ThemedGradient.tsx>
//! - theme.ts: <https://github.com/google-gemini/gemini-cli/blob/f47d6c6f7a1308d81f9f57acf7d279f0928c5249/packages/cli/src/ui/themes/theme.ts>
//! - License: `LICENSES/Apache-2.0.txt`

use std::fmt;
use std::io::{self, stdout};
use std::time::Duration;

use anyhow::{Context, Result};
use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use crossterm::execute;
use crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use inquire::Select;
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Alignment, Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Borders, List, ListItem, ListState, Paragraph, Wrap};
use ratatui::{Frame, Terminal};

use crate::status::HomeStatus;

const NARROW_TERMINAL_BREAKPOINT: u16 = 60;
const SPLIT_PANE_BREAKPOINT: u16 = 86;
const MIN_DETAIL_HEIGHT: u16 = 18;
const LOGO_METADATA_PADDING: u16 = 20;

// Copied from Gemini CLI AppHeader.tsx and rendered through Ratatui instead of Ink.
const DEFAULT_ICON: &str = "▝▜▄  \n  ▝▜▄\n ▗▟▀ \n▝▀    ";

// Ported from Gemini CLI's default dark semantic theme.
const PRIMARY: Color = Color::Rgb(255, 255, 255);
const SECONDARY: Color = Color::Rgb(175, 175, 175);
const COMMENT: Color = Color::Rgb(175, 175, 175);
const BORDER: Color = Color::Rgb(135, 135, 135);
const FOCUS_BG: Color = Color::Rgb(0, 95, 0);
const ACCENT_BLUE: Color = Color::Rgb(135, 175, 255);
const ACCENT_PURPLE: Color = Color::Rgb(215, 175, 255);
const ACCENT_CYAN: Color = Color::Rgb(135, 215, 215);
const WARNING: Color = Color::Rgb(255, 255, 175);
const ERROR: Color = Color::Rgb(255, 135, 175);
const SUCCESS: Color = Color::Rgb(215, 255, 215);
const GRADIENT: [(u8, u8, u8); 3] = [(71, 150, 228), (132, 122, 206), (195, 103, 127)];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Status,
    Tasks,
    Issue,
    Branch,
    Commit,
    Push,
    PullRequest,
    Presence,
    Check,
    Rules,
    Doctor,
    Context,
    Exit,
}

impl Action {
    const ALL: [Self; 13] = [
        Self::Status,
        Self::Tasks,
        Self::Issue,
        Self::Branch,
        Self::Commit,
        Self::Push,
        Self::PullRequest,
        Self::Presence,
        Self::Check,
        Self::Rules,
        Self::Doctor,
        Self::Context,
        Self::Exit,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Self::Status => "今やること",
            Self::Tasks => "自分のタスク",
            Self::Issue => "Issueを作る",
            Self::Branch => "branchを作る",
            Self::Commit => "commitを作る",
            Self::Push => "pushする",
            Self::PullRequest => "Pull Requestを作る",
            Self::Presence => "作業の重複を確認",
            Self::Check => "一括チェック",
            Self::Rules => "Rules Insights",
            Self::Doctor => "環境を診断",
            Self::Context => "AI向けコンテキスト",
            Self::Exit => "終了",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            Self::Status => "Issue・Pull Request・作業状態から、次に行うことを確認します。",
            Self::Tasks => "GitHub Projectsから、自分が担当する仕事を一覧表示します。",
            Self::Issue => "相談、通常作業、小タスク、営業活動をGitHubへ登録します。",
            Self::Branch => "Issueに紐づく、命名規則どおりの作業branchを作ります。",
            Self::Commit => "変更の種類と内容を選び、検証済みのcommitを作ります。",
            Self::Push => "送信先とcommit数を確認してからGitHubへpushします。",
            Self::PullRequest => "Issueとの関係を保ったPull Requestを作成します。",
            Self::Presence => "他のbranchが同じファイルを触っていないか確認します。",
            Self::Check => "format、test、lint、securityをまとめて実行します。",
            Self::Rules => "GitHub Rulesetsの適用結果と拒否理由を確認します。",
            Self::Doctor => "mise、hooks、GitHub CLI、AI設定の不足を診断します。",
            Self::Context => "AIが安全に読めるrepository状態をJSONで表示します。",
            Self::Exit => "git arを閉じてterminalへ戻ります。",
        }
    }

    pub fn command(self) -> &'static str {
        match self {
            Self::Status => "git ar status",
            Self::Tasks => "git ar tasks",
            Self::Issue => "git ar issue",
            Self::Branch => "git ar branch",
            Self::Commit => "git ar commit",
            Self::Push => "git ar push",
            Self::PullRequest => "git ar pr",
            Self::Presence => "git ar presence check",
            Self::Check => "git ar check",
            Self::Rules => "git ar rules",
            Self::Doctor => "git ar doctor",
            Self::Context => "git ar context --json",
            Self::Exit => "q",
        }
    }
}

impl fmt::Display for Action {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} — {}", self.label(), self.description())
    }
}

#[derive(Debug)]
struct HomeApp {
    selected: usize,
    list_state: ListState,
}

impl Default for HomeApp {
    fn default() -> Self {
        let mut list_state = ListState::default();
        list_state.select(Some(0));
        Self {
            selected: 0,
            list_state,
        }
    }
}

impl HomeApp {
    fn selected_action(&self) -> Action {
        Action::ALL[self.selected]
    }

    fn move_next(&mut self) {
        self.selected = (self.selected + 1) % Action::ALL.len();
        self.list_state.select(Some(self.selected));
    }

    fn move_previous(&mut self) {
        self.selected = self
            .selected
            .checked_sub(1)
            .unwrap_or(Action::ALL.len() - 1);
        self.list_state.select(Some(self.selected));
    }

    fn move_first(&mut self) {
        self.selected = 0;
        self.list_state.select(Some(self.selected));
    }

    fn move_last(&mut self) {
        self.selected = Action::ALL.len() - 1;
        self.list_state.select(Some(self.selected));
    }
}

struct TerminalRestore;

impl Drop for TerminalRestore {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(stdout(), LeaveAlternateScreen);
    }
}

pub fn run(status: &HomeStatus) -> Result<Option<Action>> {
    if simple_terminal() {
        return run_simple();
    }

    enable_raw_mode().context("terminalをraw modeへ切り替えられませんでした")?;
    let restore = TerminalRestore;
    execute!(stdout(), EnterAlternateScreen)
        .context("terminalの全画面表示を開始できませんでした")?;
    let backend = CrosstermBackend::new(stdout());
    let mut terminal = Terminal::new(backend).context("TUIを初期化できませんでした")?;
    terminal
        .clear()
        .context("TUI画面を初期化できませんでした")?;

    let result = event_loop(&mut terminal, status);
    terminal.show_cursor().ok();
    drop(terminal);
    drop(restore);
    result
}

fn run_simple() -> Result<Option<Action>> {
    let action = Select::new(
        "何をしますか？（↑↓で選択、Enterで決定）",
        Action::ALL.to_vec(),
    )
    .with_help_message("文字を入力すると候補を検索できます。Escで終了します")
    .prompt()?;
    Ok((action != Action::Exit).then_some(action))
}

fn simple_terminal() -> bool {
    std::env::var_os("ARTTRA_SIMPLE_TUI").is_some()
        || std::env::var("TERM").is_ok_and(|term| term == "dumb")
}

fn event_loop(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    status: &HomeStatus,
) -> Result<Option<Action>> {
    let mut app = HomeApp::default();
    loop {
        terminal
            .draw(|frame| render(frame, &mut app, status))
            .context("TUIを描画できませんでした")?;

        if !event::poll(Duration::from_millis(250)).context("キー入力を確認できませんでした")?
        {
            continue;
        }
        let Event::Key(key) = event::read().context("キー入力を読み取れませんでした")?
        else {
            continue;
        };
        if !matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) {
            continue;
        }
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => app.move_previous(),
            KeyCode::Down | KeyCode::Char('j') => app.move_next(),
            KeyCode::Home | KeyCode::Char('g') => app.move_first(),
            KeyCode::End | KeyCode::Char('G') => app.move_last(),
            KeyCode::Enter => {
                let action = app.selected_action();
                return Ok((action != Action::Exit).then_some(action));
            }
            KeyCode::Esc | KeyCode::Char('q') => return Ok(None),
            _ => {}
        }
    }
}

fn render(frame: &mut Frame<'_>, app: &mut HomeApp, status: &HomeStatus) {
    let area = inset(frame.area(), 1, 1);
    if area.width < 24 || area.height < 8 {
        render_too_small(frame, area);
        return;
    }

    let compact = area.width < NARROW_TERMINAL_BREAKPOINT || area.height < MIN_DETAIL_HEIGHT;
    let header_height = if compact { 8 } else { 5 };
    let [header_area, content_area, footer_area] = Layout::vertical([
        Constraint::Length(header_height),
        Constraint::Min(3),
        Constraint::Length(1),
    ])
    .areas(area);

    render_header(frame, header_area, status, compact);
    if area.width >= SPLIT_PANE_BREAKPOINT && area.height >= MIN_DETAIL_HEIGHT {
        render_wide_content(frame, content_area, app, status);
    } else {
        render_narrow_content(frame, content_area, app, status);
    }
    render_footer(frame, footer_area, status, area.width);
}

fn render_header(frame: &mut Frame<'_>, area: Rect, status: &HomeStatus, compact: bool) {
    if compact {
        let [logo_area, metadata_area] =
            Layout::vertical([Constraint::Length(4), Constraint::Length(4)]).areas(area);
        render_logo(frame, logo_area);
        render_metadata(frame, metadata_area, status, true);
        return;
    }

    let logo_width = DEFAULT_ICON
        .lines()
        .map(|line| line.chars().count())
        .max()
        .unwrap_or(0) as u16;
    let [logo_area, metadata_area] = Layout::horizontal([
        Constraint::Length(logo_width + 2),
        Constraint::Min(LOGO_METADATA_PADDING),
    ])
    .areas(area);
    render_logo(frame, logo_area);
    render_metadata(frame, metadata_area, status, false);
}

fn render_logo(frame: &mut Frame<'_>, area: Rect) {
    frame.render_widget(Paragraph::new(themed_gradient(DEFAULT_ICON)), area);
}

fn render_metadata(frame: &mut Frame<'_>, area: Rect, status: &HomeStatus, is_below: bool) {
    let issue = status.issue.as_ref().map_or_else(
        || "Issueなし".into(),
        |issue| format!("Issue #{}  {}", issue.number, safe_text(&issue.title)),
    );
    let title = Line::from(vec![
        Span::styled(
            "ART-TRA Work",
            Style::default().fg(PRIMARY).add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!("  git ar v{}", env!("CARGO_PKG_VERSION")),
            Style::default().fg(SECONDARY),
        ),
    ]);
    let lines = if is_below {
        vec![
            title,
            Line::from(vec![
                Span::styled(safe_text(&status.repository), Style::default().fg(PRIMARY)),
                Span::styled("  /  ", Style::default().fg(COMMENT)),
                Span::styled(safe_text(&status.branch), Style::default().fg(SECONDARY)),
            ]),
            Line::from(vec![
                Span::styled(issue, Style::default().fg(SECONDARY)),
                Span::styled("  ·  ", Style::default().fg(COMMENT)),
                Span::styled(
                    format!("変更 {}件", status.changes.total()),
                    status_style(status),
                ),
            ]),
        ]
    } else {
        vec![
            title,
            Line::default(),
            key_value_line("repository", &status.repository, PRIMARY),
            key_value_line(
                "branch",
                &format!("{} @ {}", status.branch, status.head),
                SECONDARY,
            ),
            key_value_line("work", &issue, SECONDARY),
        ]
    };
    frame.render_widget(Paragraph::new(lines), area);
}

fn render_wide_content(frame: &mut Frame<'_>, area: Rect, app: &mut HomeApp, status: &HomeStatus) {
    let [menu_area, right_area] =
        Layout::horizontal([Constraint::Percentage(38), Constraint::Percentage(62)])
            .spacing(2)
            .areas(area);
    render_menu(frame, menu_area, app);

    let [status_area, detail_area] =
        Layout::vertical([Constraint::Percentage(58), Constraint::Percentage(42)])
            .spacing(1)
            .areas(right_area);
    render_status(frame, status_area, status);
    render_action_detail(frame, detail_area, app.selected_action(), status);
}

fn render_narrow_content(
    frame: &mut Frame<'_>,
    area: Rect,
    app: &mut HomeApp,
    status: &HomeStatus,
) {
    if area.height < 10 {
        render_menu(frame, area, app);
        return;
    }
    let menu_height = (area.height / 2).max(6);
    let [menu_area, detail_area] =
        Layout::vertical([Constraint::Length(menu_height), Constraint::Min(4)])
            .spacing(1)
            .areas(area);
    render_menu(frame, menu_area, app);
    render_action_detail(frame, detail_area, app.selected_action(), status);
}

fn render_menu(frame: &mut Frame<'_>, area: Rect, app: &mut HomeApp) {
    let items = Action::ALL
        .iter()
        .map(|action| {
            ListItem::new(Line::from(Span::styled(
                action.label(),
                Style::default().fg(SECONDARY),
            )))
        })
        .collect::<Vec<_>>();
    let list = List::new(items)
        .block(section_block("ACTIONS"))
        .highlight_symbol("> ")
        .highlight_style(
            Style::default()
                .fg(PRIMARY)
                .bg(FOCUS_BG)
                .add_modifier(Modifier::BOLD),
        );
    frame.render_stateful_widget(list, area, &mut app.list_state);
}

fn render_status(frame: &mut Frame<'_>, area: Rect, status: &HomeStatus) {
    let changes = format!(
        "{}件  staged {} / modified {} / new {}{}",
        status.changes.total(),
        status.changes.staged,
        status.changes.unstaged,
        status.changes.untracked,
        if status.changes.conflicted > 0 {
            format!(" / conflict {}", status.changes.conflicted)
        } else {
            String::new()
        }
    );
    let issue = status.issue.as_ref().map_or_else(
        || "なし".into(),
        |issue| {
            format!(
                "#{} {}  [{}]",
                issue.number,
                safe_text(&issue.title),
                issue.state.to_lowercase()
            )
        },
    );
    let pull_request = status.pull_request.as_ref().map_or_else(
        || "なし".into(),
        |pull_request| {
            format!(
                "#{} {}  {}  checks {}/{}",
                pull_request.number,
                if pull_request.is_draft {
                    "draft"
                } else {
                    "open"
                },
                safe_text(&pull_request.title),
                pull_request.checks_success,
                pull_request.checks_total
            )
        },
    );
    let mut lines = vec![
        key_value_line("ISSUE", &issue, PRIMARY),
        key_value_line("CHANGES", &changes, status_color(status)),
        key_value_line("PULL REQUEST", &pull_request, ACCENT_BLUE),
        key_value_line(
            "SYNC",
            &format!(
                "ahead {} / behind {}",
                status.upstream.ahead, status.upstream.behind
            ),
            SECONDARY,
        ),
    ];
    if let Some(next) = &status.next_action {
        lines.push(Line::default());
        lines.push(key_value_line("NEXT", &next.title, ACCENT_CYAN));
        lines.push(Line::from(Span::styled(
            safe_text(&next.reason),
            Style::default().fg(SECONDARY),
        )));
        if let Some(command) = &next.command {
            lines.push(Line::from(Span::styled(
                format!("$ {}", safe_text(command)),
                Style::default().fg(ACCENT_PURPLE),
            )));
        }
    }
    if !status.warnings.is_empty() {
        lines.push(Line::from(Span::styled(
            format!(
                "WARN  {}件の情報を取得できませんでした",
                status.warnings.len()
            ),
            Style::default().fg(WARNING),
        )));
    }
    frame.render_widget(
        Paragraph::new(lines)
            .block(section_block("CURRENT WORK"))
            .wrap(Wrap { trim: true }),
        area,
    );
}

fn render_action_detail(frame: &mut Frame<'_>, area: Rect, action: Action, status: &HomeStatus) {
    let mut lines = vec![
        Line::from(Span::styled(
            action.label(),
            Style::default().fg(PRIMARY).add_modifier(Modifier::BOLD),
        )),
        Line::default(),
        Line::from(Span::styled(
            action.description(),
            Style::default().fg(SECONDARY),
        )),
        Line::default(),
        Line::from(vec![
            Span::styled("実行  ", Style::default().fg(COMMENT)),
            Span::styled(action.command(), Style::default().fg(ACCENT_PURPLE)),
        ]),
    ];
    if action == Action::Status
        && let Some(next) = &status.next_action
    {
        lines.push(Line::default());
        lines.push(Line::from(vec![
            Span::styled("推奨  ", Style::default().fg(COMMENT)),
            Span::styled(safe_text(&next.title), Style::default().fg(ACCENT_CYAN)),
        ]));
    }
    frame.render_widget(
        Paragraph::new(lines)
            .block(section_block("SELECTED"))
            .wrap(Wrap { trim: true }),
        area,
    );
}

fn render_footer(frame: &mut Frame<'_>, area: Rect, status: &HomeStatus, width: u16) {
    let line = if width >= 82 {
        Line::from(vec![
            Span::styled("↑↓ / j k", Style::default().fg(PRIMARY)),
            Span::styled(" move   ", Style::default().fg(COMMENT)),
            Span::styled("enter", Style::default().fg(PRIMARY)),
            Span::styled(" open   ", Style::default().fg(COMMENT)),
            Span::styled("q", Style::default().fg(PRIMARY)),
            Span::styled(" quit", Style::default().fg(COMMENT)),
            Span::styled("    ", Style::default()),
            Span::styled(safe_text(&status.branch), Style::default().fg(SECONDARY)),
        ])
    } else {
        Line::from(vec![
            Span::styled("j/k", Style::default().fg(PRIMARY)),
            Span::styled(" move  ", Style::default().fg(COMMENT)),
            Span::styled("enter", Style::default().fg(PRIMARY)),
            Span::styled(" open  ", Style::default().fg(COMMENT)),
            Span::styled("q", Style::default().fg(PRIMARY)),
            Span::styled(" quit", Style::default().fg(COMMENT)),
        ])
    };
    frame.render_widget(Paragraph::new(line).alignment(Alignment::Left), area);
}

fn render_too_small(frame: &mut Frame<'_>, area: Rect) {
    frame.render_widget(
        Paragraph::new(Text::from(vec![
            themed_gradient_line("ART-TRA"),
            Line::from(Span::styled(
                "terminalを広げてください",
                Style::default().fg(WARNING),
            )),
            Line::from(Span::styled("q: 終了", Style::default().fg(SECONDARY))),
        ]))
        .alignment(Alignment::Center),
        area,
    );
}

fn section_block(title: &'static str) -> Block<'static> {
    Block::default()
        .borders(Borders::TOP)
        .border_style(Style::default().fg(BORDER))
        .title(Span::styled(
            format!(" {title} "),
            Style::default().fg(COMMENT),
        ))
}

// Port of Gemini CLI ThemedGradient.tsx. The source delegates interpolation to
// ink-gradient; this version performs the same horizontal interpolation for
// Ratatui spans and keeps the accent-color fallback.
fn themed_gradient(value: &str) -> Text<'static> {
    Text::from(value.lines().map(themed_gradient_line).collect::<Vec<_>>())
}

fn themed_gradient_line(value: &str) -> Line<'static> {
    let width = value.chars().count();
    if GRADIENT.len() < 2 {
        return Line::from(Span::styled(
            value.to_owned(),
            Style::default().fg(ACCENT_PURPLE),
        ));
    }
    Line::from(
        value
            .chars()
            .enumerate()
            .map(|(index, character)| {
                Span::styled(
                    character.to_string(),
                    Style::default().fg(gradient_color(index, width)),
                )
            })
            .collect::<Vec<_>>(),
    )
}

fn gradient_color(index: usize, width: usize) -> Color {
    let factor = if width <= 1 {
        0.0
    } else {
        index as f32 / (width - 1) as f32
    };
    let scaled = factor * (GRADIENT.len() - 1) as f32;
    let left = (scaled.floor() as usize).min(GRADIENT.len() - 1);
    let right = (left + 1).min(GRADIENT.len() - 1);
    let local = scaled - left as f32;
    let start = GRADIENT[left];
    let end = GRADIENT[right];
    Color::Rgb(
        interpolate(start.0, end.0, local),
        interpolate(start.1, end.1, local),
        interpolate(start.2, end.2, local),
    )
}

fn interpolate(start: u8, end: u8, factor: f32) -> u8 {
    (start as f32 + (end as f32 - start as f32) * factor).round() as u8
}

fn key_value_line(label: &str, value: &str, color: Color) -> Line<'static> {
    Line::from(vec![
        Span::styled(format!("{label:<14}"), Style::default().fg(COMMENT)),
        Span::styled(safe_text(value), Style::default().fg(color)),
    ])
}

fn status_style(status: &HomeStatus) -> Style {
    Style::default().fg(status_color(status))
}

fn status_color(status: &HomeStatus) -> Color {
    if status.changes.conflicted > 0 {
        ERROR
    } else if status.changes.total() > 0 {
        WARNING
    } else {
        SUCCESS
    }
}

fn safe_text(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn inset(area: Rect, horizontal: u16, vertical: u16) -> Rect {
    if area.width <= horizontal * 2 || area.height <= vertical * 2 {
        return area;
    }
    Rect {
        x: area.x + horizontal,
        y: area.y + vertical,
        width: area.width - horizontal * 2,
        height: area.height - vertical * 2,
    }
}

#[cfg(test)]
mod tests {
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    use ratatui::style::Color;

    use super::{
        Action, DEFAULT_ICON, HomeApp, NARROW_TERMINAL_BREAKPOINT, gradient_color, render,
    };
    use crate::status::{
        HomeAction, HomeChanges, HomeIssue, HomePullRequest, HomeStatus, HomeUpstream,
    };

    fn status() -> HomeStatus {
        HomeStatus {
            repository: "art-tra2021/arttra-git-workflow".into(),
            branch: "feature/71-tui-home-rozwer".into(),
            head: "76b1f81".into(),
            issue: Some(HomeIssue {
                number: 71,
                title: "TUIを刷新する".into(),
                state: "OPEN".into(),
            }),
            pull_request: Some(HomePullRequest {
                number: 72,
                title: "TUIを刷新する".into(),
                is_draft: true,
                checks_success: 3,
                checks_total: 3,
            }),
            changes: HomeChanges {
                staged: 0,
                unstaged: 2,
                untracked: 1,
                conflicted: 0,
            },
            upstream: HomeUpstream {
                ahead: 0,
                behind: 0,
            },
            next_action: Some(HomeAction {
                title: "変更ファイルを確認する".into(),
                reason: "未stageの変更がある".into(),
                command: Some("git status --short".into()),
            }),
            warnings: Vec::new(),
        }
    }

    #[test]
    fn navigation_wraps_in_both_directions() {
        let mut app = HomeApp::default();
        app.move_previous();
        assert_eq!(app.selected_action(), Action::Exit);
        app.move_next();
        assert_eq!(app.selected_action(), Action::Status);
    }

    #[test]
    fn renders_wide_and_narrow_terminals_without_panicking() {
        for (width, height) in [(110, 32), (58, 24), (42, 16), (20, 6)] {
            let backend = TestBackend::new(width, height);
            let mut terminal = Terminal::new(backend).expect("test terminal");
            let mut app = HomeApp::default();
            terminal
                .draw(|frame| render(frame, &mut app, &status()))
                .expect("responsive render");
        }
    }

    #[test]
    fn actions_are_text_only_and_have_noninteractive_commands() {
        for action in Action::ALL {
            assert!(!action.label().is_empty());
            assert!(!action.description().is_empty());
            assert!(!action.command().is_empty());
            assert!(!action.label().chars().any(|character| {
                matches!(
                    character,
                    '🧭' | '📋' | '📝' | '🌿' | '💾' | '🚀' | '🔀' | '👥' | '🛡' | '🩺'
                )
            }));
        }
    }

    #[test]
    fn gemini_header_port_keeps_upstream_breakpoint_icon_and_gradient_stops() {
        assert_eq!(NARROW_TERMINAL_BREAKPOINT, 60);
        assert_eq!(DEFAULT_ICON, "▝▜▄  \n  ▝▜▄\n ▗▟▀ \n▝▀    ");
        assert_eq!(gradient_color(0, 3), Color::Rgb(71, 150, 228));
        assert_eq!(gradient_color(1, 3), Color::Rgb(132, 122, 206));
        assert_eq!(gradient_color(2, 3), Color::Rgb(195, 103, 127));
    }
}
