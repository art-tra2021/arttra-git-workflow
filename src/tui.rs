//! Full-screen human interface for `git ar`.
//!
//! The responsive header composition, 60-column layout breakpoint, and
//! semantic color model are copied and ported from Gemini CLI (Apache-2.0,
//! Copyright 2025–2026 Google LLC). The Ink/React renderer is translated to
//! Ratatui/Rust and its content is edited for marumado.
//!
//! Pinned source revision: f47d6c6f7a1308d81f9f57acf7d279f0928c5249
//! - AppHeader.tsx: <https://github.com/google-gemini/gemini-cli/blob/f47d6c6f7a1308d81f9f57acf7d279f0928c5249/packages/cli/src/ui/components/AppHeader.tsx>
//! - theme.ts: <https://github.com/google-gemini/gemini-cli/blob/f47d6c6f7a1308d81f9f57acf7d279f0928c5249/packages/cli/src/ui/themes/theme.ts>
//! - License: `LICENSES/Apache-2.0.txt`

use std::fmt;
use std::io::{self, Write, stdout};
use std::time::Duration;

use anyhow::{Context, Result};
use crossterm::cursor::{Hide, MoveTo, Show};
use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use crossterm::execute;
use crossterm::terminal::{
    Clear, ClearType, EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
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

const LOGO_GRID_SIZE: u16 = 3;
const LOGO_CELL_WIDTH: u16 = 2;
const LOGO_WIDTH: u16 = LOGO_GRID_SIZE * LOGO_CELL_WIDTH;
const LOGO_HEIGHT: u16 = LOGO_GRID_SIZE;
const COMPACT_HEADER_HEIGHT: u16 = LOGO_HEIGHT + 4;

// Sampled from the supplied marumado brand mark.
const BRAND_GREEN: Color = Color::Rgb(144, 227, 166);
const BRAND_YELLOW: Color = Color::Rgb(241, 202, 90);
const BRAND_CORAL: Color = Color::Rgb(255, 146, 137);
const BRAND_BLUE: Color = Color::Rgb(129, 165, 225);

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
        let _ = execute!(stdout(), Show, LeaveAlternateScreen);
    }
}

pub struct Shell {
    terminal: Option<Terminal<CrosstermBackend<io::Stdout>>>,
    _restore: Option<TerminalRestore>,
}

impl Shell {
    pub fn start() -> Result<Self> {
        if simple_terminal() {
            return Ok(Self {
                terminal: None,
                _restore: None,
            });
        }

        enable_raw_mode().context("terminalをraw modeへ切り替えられませんでした")?;
        let restore = TerminalRestore;
        execute!(stdout(), EnterAlternateScreen, Hide)
            .context("terminalの全画面表示を開始できませんでした")?;
        let backend = CrosstermBackend::new(stdout());
        let mut terminal = Terminal::new(backend).context("TUIを初期化できませんでした")?;
        terminal
            .clear()
            .context("TUI画面を初期化できませんでした")?;
        Ok(Self {
            terminal: Some(terminal),
            _restore: Some(restore),
        })
    }

    pub fn is_full_screen(&self) -> bool {
        self.terminal.is_some()
    }

    pub fn select(&mut self, status: &HomeStatus) -> Result<Option<Action>> {
        match &mut self.terminal {
            Some(terminal) => event_loop(terminal, status),
            None => run_simple(),
        }
    }

    pub fn begin_action(&mut self, action: Action, status: &HomeStatus) -> Result<()> {
        let Some(terminal) = &mut self.terminal else {
            return Ok(());
        };
        clear_for_redraw(terminal).context("実行画面を初期化できませんでした")?;
        let mut output_row = 0;
        terminal
            .draw(|frame| output_row = render_action_shell(frame, action, status))
            .context("実行画面を描画できませんでした")?;
        disable_raw_mode().context("terminalの入力モードを切り替えられませんでした")?;
        execute!(stdout(), Show, MoveTo(2, output_row))
            .context("実行画面へ移動できませんでした")?;
        Ok(())
    }

    pub fn finish_action(&mut self, error: Option<&anyhow::Error>) -> Result<bool> {
        if self.terminal.is_none() {
            return Ok(false);
        }
        if let Some(error) = error {
            println!("\nERROR  {error:#}");
        }
        println!("\n────────────────────────");
        println!("Enter  ホームへ戻る    q  git arを終了");
        stdout().flush().context("実行結果を表示できませんでした")?;
        enable_raw_mode().context("terminalをraw modeへ戻せませんでした")?;
        loop {
            let Event::Key(key) = event::read().context("キー入力を読み取れませんでした")?
            else {
                continue;
            };
            if !matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) {
                continue;
            }
            match key.code {
                KeyCode::Enter | KeyCode::Esc => {
                    execute!(stdout(), Hide).context("カーソルを隠せませんでした")?;
                    clear_for_redraw(self.terminal.as_mut().expect("全画面terminalが存在する"))
                        .context("ホーム画面へ戻れませんでした")?;
                    return Ok(true);
                }
                KeyCode::Char('q') => return Ok(false),
                _ => {}
            }
        }
    }
}

fn clear_for_redraw(terminal: &mut Terminal<CrosstermBackend<io::Stdout>>) -> io::Result<()> {
    execute!(stdout(), Clear(ClearType::All), MoveTo(0, 0))?;
    // Command output bypasses Ratatui, so invalidate both diff buffers and
    // preserve the active-buffer index. The next frame then repaints all cells.
    terminal.current_buffer_mut().reset();
    terminal.swap_buffers();
    terminal.swap_buffers();
    Ok(())
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
    let header_height = if compact { COMPACT_HEADER_HEIGHT } else { 5 };
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

fn render_action_shell(frame: &mut Frame<'_>, action: Action, status: &HomeStatus) -> u16 {
    let frame_area = frame.area();
    let area = inset(frame_area, 1, 1);
    if area.width < 24 || area.height < 15 {
        render_too_small(frame, area);
        return frame_area.bottom().saturating_sub(1);
    }

    let compact = area.width < NARROW_TERMINAL_BREAKPOINT || area.height < MIN_DETAIL_HEIGHT;
    let header_height = if compact { COMPACT_HEADER_HEIGHT } else { 5 };
    let [header_area, workflow_area, _output_area] = Layout::vertical([
        Constraint::Length(header_height),
        Constraint::Length(5),
        Constraint::Min(1),
    ])
    .areas(area);
    render_header(frame, header_area, status, compact);
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(Span::styled(
                action.label(),
                Style::default().fg(PRIMARY).add_modifier(Modifier::BOLD),
            )),
            Line::from(Span::styled(
                action.description(),
                Style::default().fg(SECONDARY),
            )),
            Line::from(vec![
                Span::styled("実行  ", Style::default().fg(COMMENT)),
                Span::styled(action.command(), Style::default().fg(ACCENT_PURPLE)),
            ]),
        ])
        .block(section_block("WORKFLOW"))
        .wrap(Wrap { trim: true }),
        workflow_area,
    );
    workflow_area
        .bottom()
        .saturating_add(1)
        .min(frame_area.bottom().saturating_sub(1))
}

fn render_header(frame: &mut Frame<'_>, area: Rect, status: &HomeStatus, compact: bool) {
    if compact {
        let [logo_area, metadata_area] =
            Layout::vertical([Constraint::Length(LOGO_HEIGHT), Constraint::Length(4)]).areas(area);
        render_logo(frame, logo_area);
        render_metadata(frame, metadata_area, status, true);
        return;
    }

    let [logo_area, metadata_area] = Layout::horizontal([
        Constraint::Length(LOGO_WIDTH + 2),
        Constraint::Min(LOGO_METADATA_PADDING),
    ])
    .areas(area);
    render_logo(frame, logo_area);
    render_metadata(frame, metadata_area, status, false);
}

fn render_logo(frame: &mut Frame<'_>, area: Rect) {
    frame.render_widget(Paragraph::new(marumado_logo()), area);
}

fn render_metadata(frame: &mut Frame<'_>, area: Rect, status: &HomeStatus, is_below: bool) {
    let issue = status.issue.as_ref().map_or_else(
        || "Issueなし".into(),
        |issue| format!("Issue #{}  {}", issue.number, safe_text(&issue.title)),
    );
    let japanese_title = Line::from(vec![
        Span::styled(
            "まるまど",
            Style::default().fg(PRIMARY).add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!("  marumado / git ar v{}", env!("CARGO_PKG_VERSION")),
            Style::default().fg(SECONDARY),
        ),
    ]);
    let lines = if is_below {
        vec![
            japanese_title,
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
            japanese_title,
            Line::from(Span::styled(
                "marumado",
                Style::default().fg(SECONDARY).add_modifier(Modifier::BOLD),
            )),
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
            Line::from(Span::styled(
                "marumado / git ar",
                Style::default().fg(PRIMARY).add_modifier(Modifier::BOLD),
            )),
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

fn marumado_logo() -> Text<'static> {
    Text::from(
        (0..LOGO_HEIGHT as usize)
            .map(|row| {
                Line::from(
                    (0..LOGO_WIDTH as usize)
                        .map(|column| {
                            logo_color(row, column).map_or_else(
                                || Span::raw(" "),
                                |color| Span::styled("█", Style::default().fg(color)),
                            )
                        })
                        .collect::<Vec<_>>(),
                )
            })
            .collect::<Vec<_>>(),
    )
}

fn logo_color(row: usize, column: usize) -> Option<Color> {
    match (row, column) {
        (0, 0..=3) => Some(BRAND_GREEN),
        (0..=1, 4..=5) => Some(BRAND_YELLOW),
        (1..=2, 0..=1) => Some(BRAND_CORAL),
        (2, 2..=5) => Some(BRAND_BLUE),
        _ => None,
    }
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
        Action, BRAND_BLUE, BRAND_CORAL, BRAND_GREEN, BRAND_YELLOW, HomeApp, LOGO_HEIGHT,
        LOGO_WIDTH, NARROW_TERMINAL_BREAKPOINT, logo_color, render, render_action_shell,
        render_logo,
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
    fn renders_action_shell_without_leaving_the_full_screen_layout() {
        for (width, height) in [(110, 32), (58, 24), (42, 18)] {
            let backend = TestBackend::new(width, height);
            let mut terminal = Terminal::new(backend).expect("test terminal");
            let mut output_row = 0;
            terminal
                .draw(|frame| {
                    output_row = render_action_shell(frame, Action::Commit, &status());
                })
                .expect("action shell render");
            assert!(output_row < height);
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
    fn header_keeps_gemini_breakpoint_and_uses_sampled_marumado_brand_colors() {
        assert_eq!(NARROW_TERMINAL_BREAKPOINT, 60);
        assert_eq!((LOGO_WIDTH, LOGO_HEIGHT), (6, 3));
        assert_eq!(BRAND_GREEN, Color::Rgb(144, 227, 166));
        assert_eq!(BRAND_YELLOW, Color::Rgb(241, 202, 90));
        assert_eq!(BRAND_CORAL, Color::Rgb(255, 146, 137));
        assert_eq!(BRAND_BLUE, Color::Rgb(129, 165, 225));
        assert_eq!(logo_color(0, 3), Some(BRAND_GREEN));
        assert_eq!(logo_color(1, 5), Some(BRAND_YELLOW));
        assert_eq!(logo_color(2, 1), Some(BRAND_CORAL));
        assert_eq!(logo_color(2, 5), Some(BRAND_BLUE));
        assert_eq!(logo_color(1, 2), None);
        assert_eq!(logo_color(1, 3), None);
        assert_eq!(
            (0..LOGO_HEIGHT as usize)
                .flat_map(|row| (0..LOGO_WIDTH as usize).map(move |column| (row, column)))
                .filter(|&(row, column)| logo_color(row, column).is_some())
                .count(),
            16
        );
    }

    #[test]
    fn logo_is_four_rectangles_without_circle_or_outline_glyphs() {
        let backend = TestBackend::new(LOGO_WIDTH, LOGO_HEIGHT);
        let mut terminal = Terminal::new(backend).expect("test terminal");
        terminal
            .draw(|frame| render_logo(frame, frame.area()))
            .expect("logo render");
        let buffer = terminal.backend().buffer();
        let expected = ["██████", "██  ██", "██████"];
        for (row, line) in expected.iter().enumerate() {
            for (column, symbol) in line.chars().enumerate() {
                let cell = buffer.cell((column as u16, row as u16)).expect("logo cell");
                assert_eq!(cell.symbol(), symbol.to_string());
                assert_eq!(cell.fg, logo_color(row, column).unwrap_or(Color::Reset));
            }
        }
    }
}
